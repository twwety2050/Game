// A ship: a free-moving voxel grid with its own position, rotation, and velocity.
//
// Local block coordinates map to world space as  world = position + R * (local - com),
// where `com` is the local centre of mass, so the ship rotates about its centre of mass.
// Blocks can be added and removed at any time, including while the ship is moving.
//
// Ships are rigid bodies: each block's mass is its density times its shape's volume, and the
// inertia tensor comes from the block layout. In water, every block is pushed up by the water
// it displaces (density 1), so ships lighter than water float and right themselves. Gravity pulls on the centre of mass, and an uneven field (near gravity
// blocks) also twists the ship. Contacts with the world and other ships are found by
// probing the hull's corners and exposed face centres, then resolved with impulses at the
// contact points (with friction and a little bounce), which is what makes ships tip, roll,
// and tumble. Ships at rest go to sleep until something disturbs them.
import * as THREE from 'three';
import { VoxelGrid, SOLID, CS, idx } from './grid.js';
import { B, BLOCKS } from './blocks.js';
import { applyRotation } from './shapes.js';
import { gravityAt, G } from './gravity.js';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _r = new THREE.Vector3();
const _j = new THREE.Vector3();
const _t = new THREE.Vector3();
const _vr = new THREE.Vector3();
const _gs = [];
const _shares = new Map();
const GRAVITY_SAMPLES = 32;  // exposed blocks sampled when measuring the gravity on a ship
const MAX_SPEED = 60;
const MAX_SPIN = 6;          // radians per second
const RESTITUTION = 0.15;
const FRICTION = 0.6;
const SOLVER_ITERATIONS = 6;
const PENETRATION_SLOP = 0.01;
const SLEEP_SPEED = 0.12;    // below this (and spin), a supported ship starts to settle
const SLEEP_TIME = 0.5;
const WATER_DRAG = 4;        // velocity damping per second when fully submerged
export const THRUST = 400;   // force of one thruster (mass x blocks/s^2)
export const CONTROL_KEYS = ['Q', 'W', 'E', 'A', 'S', 'D'];

// Flame shown at a firing thruster's nozzle: a cone pointing out along +Y, glowing additively.
const FLAME_GEOMETRY = new THREE.ConeGeometry(0.22, 1.1, 10, 1, true).translate(0, 0.55, 0);
const FLAME_MATERIAL = new THREE.MeshBasicMaterial({
  color: 0xff7a1a, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide, fog: false,
});
const FLAME_CORE = new THREE.MeshBasicMaterial({
  color: 0xfff2c0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
});
const _up = new THREE.Vector3(0, 1, 0);
const WATER_SURFACE = 0.88;  // height of the water surface within the top water block
const PROBE_INSET = 0.02;
const MIN_SUPPORT = 3;       // contacts needed to sleep (fewer = balanced on an edge or corner)
const WOBBLE = 0.02;         // tiny random spin on a ship balanced on an edge or corner

// Corners of a block, inset slightly so grids resting face-to-face don't count as overlapping.
const INSET = 0.05;
const CORNERS = [];
for (const x of [INSET, 1 - INSET]) for (const y of [INSET, 1 - INSET]) for (const z of [INSET, 1 - INSET]) CORNERS.push([x, y, z]);

