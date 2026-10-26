// A ship: a free-moving voxel grid with its own position, rotation, and velocity.
//
// Local block coordinates map to world space as  world = position + R * (local - com),
// where `com` is the local centre of mass, so the ship rotates about its centre of mass.
// Blocks can be added and removed at any time, including while the ship is moving.
import * as THREE from 'three';
import { VoxelGrid, SOLID, CS, idx } from './grid.js';
import { B } from './blocks.js';
import { gravityAt, G } from './gravity.js';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _prevPos = new THREE.Vector3();
const _prevQuat = new THREE.Quaternion();
const _g = new THREE.Vector3();
const GRAVITY_SAMPLES = 32;  // exposed blocks sampled when measuring the gravity on a ship
const MAX_FALL_SPEED = 60;

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

    this.blockCount = 0;
    this.blockSum = new THREE.Vector3(); // sum of solid block centres, for the centre of mass
    this.com = new THREE.Vector3();
    this.min = new THREE.Vector3();      // local bounds of solid blocks (inclusive block coords)
    this.max = new THREE.Vector3();
    this.radius = 0;                     // bounding sphere radius around the centre of mass
    this.surface = [];                   // local coords of blocks exposed to the outside
    this.shapeDirty = true;
    this.gravity = new THREE.Vector3();  // average pull on the ship, world space, strength 0..1
    this.piloted = false;                // a pilot's thrusters hold the ship against gravity
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
    const wasSolid = SOLID[old] === 1, isSolid = SOLID[id] === 1;
    if (wasSolid === isSolid) return;
    const sign = isSolid ? 1 : -1;
    this.blockCount += sign;
    this.blockSum.x += sign * (x + 0.5);
    this.blockSum.y += sign * (y + 0.5);
    this.blockSum.z += sign * (z + 0.5);

    // Move the centre of mass without moving the ship: shift `position` to compensate.
    if (this.blockCount > 0) {
      const newCom = _w.copy(this.blockSum).divideScalar(this.blockCount);
      this.position.add(_v.subVectors(newCom, this.com).applyQuaternion(this.quaternion));
      this.com.copy(newCom);
    }
    this.shapeDirty = true;
    this.syncTransform();
  }

  // Recompute bounds, bounding radius, and the list of exposed blocks used for collisions.
  updateShape() {
    if (!this.shapeDirty) return;
    this.shapeDirty = false;
    this.surface = [];
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
        if (!this.isSolid(x + 1, y, z) || !this.isSolid(x - 1, y, z) || !this.isSolid(x, y + 1, z) ||
          !this.isSolid(x, y - 1, z) || !this.isSolid(x, y, z + 1) || !this.isSolid(x, y, z - 1)) {
          this.surface.push(x, y, z);
        }
      }
    }
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

  // Average gravity over the ship: its centre of mass plus a spread of its exposed blocks, so
  // a large ship feels a gravity plate its hull is near even if its centre is far away.
  measureGravity(world, ships) {
    this.updateShape();
    this.gravity.set(0, 0, 0);
    const surf = this.surface, count = surf.length / 3;
    const stride = Math.max(1, Math.floor(count / GRAVITY_SAMPLES));
    let n = 1;
    this.gravity.add(gravityAt(this.position, world, ships, _g, this));
    for (let i = 0; i < count; i += stride, n++) {
      this.localToWorld(_v.set(surf[i * 3] + 0.5, surf[i * 3 + 1] + 0.5, surf[i * 3 + 2] + 0.5), _w);
      this.gravity.add(gravityAt(_w, world, ships, _g, this));
    }
    return this.gravity.divideScalar(n);
  }

  // Advance the ship. Returns the impact speed if it hit something this step, else 0.
  update(dt, world, ships) {
    if (this.blockCount === 0) return 0;
    this.updateShape();

    // A ship that is already overlapping something (e.g. built into the ground) may move
    // freely until it is clear, and isn't pulled by gravity meanwhile; otherwise movement
    // stops at the first contact.
    this.measureGravity(world, ships);
    const pulled = !this.piloted && this.gravity.lengthSq() > 1e-6;
    let speed = this.velocity.length();
    const spin = this.angularVelocity.length();
    if (!pulled && speed < 1e-4 && spin < 1e-4) return 0;
    const startsClear = !this.intersectsAnything(world, ships);
    if (pulled && startsClear) {
      this.velocity.addScaledVector(this.gravity, G * dt);
      if (this.velocity.length() > MAX_FALL_SPEED) this.velocity.setLength(MAX_FALL_SPEED);
      speed = this.velocity.length();
    }
    if (speed < 1e-4 && spin < 1e-4) return 0;
    const travel = (speed + spin * this.radius) * dt;
    const steps = Math.min(20, Math.max(1, Math.ceil(travel / 0.25)));
    const sdt = dt / steps;
    for (let i = 0; i < steps; i++) {
      _prevPos.copy(this.position);
      _prevQuat.copy(this.quaternion);
      this.position.addScaledVector(this.velocity, sdt);
      if (spin > 0) {
        _q.setFromAxisAngle(_v.copy(this.angularVelocity).divideScalar(spin), spin * sdt);
        this.quaternion.premultiply(_q);
      }
      this.syncTransform();
      if (startsClear && this.intersectsAnything(world, ships)) {
        this.position.copy(_prevPos);
        this.quaternion.copy(_prevQuat);
        this.syncTransform();
        this.velocity.set(0, 0, 0);
        this.angularVelocity.set(0, 0, 0);
        return Math.max(speed, 1e-3);
      }
    }
    return 0;
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
    ship.syncTransform();
    ship.remeshAll();
    return ship;
  }
}