export class Ship extends VoxelGrid {
  constructor(scene, materials) {
    const group = new THREE.Group();
    scene.add(group);
    super(group, materials);
    this.scene = scene;
    this.group = group;
    this.createChunks = true;

    this.position = new THREE.Vector3();        // world position of the centre of mass
    this.velocity = new THREE.Vector3();        // world space, blocks per second
    this.angularVelocity = new THREE.Vector3(); // world space, radians per second
    this.invQuaternion = new THREE.Quaternion();

    this.blockCount = 0;                 // number of solid blocks
    this.mass = 0;
    this.blockSum = new THREE.Vector3(); // mass-weighted sum of solid block centres
    this.buoyancy = 0;                   // fraction of the ship's volume under water (for display)
    this.com = new THREE.Vector3();
    this.min = new THREE.Vector3();      // local bounds of solid blocks (inclusive block coords)
    this.max = new THREE.Vector3();
    this.radius = 0;                     // bounding sphere radius around the centre of mass
    this.surface = [];                   // local coords of blocks exposed to the outside
    this.shapeDirty = true;
    this.gravity = new THREE.Vector3();  // average pull on the ship, world space, strength 0..1
    this.gravityTorque = new THREE.Vector3(); // twist from an uneven gravity field, world space
    this.pullers = new Map();            // ship -> share of our gravity its generators supply
    this.piloted = false;                // someone is at the helm (keeps the ship awake)
    this.thrusters = new Map();          // "x,y,z" -> { x, y, z, nozzle: [dx, dy, dz] } (local)
    this.firing = new Set();             // keys of thrusters firing this frame
    this.consoles = new Map();           // console "x,y,z" -> { Q: [thruster keys], W, E, A, S, D }
    this.flames = new Map();             // thruster key -> flame mesh

    this.invInertiaLocal = new THREE.Matrix3(); // inverse inertia tensor about the centre of mass
    this.probes = [];                    // local points tested for contacts (flat x, y, z)
    this.contacts = [];
    this.sleeping = false;
    this.restTime = 0;
    this.sleepCheck = 0;
    this.sleepGravity = new THREE.Vector3();
  }

  // ---------- transform ----------

  localToWorld(v, out = new THREE.Vector3()) {
    return out.copy(v).sub(this.com).applyQuaternion(this.quaternion).add(this.position);
  }

  worldToLocal(v, out = new THREE.Vector3()) {
    return out.copy(v).sub(this.position).applyQuaternion(this.invQuaternion).add(this.com);
  }

  dirToWorld(v, out = new THREE.Vector3()) { return out.copy(v).applyQuaternion(this.quaternion); }
  dirToLocal(v, out = new THREE.Vector3()) { return out.copy(v).applyQuaternion(this.invQuaternion); }

  velocityAt(worldPoint, out = new THREE.Vector3()) {
    _v.subVectors(worldPoint, this.position);
    return out.crossVectors(this.angularVelocity, _v).add(this.velocity);
  }

  syncTransform() {
    this.quaternion.normalize();
    this.invQuaternion.copy(this.quaternion).invert();
    this.group.quaternion.copy(this.quaternion);
    this.group.position.copy(this.position).sub(_v.copy(this.com).applyQuaternion(this.quaternion));
  }

  // ---------- shape ----------

  onBlockChanged(x, y, z, old, id) {
    const oldMass = SOLID[old] ? BLOCKS[old].mass : 0, newMass = SOLID[id] ? BLOCKS[id].mass : 0;
    this.blockCount += SOLID[id] - SOLID[old];
    if (oldMass === newMass) { this.shapeDirty = true; this.wake(); return; }
    const dm = newMass - oldMass;
    this.mass += dm;
    this.blockSum.x += dm * (x + 0.5);
    this.blockSum.y += dm * (y + 0.5);
    this.blockSum.z += dm * (z + 0.5);

    // Move the centre of mass without moving the ship: shift `position` to compensate.
    if (this.blockCount > 0 && this.mass > 0) {
      const newCom = _w.copy(this.blockSum).divideScalar(this.mass);
      this.position.add(_v.subVectors(newCom, this.com).applyQuaternion(this.quaternion));
      this.com.copy(newCom);
    }
    this.shapeDirty = true;
    this.wake();
    this.syncTransform();
  }

  // Recompute bounds, bounding radius, inertia, the list of exposed blocks, and the contact
  // probe points.
  updateShape() {
    if (!this.shapeDirty) return;
    this.shapeDirty = false;
    this.surface = [];
    this.probes = [];
    this.blocks = [];                    // every solid block: x, y, z, id (flat)
    this.thrusters.clear();
    const seen = new Set();
    const probe = (x, y, z) => {
      const key = x + ',' + y + ',' + z;
      if (!seen.has(key)) { seen.add(key); this.probes.push(x, y, z); }
    };
    const inertia = [0, 0, 0, 0, 0, 0]; // xx, yy, zz, xy, xz, yz
    this.min.set(Infinity, Infinity, Infinity);
    this.max.set(-Infinity, -Infinity, -Infinity);
    for (const c of this.chunks.values()) {
      if (!c.data) continue;
      const ox = c.cx * CS, oy = c.cy * CS, oz = c.cz * CS;
      for (let i = 0; i < c.data.length; i++) {
        if (!SOLID[c.data[i]]) continue;
        const x = ox + (i % CS), z = oz + (Math.floor(i / CS) % CS), y = oy + Math.floor(i / (CS * CS));
        this.min.min(_v.set(x, y, z));
        this.max.max(_v);
        this.blocks.push(x, y, z, c.data[i]);
        if (BLOCKS[c.data[i]].thruster) {
          const meta = c.meta ? c.meta[i] : 0;
          this.thrusters.set(x + ',' + y + ',' + z, { x, y, z, nozzle: applyRotation(meta, [0, 1, 0]) });
        }
        // Each block is a point mass at its centre plus a uniform cube's own inertia (m/6).
        const m = BLOCKS[c.data[i]].mass;
        const rx = x + 0.5 - this.com.x, ry = y + 0.5 - this.com.y, rz = z + 0.5 - this.com.z;
        inertia[0] += m * (ry * ry + rz * rz + 1 / 6);
        inertia[1] += m * (rx * rx + rz * rz + 1 / 6);
        inertia[2] += m * (rx * rx + ry * ry + 1 / 6);
        inertia[3] -= m * rx * ry;
        inertia[4] -= m * rx * rz;
        inertia[5] -= m * ry * rz;
        const open = [!this.isSolid(x - 0.5, y + 0.5, z + 0.5), !this.isSolid(x + 1.5, y + 0.5, z + 0.5),
          !this.isSolid(x + 0.5, y - 0.5, z + 0.5), !this.isSolid(x + 0.5, y + 1.5, z + 0.5),
          !this.isSolid(x + 0.5, y + 0.5, z - 0.5), !this.isSolid(x + 0.5, y + 0.5, z + 1.5)];
        if (!open.some(Boolean)) continue;
        this.surface.push(x, y, z);
        // Corners are inset a hair toward the block's centre, so a corner sitting exactly on an
        // obstacle's edge still counts as resting on it.
        const lo = PROBE_INSET, hi = 1 - PROBE_INSET;
        for (let k = 0; k < 8; k++) probe(x + (k & 1 ? hi : lo), y + (k & 2 ? hi : lo), z + (k & 4 ? hi : lo));
        if (open[0]) probe(x, y + 0.5, z + 0.5);
        if (open[1]) probe(x + 1, y + 0.5, z + 0.5);
        if (open[2]) probe(x + 0.5, y, z + 0.5);
        if (open[3]) probe(x + 0.5, y + 1, z + 0.5);
        if (open[4]) probe(x + 0.5, y + 0.5, z);
        if (open[5]) probe(x + 0.5, y + 0.5, z + 1);
      }
    }
    const [ixx, iyy, izz, ixy, ixz, iyz] = inertia;
    this.invInertiaLocal.set(ixx, ixy, ixz, ixy, iyy, iyz, ixz, iyz, izz);
    if (this.blockCount > 0) this.invInertiaLocal.invert();
    let r = 0;
    for (const cx of [this.min.x, this.max.x + 1]) for (const cy of [this.min.y, this.max.y + 1]) for (const cz of [this.min.z, this.max.z + 1]) {
      r = Math.max(r, _v.set(cx, cy, cz).distanceTo(this.com));
    }
    this.radius = r;
  }

  // Is a local point within the ship's bounding box, grown by `margin` blocks?
  containsLocal(p, margin = 0) {
    this.updateShape();
    return p.x >= this.min.x - margin && p.x <= this.max.x + 1 + margin &&
      p.y >= this.min.y - margin && p.y <= this.max.y + 1 + margin &&
      p.z >= this.min.z - margin && p.z <= this.max.z + 1 + margin;
  }

  solidAtWorld(p) {
    this.worldToLocal(p, _w);
    return this.isSolid(_w.x, _w.y, _w.z);
  }

  // Does any exposed block of this ship overlap the world or another ship?
  intersectsAnything(world, ships) {
    this.updateShape();
    const others = ships.filter((s) => s !== this && s.blockCount > 0 &&
      (s.updateShape(), s.position.distanceTo(this.position) < s.radius + this.radius));
    const surf = this.surface;
    for (let i = 0; i < surf.length; i += 3) {
      for (const [cx, cy, cz] of CORNERS) {
        this.localToWorld(_v.set(surf[i] + cx, surf[i + 1] + cy, surf[i + 2] + cz), _w);
        if (world.isSolid(_w.x, _w.y, _w.z)) return true;
        for (const s of others) if (s.solidAtWorld(_w)) return true;
      }
    }
    return false;
  }

  // ---------- motion ----------

  wake() {
    this.sleeping = false;
    this.restTime = 0;
  }

  // Average gravity over the ship (its centre of mass plus a spread of exposed blocks, so a
  // large ship feels a gravity plate its hull is near), and the twist from any unevenness.
  measureGravity(world, ships) {
    this.updateShape();
    const surf = this.surface, count = surf.length / 3;
    const stride = Math.max(1, Math.floor(count / GRAVITY_SAMPLES));
    _gs.length = 0;
    this.pullers.clear();
    const sample = (p) => {
      _gs.push([p, gravityAt(p, world, ships, new THREE.Vector3(), this, _shares)]);
      for (const [ship, share] of _shares) this.pullers.set(ship, (this.pullers.get(ship) ?? 0) + share);
    };
    sample(this.position.clone());
    for (let i = 0; i < count; i += stride) {
      sample(this.localToWorld(_v.set(surf[i * 3] + 0.5, surf[i * 3 + 1] + 0.5, surf[i * 3 + 2] + 0.5), new THREE.Vector3()));
    }
    for (const [ship, share] of this.pullers) this.pullers.set(ship, share / _gs.length);
    this.gravity.set(0, 0, 0);
    for (const [, g] of _gs) this.gravity.add(g);
    this.gravity.divideScalar(_gs.length);
    // Torque from the part of the pull that differs across the ship; a uniform pull has none.
    this.gravityTorque.set(0, 0, 0);
    const massPerSample = this.mass / _gs.length;
    for (const [p, g] of _gs) {
      _r.subVectors(p, this.position);
      _j.subVectors(g, this.gravity).multiplyScalar(G * massPerSample);
      this.gravityTorque.add(_v.crossVectors(_r, _j));
    }
    return this.gravity;
  }

  // Apply the inverse world-space inertia tensor to a world vector.
  applyInvInertia(v, out) {
    return this.dirToWorld(this.dirToLocal(v, out).applyMatrix3(this.invInertiaLocal), out);
  }

  // Apply impulse J (world) at world point p.
  applyImpulse(J, p) {
    this.velocity.addScaledVector(J, 1 / this.mass);
    _r.subVectors(p, this.position);
    this.angularVelocity.add(this.applyInvInertia(_t.crossVectors(_r, J), _t));
  }

  // How hard it is to change this ship's velocity at point p along direction n.
  effectiveInvMass(p, n) {
    _r.subVectors(p, this.position);
    const rn = this.applyInvInertia(_t.crossVectors(_r, n), _t);
    return 1 / this.mass + n.dot(_v.crossVectors(rn, _r));
  }

  // How much fluid a unit block centred at world point p displaces, weighted by the fluid's
  // density (water 1, lava 3). "Up" is world axis `axis` in direction `sign` (+1 or -1), so
  // this works on any face of a planet.
  submergedFraction(world, p, axis, sign) {
    const c = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];
    const along = p.getComponent(axis);
    const bottom = along - 0.5, top = along + 0.5;
    let wet = 0;
    for (let k = Math.floor(bottom); k <= Math.floor(top); k++) {
      c[axis] = k;
      const id = world.getBlock(c[0], c[1], c[2]);
      if (!BLOCKS[id].liquid) continue;
      // The fluid fills its block from the "down" side up to its surface height.
      c[axis] = k + sign;
      const covered = world.getBlock(c[0], c[1], c[2]) === id;
      c[axis] = k;
      const meta = world.getMeta(c[0], c[1], c[2]);
      const level = meta & 7;
      const height = covered || meta & 8 ? 1 : level === 0 ? WATER_SURFACE : Math.max(0.15, (8 - level) / 9);
      const lo = sign > 0 ? k : k + 1 - height, hi = sign > 0 ? k + height : k + 1;
      wet += Math.max(0, Math.min(top, hi) - Math.max(bottom, lo)) * BLOCKS[id].density;
    }
    return wet;
  }

  // Buoyancy (Archimedes): each block is pushed against gravity by the weight of the water
  // it displaces, at its own position, so a tilted ship is also turned back upright. Also
  // returns the drag factor from how much of the ship is wet.
  measureBuoyancy(world) {
    this.buoyancyForce = this.buoyancyForce ?? new THREE.Vector3();
    this.buoyancyTorque = this.buoyancyTorque ?? new THREE.Vector3();
    this.buoyancyForce.set(0, 0, 0);
    this.buoyancyTorque.set(0, 0, 0);
    this.buoyancy = 0;
    if (this.gravity.lengthSq() < 1e-8) return;
    const blocks = this.blocks;
    // "Up" is the axis most opposed to gravity (fluids lie flat across it).
    const g = this.gravity, agx = Math.abs(g.x), agy = Math.abs(g.y), agz = Math.abs(g.z);
    const axis = agx >= agy && agx >= agz ? 0 : agy >= agz ? 1 : 2;
    const sign = -Math.sign(g.getComponent(axis));
    let wetVolume = 0, volume = 0;
    for (let i = 0; i < blocks.length; i += 4) {
      const v = BLOCKS[blocks[i + 3]].mass / BLOCKS[blocks[i + 3]].density;
      volume += v;
      const p = this.localToWorld(_v.set(blocks[i] + 0.5, blocks[i + 1] + 0.5, blocks[i + 2] + 0.5), _w);
      const wet = this.submergedFraction(world, p, axis, sign);
      if (wet === 0) continue;
      wetVolume += wet * v;
      _j.copy(this.gravity).multiplyScalar(-G * wet * v); // `wet` already includes fluid density
      this.buoyancyForce.add(_j);
      _r.subVectors(p, this.position);
      this.buoyancyTorque.add(_t.crossVectors(_r, _j));
    }
    this.buoyancy = volume > 0 ? wetVolume / volume : 0;
  }

  // Every probe point that is inside the world or another ship, with the way out.
  findContacts(world, ships) {
    const contacts = this.contacts;
    contacts.length = 0;
    const others = ships.filter((s) => s !== this && s.blockCount > 0 &&
      (s.updateShape(), s.position.distanceTo(this.position) < s.radius + this.radius + 1));
    const probes = this.probes;
    for (let i = 0; i < probes.length; i += 3) {
      const p = this.localToWorld(_w.set(probes[i], probes[i + 1], probes[i + 2]), new THREE.Vector3());
      const c = world.contactAt(p);
      if (c) contacts.push({ p, n: new THREE.Vector3(c.nx, c.ny, c.nz), depth: c.depth, other: null });
      for (const s of others) {
        const oc = s.contactAt(s.worldToLocal(p, _v));
        if (oc) contacts.push({ p, n: s.dirToWorld(_v.set(oc.nx, oc.ny, oc.nz), new THREE.Vector3()), depth: oc.depth, other: s });
      }
    }
    return contacts;
  }

  // Sequential impulses: stop each contact point moving into its obstacle (bouncing a little
  // if it hit hard), with Coulomb friction. Returns the hardest impact speed.
  resolveContacts(contacts) {
    let impact = 0;
    for (const c of contacts) {
      _vr.copy(this.velocityAt(c.p, _vr));
      if (c.other) _vr.sub(c.other.velocityAt(c.p, _v));
      const vn = _vr.dot(c.n);
      impact = Math.max(impact, -vn);
      c.target = vn < -1 ? -RESTITUTION * vn : 0;
      c.jn = 0;
      c.k = this.effectiveInvMass(c.p, c.n) + (c.other ? c.other.effectiveInvMass(c.p, c.n) : 0);
      if (c.other) c.other.wake();
    }
    for (let iter = 0; iter < SOLVER_ITERATIONS; iter++) {
      for (const c of contacts) {
        this.velocityAt(c.p, _vr);
        if (c.other) _vr.sub(c.other.velocityAt(c.p, _v));
        // Normal impulse, accumulated and kept non-negative (contacts push, never pull).
        const vn = _vr.dot(c.n);
        const jn = Math.max(c.jn + (c.target - vn) / c.k, 0);
        const dj = jn - c.jn;
        c.jn = jn;
        if (dj !== 0) {
          _j.copy(c.n).multiplyScalar(dj);
          this.applyImpulse(_j, c.p);
          if (c.other) c.other.applyImpulse(_j.negate(), c.p);
        }
        // Friction against the sliding direction, limited by the normal impulse.
        this.velocityAt(c.p, _vr);
        if (c.other) _vr.sub(c.other.velocityAt(c.p, _v));
        _vr.addScaledVector(c.n, -_vr.dot(c.n));
        const slide = _vr.length();
        if (slide < 1e-6) continue;
        const t = _vr.divideScalar(slide);
        const kt = this.effectiveInvMass(c.p, t) + (c.other ? c.other.effectiveInvMass(c.p, t) : 0);
        const jt = Math.min(slide / kt, FRICTION * c.jn);
        _j.copy(t).multiplyScalar(-jt);
        this.applyImpulse(_j, c.p);
        if (c.other) c.other.applyImpulse(_j.negate(), c.p);
      }
    }
    // Push out of any remaining overlap (shared with the other ship, if any).
    _j.set(0, 0, 0);
    for (const c of contacts) _j.addScaledVector(c.n, Math.max(c.depth - PENETRATION_SLOP, 0));
    if (contacts.length) {
      _j.multiplyScalar(0.8 / contacts.length);
      this.position.add(_j);
    }
    return impact;
  }

  // Advance the ship. Returns the impact speed if it hit something this step, else 0.
  update(dt, world, ships) {
    if (this.blockCount === 0) return 0;
    this.updateShape();
    if (this.piloted) this.wake();

    if (this.sleeping) {
      // Every so often, check whether whatever we're resting on is still there and whether the
      // gravity has changed.
      this.sleepCheck -= dt;
      if (this.sleepCheck > 0) return 0;
      this.sleepCheck = 0.25;
      this.measureGravity(world, ships);
      const supported = this.findContacts(world, ships).length > 0;
      if (supported && this.gravity.distanceTo(this.sleepGravity) < 0.02) return 0;
      this.wake();
    }

    this.measureGravity(world, ships);
    const pulled = this.gravity.lengthSq() > 1e-6;
    const thrusting = this.firing.size > 0;
    if (thrusting) this.wake();
    if (!pulled && !thrusting && this.velocity.lengthSq() < 1e-8 && this.angularVelocity.lengthSq() < 1e-8) return 0;
    if (pulled) this.measureBuoyancy(world);
    else this.buoyancy = 0;

    const travel = (this.velocity.length() + this.angularVelocity.length() * this.radius) * dt;
    const steps = Math.min(12, Math.max(Math.ceil(dt * 120), Math.ceil(travel / 0.3), 1));
    const sdt = dt / steps;
    let impact = 0, support = 0;
    for (let i = 0; i < steps; i++) {
      if (pulled) {
        this.velocity.addScaledVector(this.gravity, G * sdt);
        this.angularVelocity.add(this.applyInvInertia(_v.copy(this.gravityTorque).multiplyScalar(sdt), _v));
        if (this.buoyancy > 0) {
          this.velocity.addScaledVector(this.buoyancyForce, sdt / this.mass);
          this.angularVelocity.add(this.applyInvInertia(_v.copy(this.buoyancyTorque).multiplyScalar(sdt), _v));
          const drag = Math.exp(-WATER_DRAG * this.buoyancy * sdt);
          this.velocity.multiplyScalar(drag);
          this.angularVelocity.multiplyScalar(drag);
        }
        // Equal and opposite: ships whose generators pull us are pulled back toward us.
        for (const [ship, share] of this.pullers) {
          if (share <= 0) continue;
          ship.velocity.addScaledVector(this.gravity, -G * sdt * share * this.mass / ship.mass);
          ship.wake();
        }
      }
      // Each firing thruster pushes away from its nozzle, at its own position.
      for (const key of this.firing) {
        const t = this.thrusters.get(key);
        if (!t) continue;
        this.dirToWorld(_j.set(-t.nozzle[0], -t.nozzle[1], -t.nozzle[2]), _j).multiplyScalar(THRUST * sdt);
        this.applyImpulse(_j, this.localToWorld(_w.set(t.x + 0.5, t.y + 0.5, t.z + 0.5), _w));
      }
      if (this.velocity.length() > MAX_SPEED) this.velocity.setLength(MAX_SPEED);
      if (this.angularVelocity.length() > MAX_SPIN) this.angularVelocity.setLength(MAX_SPIN);

      this.position.addScaledVector(this.velocity, sdt);
      const spin = this.angularVelocity.length();
      if (spin > 1e-9) {
        _q.setFromAxisAngle(_v.copy(this.angularVelocity).divideScalar(spin), spin * sdt);
        this.quaternion.premultiply(_q);
      }
      this.syncTransform();

      const contacts = this.findContacts(world, ships);
      support = contacts.length;
      if (contacts.length) {
        impact = Math.max(impact, this.resolveContacts(contacts));
        this.syncTransform();
      }
    }

    // Settle: a supported ship that has (almost) stopped goes to sleep. One balanced on an edge
    // or corner gets a tiny random nudge instead (real things never balance perfectly), so
    // it topples if that balance is unstable.
    const slow = this.velocity.length() < SLEEP_SPEED && this.angularVelocity.length() < SLEEP_SPEED && !thrusting;
    if (slow && pulled && support > 0 && support < MIN_SUPPORT) {
      this.angularVelocity.x += (Math.random() - 0.5) * WOBBLE;
      this.angularVelocity.z += (Math.random() - 0.5) * WOBBLE;
    }
    this.restTime = support >= MIN_SUPPORT && slow && !this.piloted ? this.restTime + dt : 0;
    if (this.restTime > SLEEP_TIME) {
      this.sleeping = true;
      this.sleepCheck = 0.25;
      this.velocity.set(0, 0, 0);
      this.angularVelocity.set(0, 0, 0);
      this.sleepGravity.copy(this.gravity);
    }
    return impact;
  }

  // ---------- thrusters & consoles ----------

  // The key bindings of the console at local (x, y, z), created empty on first use. Keys
  // added since a console was saved start out empty.
  consoleBindings(key) {
    let b = this.consoles.get(key);
    if (!b) {
      b = {};
      this.consoles.set(key, b);
    }
    for (const k of CONTROL_KEYS) b[k] ??= [];
    return b;
  }

  // Show a flickering flame at every firing thruster's nozzle.
  updateFlames() {
    for (const [key, flame] of this.flames) {
      if (!this.firing.has(key) || !this.thrusters.has(key)) {
        this.group.remove(flame);
        this.flames.delete(key);
      }
    }
    for (const key of this.firing) {
      const t = this.thrusters.get(key);
      if (!t) continue;
      let flame = this.flames.get(key);
      if (!flame) {
        flame = new THREE.Mesh(FLAME_GEOMETRY, FLAME_MATERIAL);
        const core = new THREE.Mesh(FLAME_GEOMETRY, FLAME_CORE);
        core.scale.set(0.5, 0.7, 0.5);
        flame.add(core);
        const n = _v.set(t.nozzle[0], t.nozzle[1], t.nozzle[2]);
        flame.quaternion.setFromUnitVectors(_up, n);
        flame.position.set(t.x + 0.5 + n.x * 0.5, t.y + 0.5 + n.y * 0.5, t.z + 0.5 + n.z * 0.5);
        this.group.add(flame);
        this.flames.set(key, flame);
      }
      const f = 0.85 + Math.random() * 0.3;
      flame.scale.set(f, 0.9 + Math.random() * 0.5, f);
    }
  }

  // ---------- lifecycle ----------

  // Record damage without remeshing (used while loading, before the first mesh build).
  setDamageQuiet(x, y, z, value) {
    const c = this.getChunkAt(x, y, z);
    if (!c) return;
    if (!c.damage) c.damage = new Map();
    c.damage.set(idx(x - c.cx * CS, y - c.cy * CS, z - c.cz * CS), value);
  }

  remeshAll() {
    for (const c of this.chunks.values()) this.buildMesh(c);
  }

  dispose() {
    for (const c of this.chunks.values()) this.disposeMeshes(c);
    this.scene.remove(this.group);
  }

  serialize() {
    const blocks = [], damage = [];
    const pos = (c, i) => [c.cx * CS + (i % CS), c.cy * CS + Math.floor(i / (CS * CS)), c.cz * CS + (Math.floor(i / CS) % CS)];
    for (const c of this.chunks.values()) {
      if (!c.data) continue;
      for (let i = 0; i < c.data.length; i++) {
        if (c.data[i] !== B.AIR) blocks.push(...pos(c, i), c.data[i], c.meta ? c.meta[i] : 0);
      }
      if (c.damage) for (const [i, d] of c.damage) damage.push(...pos(c, i), d);
    }
    return {
      format: 2, // blocks are [x, y, z, id, meta] (format 1 had no meta)
      blocks,
      damage,
      position: this.position.toArray(),
      quaternion: this.quaternion.toArray(),
      velocity: this.velocity.toArray(),
      angularVelocity: this.angularVelocity.toArray(),
      consoles: [...this.consoles].filter(([key]) => {
        const [x, y, z] = key.split(',').map(Number);
        return BLOCKS[this.getBlock(x, y, z)].console;
      }),
    };
  }

  static deserialize(data, scene, materials) {
    const ship = new Ship(scene, materials);
    const b = data.blocks;
    const stride = data.format === 2 ? 5 : 4;
    for (let i = 0; i < b.length; i += stride) {
      ship.setBlock(b[i], b[i + 1], b[i + 2], b[i + 3], { meta: stride === 5 ? b[i + 4] : 0, remesh: false });
    }
    const dmg = data.damage ?? [];
    for (let i = 0; i < dmg.length; i += 4) ship.setDamageQuiet(dmg[i], dmg[i + 1], dmg[i + 2], dmg[i + 3]);
    ship.position.fromArray(data.position);
    ship.quaternion.fromArray(data.quaternion);
    ship.velocity.fromArray(data.velocity);
    ship.angularVelocity.fromArray(data.angularVelocity);
    for (const [key, bindings] of data.consoles ?? []) ship.consoles.set(key, bindings);
    ship.syncTransform();
    ship.remeshAll();
    return ship;
  }
}
