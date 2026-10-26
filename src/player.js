// First-person player: mouse look, walking/flying/swimming, and collision against voxel grids.
//
// Reference grid: the player always lives in the local coordinates of one grid, either the
// static world or a ship they are standing on or inside. Position, velocity, and the gravity
// frame are stored in that grid's coordinates, so a moving or rotating ship carries the
// player along exactly and they can't slide off it. When the player steps off onto
// something else, their state is converted into the new grid's coordinates.
//
// Gravity can point along any of the six axis directions of the reference grid. The player
// keeps an orthonormal "frame" (right/up/back) whose up is opposite gravity. Movement and
// collision are expressed relative to that frame, and when it changes the view rotates
// smoothly into it.
//
// Collision: against the reference grid the player is an axis-aligned box (exact, blocky).
// Other grids can be rotated arbitrarily, so against them the player is a capsule of three
// spheres that gets pushed out of any solid block it overlaps.
import * as THREE from 'three';
import { BLOCKS } from './blocks.js';
import { SOLID, blockBoxes } from './grid.js';
import { TERRAIN_HEIGHT } from './world.js';

const HALF = 0.3;      // half the player's width (and the capsule radius)
const HEIGHT = 1.8;
const EYE = 1.62;
const EPS = 1e-3;
const GRAVITY = 28;
const JUMP = 8.6;
const WALK = 4.3;
const SPRINT = 6.2;
const FLY = 11;
const TURN_TIME = 0.45;       // seconds to reorient after gravity changes
const FALL_RESCUE_TIME = 10;  // seconds of nonstop falling before being dropped back onto terrain
const SPHERES = [HALF, HEIGHT / 2, HEIGHT - HALF]; // capsule sphere heights above the feet
const SHIP_EXIT_MARGIN = 1.5; // how far outside a ship's bounds you can drift before leaving it
const STEP_HEIGHT = 0.55;     // ledges up to this high (slabs, slopes) are walked up automatically

const AXES = ['x', 'y', 'z'];
const AXIS_NAMES = ['X', 'Y', 'Z'];

const snap = (v) => v.set(Math.round(v.x), Math.round(v.y), Math.round(v.z));
// The unit axis vector closest to `v`.
const nearestAxis = (v) => {
  const ax = Math.abs(v.x), ay = Math.abs(v.y), az = Math.abs(v.z);
  if (ax >= ay && ax >= az) return v.set(Math.sign(v.x) || 1, 0, 0);
  if (ay >= az) return v.set(0, Math.sign(v.y) || 1, 0);
  return v.set(0, 0, Math.sign(v.z) || 1);
};

const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();

export class Player {
  constructor(camera, world, ships) {
    this.camera = camera;
    this.world = world;
    this.ships = ships;             // shared list of all ships
    this.ref = null;                // ship we're riding, or null for the static world
    this.pos = new THREE.Vector3(); // centre of the feet, in the reference grid's coordinates
    this.vel = new THREE.Vector3(); // relative to the reference grid, in its coordinates
    this.yaw = 0;                   // relative to the gravity frame
    this.pitch = 0;
    this.onGround = false;
    this.flying = false;
    this.piloting = false;
    this.inWater = false;
    this.headInWater = false;
    this.fallTime = 0;
    this.stepOffset = 0; // eye lag after stepping up, smoothed away over a few frames
    this.keys = new Set();

    // Gravity frame, as exact unit axis vectors in the reference grid's coordinates.
    this.right = new THREE.Vector3(1, 0, 0);
    this.up = new THREE.Vector3(0, 1, 0);
    this.back = new THREE.Vector3(0, 0, 1);
    this.frame = new THREE.Quaternion();     // frame -> grid rotation used for physics
    this.viewFrame = new THREE.Quaternion(); // what the camera currently uses (lags during a turn)
    this.turn = null;                        // in-progress reorientation
    this.updateBounds();

    addEventListener('keydown', (e) => this.keys.add(e.code));
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  get grid() { return this.ref ?? this.world; }

  spawn(p) {
    this.pos.set(p.x, p.y, p.z);
    this.vel.set(0, 0, 0);
  }

  restore(s) {
    this.ref = s.ship != null ? this.ships[s.ship] ?? null : null;
    this.pos.set(s.x, s.y, s.z);
    this.yaw = s.yaw ?? 0;
    this.pitch = s.pitch ?? 0;
    this.flying = !!s.flying;
    if (s.up && s.right) {
      this.up.fromArray(s.up);
      this.right.fromArray(s.right);
      this.back.crossVectors(this.right, this.up);
      this.applyFrame();
      this.viewFrame.copy(this.frame);
    }
  }

  serialize() {
    const { x, y, z } = this.pos;
    return {
      x, y, z, yaw: this.yaw, pitch: this.pitch, flying: this.flying,
      up: this.up.toArray(), right: this.right.toArray(),
      ship: this.ref ? this.ships.indexOf(this.ref) : null,
    };
  }

  get upAxis() { return Math.abs(this.up.x) ? 0 : Math.abs(this.up.y) ? 1 : 2; }
  get upSign() { return this.up.getComponent(this.upAxis); }

  gravityLabel() {
    const sign = this.upSign > 0 ? '-' : '+';
    return `${sign}${AXIS_NAMES[this.upAxis]}${this.ref ? ' (ship)' : ''}`;
  }

  look(dx, dy) {
    const sens = 0.0022;
    this.yaw -= dx * sens;
    this.pitch = Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, this.pitch - dy * sens));
  }

  toggleFly() {
    this.flying = !this.flying;
    this.vel.addScaledVector(this.up, -this.vel.dot(this.up));
  }

  worldPosition(out = new THREE.Vector3()) { return this.grid.localToWorld(this.pos, out); }

  worldVelocity(out = new THREE.Vector3()) {
    const p = this.worldPosition(_a);
    return this.grid.dirToWorld(this.vel, out).add(this.grid.velocityAt(p, _b));
  }

  // Directions of the player's view-relative axes (yaw only) in the reference grid.
  moveBasis(forward, right) {
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    right.copy(this.right).multiplyScalar(cos).addScaledVector(this.back, -sin);
    forward.copy(this.right).multiplyScalar(-sin).addScaledVector(this.back, -cos);
  }

  // ---------- gravity frame ----------

  applyFrame() {
    this.frame.setFromRotationMatrix(new THREE.Matrix4().makeBasis(this.right, this.up, this.back));
    this.updateBounds();
  }

  // Box extents relative to the feet position, per grid axis.
  updateBounds() {
    const a = this.upAxis, s = this.upSign;
    this.lo = [-HALF, -HALF, -HALF];
    this.hi = [HALF, HALF, HALF];
    this.lo[a] = s > 0 ? 0 : -HEIGHT;
    this.hi[a] = s > 0 ? HEIGHT : 0;
  }

  // Choose yaw/pitch so the camera keeps looking where `view` (a grid-space camera rotation)
  // looks, in the current frame. Returns the view frame that reproduces `view` exactly.
  lookAlong(view) {
    const invFrame = _q1.copy(this.frame).invert();
    const local = _a.set(0, 0, -1).applyQuaternion(view).applyQuaternion(invFrame);
    this.pitch = Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, Math.asin(THREE.MathUtils.clamp(local.y, -1, 1))));
    if (Math.abs(local.y) < 0.99) {
      this.yaw = Math.atan2(-local.x, -local.z);
    } else {
      // Looking straight along the up axis: the camera's up tells us which way we face.
      const u = _b.set(0, 1, 0).applyQuaternion(view).applyQuaternion(invFrame);
      const f = local.y < 0 ? u : u.negate();
      this.yaw = Math.atan2(-f.x, -f.z);
    }
    return view.clone().multiply(this.yawPitchQuaternion(_q2).invert());
  }

  // Make `newUp` (an axis-aligned unit vector in grid space) the player's up, i.e. gravity
  // pulls toward -newUp.
  setUp(newUp, { instant = false } = {}) {
    newUp = snap(newUp.clone());
    if (newUp.equals(this.up)) return false;

    const oldUp = this.up.clone();
    const oldView = this.viewQuaternion(new THREE.Quaternion());

    // Smallest rotation taking the old up to the new one. For a 180 degree flip, turn
    // head-over-heels around the player's right axis.
    const delta = oldUp.dot(newUp) < -0.5
      ? new THREE.Quaternion().setFromAxisAngle(this.right, Math.PI)
      : new THREE.Quaternion().setFromUnitVectors(oldUp, newUp);

    // Rotate the body about its centre so the player doesn't end up inside the floor.
    const centre = this.pos.clone().addScaledVector(oldUp, HEIGHT / 2);
    const prev = { pos: this.pos.clone(), right: this.right.clone(), up: this.up.clone(), back: this.back.clone() };

    snap(this.right.applyQuaternion(delta));
    this.up.copy(newUp);
    this.back.crossVectors(this.right, this.up);
    this.applyFrame();
    this.pos.copy(centre).addScaledVector(newUp, -HEIGHT / 2);

    if (!this.findFreeSpot()) {
      // Nowhere to fit in the new orientation: stay as we were.
      this.pos.copy(prev.pos);
      this.right.copy(prev.right);
      this.up.copy(prev.up);
      this.back.copy(prev.back);
      this.applyFrame();
      return false;
    }

    this.onGround = false;
    const from = this.lookAlong(oldView);
    if (instant) {
      this.viewFrame.copy(this.frame);
      this.turn = null;
    } else {
      this.turn = { t: 0, from, oldUp, delta };
    }
    return true;
  }

  // ---------- reference grid ----------

  // Move the player into another grid's coordinates (null = the static world), keeping their
  // world position, world velocity, and view exactly the same.
  setReference(ship) {
    if (ship === this.ref) return;
    const old = this.grid;
    const worldPos = old.localToWorld(this.pos, new THREE.Vector3());
    const worldVel = this.worldVelocity(new THREE.Vector3());
    const worldView = old.quaternion.clone().multiply(this.viewQuaternion(new THREE.Quaternion()));
    const worldUp = old.dirToWorld(this.up, new THREE.Vector3());
    const worldRight = old.dirToWorld(this.right, new THREE.Vector3());

    this.ref = ship;
    this.piloting = false;
    const g = this.grid;
    g.worldToLocal(worldPos, this.pos);
    g.dirToLocal(worldVel.sub(g.velocityAt(worldPos, _a)), this.vel);

    // The new grid may be rotated arbitrarily: snap the gravity frame to its nearest axes.
    const up = nearestAxis(g.dirToLocal(worldUp, _c));
    const right = g.dirToLocal(worldRight, _d);
    right.addScaledVector(up, -right.dot(up));
    if (right.lengthSq() < 1e-6) right.set(up.y, up.z, up.x); // any perpendicular axis
    nearestAxis(right);
    this.up.copy(up);
    this.right.copy(right);
    this.back.crossVectors(this.right, this.up);
    this.applyFrame();
    this.findFreeSpot();

    // Keep the camera exactly where it was and ease into the snapped frame.
    const gridView = g.quaternion.clone().invert().multiply(worldView);
    const from = this.lookAlong(gridView);
    this.viewFrame.copy(from);
    this.turn = { t: 0, from, oldUp: this.up.clone(), delta: new THREE.Quaternion() };
  }

  // ---------- collision ----------

  // Nudge along the up axis until the body fits. Returns false if no spot nearby is free.
  findFreeSpot() {
    if (!this.collides()) return true;
    const start = this.pos.clone();
    for (const d of [0.5, -0.5, 0.9, -0.9, 1.3, -1.3]) {
      this.pos.copy(start).addScaledVector(this.up, d);
      if (!this.collides()) return true;
    }
    this.pos.copy(start);
    return false;
  }

  collides() {
    let hit = false;
    this.forEachOverlappingBox(() => { hit = true; });
    return hit;
  }

  // Call fn(box, x, y, z) for every collision box of the reference grid that overlaps the
  // player's body. Boxes are block-local; (x, y, z) is the block they belong to.
  forEachOverlappingBox(fn) {
    const p = this.pos, grid = this.grid, lo = this.lo, hi = this.hi;
    const minX = Math.floor(p.x + lo[0]), maxX = Math.floor(p.x + hi[0]);
    const minY = Math.floor(p.y + lo[1]), maxY = Math.floor(p.y + hi[1]);
    const minZ = Math.floor(p.z + lo[2]), maxZ = Math.floor(p.z + hi[2]);
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          const id = grid.getBlock(x, y, z);
          if (!SOLID[id]) continue;
          for (const b of blockBoxes(id, grid.getMeta(x, y, z))) {
            if (x + b[3] > p.x + lo[0] && x + b[0] < p.x + hi[0] &&
              y + b[4] > p.y + lo[1] && y + b[1] < p.y + hi[1] &&
              z + b[5] > p.z + lo[2] && z + b[2] < p.z + hi[2]) fn(b, x, y, z);
          }
        }
      }
    }
  }

  // True if the player's box overlaps the block at (bx, by, bz) of the reference grid.
  intersectsBlock(bx, by, bz) {
    const p = this.pos, lo = this.lo, hi = this.hi;
    return bx + 1 > p.x + lo[0] && bx < p.x + hi[0] &&
      by + 1 > p.y + lo[1] && by < p.y + hi[1] &&
      bz + 1 > p.z + lo[2] && bz < p.z + hi[2];
  }

  // True if placing a block at (x, y, z) of `grid` would overlap the player.
  overlapsBlock(grid, x, y, z) {
    if (grid === this.grid) return this.intersectsBlock(x, y, z);
    for (const h of SPHERES) {
      const p = this.sphereIn(grid, h, _c);
      const cx = THREE.MathUtils.clamp(p.x, x, x + 1);
      const cy = THREE.MathUtils.clamp(p.y, y, y + 1);
      const cz = THREE.MathUtils.clamp(p.z, z, z + 1);
      if (_d.set(p.x - cx, p.y - cy, p.z - cz).lengthSq() < (HALF - 0.01) ** 2) return true;
    }
    return false;
  }

  // Centre of the capsule sphere at height `h`, in `grid`'s coordinates.
  sphereIn(grid, h, out) {
    _v.copy(this.pos).addScaledVector(this.up, h);
    this.grid.localToWorld(_v, out);
    return grid.worldToLocal(out, out);
  }

  // Push a sphere (centre p, in grid coordinates) out of every solid block it overlaps.
  pushSphereOut(grid, p) {
    const r = HALF;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      const x0 = Math.floor(p.x - r), x1 = Math.floor(p.x + r);
      const y0 = Math.floor(p.y - r), y1 = Math.floor(p.y + r);
      const z0 = Math.floor(p.z - r), z1 = Math.floor(p.z + r);
      for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const id = grid.getBlock(x, y, z);
        if (!SOLID[id]) continue;
        for (const b of blockBoxes(id, grid.getMeta(x, y, z))) {
          const bx0 = x + b[0], by0 = y + b[1], bz0 = z + b[2], bx1 = x + b[3], by1 = y + b[4], bz1 = z + b[5];
          const cx = THREE.MathUtils.clamp(p.x, bx0, bx1);
          const cy = THREE.MathUtils.clamp(p.y, by0, by1);
          const cz = THREE.MathUtils.clamp(p.z, bz0, bz1);
          _d.set(p.x - cx, p.y - cy, p.z - cz);
          const dist = _d.length();
          if (dist >= r) continue;
          if (dist > 1e-6) {
            p.addScaledVector(_d, (r - dist) / dist);
          } else {
            // Centre is inside the box: leave through the nearest face.
            const faces = [[p.x - bx0, -1, 0], [bx1 - p.x, 1, 0], [p.y - by0, -1, 1], [by1 - p.y, 1, 1], [p.z - bz0, -1, 2], [bz1 - p.z, 1, 2]];
            faces.sort((a, c) => a[0] - c[0]);
            const [depth, sign, axis] = faces[0];
            p.setComponent(axis, p.getComponent(axis) + sign * (depth + r));
          }
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  // Resolve overlaps with every grid other than the reference one. Returns the grid we're
  // standing on, if any.
  resolveOtherGrids() {
    const own = this.grid;
    let ground = null;
    const wp = this.worldPosition(new THREE.Vector3());
    for (const g of [this.world, ...this.ships]) {
      if (g === own) continue;
      if (g !== this.world) {
        g.updateShape();
        if (g.blockCount === 0 || wp.distanceTo(g.position) > g.radius + HEIGHT + 1) continue;
      }
      for (const h of SPHERES) {
        const p = this.sphereIn(g, h, new THREE.Vector3());
        const start = p.clone();
        this.pushSphereOut(g, p);
        if (p.equals(start)) continue;
        // Convert the push back into our own grid's coordinates.
        const push = own.dirToLocal(g.dirToWorld(p.sub(start), _a), _a);
        this.pos.add(push);
        const n = push.normalize();
        const into = this.vel.dot(n);
        if (into < 0) this.vel.addScaledVector(n, -into);
        if (n.dot(this.up) > 0.6) ground = g;
      }
    }
    return ground;
  }

  // Decide which grid the player should be riding after this step.
  updateReference(groundOther, onOwnGround) {
    if (groundOther && !onOwnGround) {
      // Stepped onto another grid: stick to it.
      this.setReference(groundOther === this.world ? null : groundOther);
      this.onGround = true;
      return;
    }
    if (onOwnGround) return;
    const wp = this.worldPosition(new THREE.Vector3());
    if (this.ref && !this.ref.containsLocal(this.pos, SHIP_EXIT_MARGIN)) {
      // Drifted clear of the ship.
      this.setReference(this.shipContaining(wp));
    } else if (!this.ref) {
      // Flew or fell into a ship's hull: ride along with it.
      const ship = this.shipContaining(wp);
      if (ship) this.setReference(ship);
    }
  }

  shipContaining(worldPos) {
    for (const s of this.ships) {
      if (s !== this.ref && s.blockCount > 0 && s.containsLocal(s.worldToLocal(worldPos, _c), 0)) return s;
    }
    return null;
  }

  // ---------- simulation ----------

  update(dt) {
    const k = this.keys;
    const grid = this.grid;
    const up = this.up;

    _v.copy(this.pos).addScaledVector(up, 0.4).floor();
    this.inWater = BLOCKS[grid.getBlock(_v.x, _v.y, _v.z)].liquid;
    _v.copy(this.pos).addScaledVector(up, EYE).floor();
    this.headInWater = BLOCKS[grid.getBlock(_v.x, _v.y, _v.z)].liquid;

    // Work in the gravity frame: x = right, y = up, z = back.
    let vx = this.vel.dot(this.right), vy = this.vel.dot(up), vz = this.vel.dot(this.back);

    // While piloting, the movement keys fly the ship instead of the player.
    const control = !this.piloting;
    let fx = 0, fz = 0;
    if (control) {
      if (k.has('KeyW')) fz -= 1;
      if (k.has('KeyS')) fz += 1;
      if (k.has('KeyA')) fx -= 1;
      if (k.has('KeyD')) fx += 1;
    }
    const len = Math.hypot(fx, fz) || 1;
    fx /= len; fz /= len;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wishX = fx * cos + fz * sin;
    const wishZ = -fx * sin + fz * cos;

    const jump = control && k.has('Space');
    const sprint = control && (k.has('ShiftLeft') || k.has('ShiftRight'));
    let speed = this.flying ? FLY : (sprint && !this.inWater ? SPRINT : WALK);
    if (this.inWater && !this.flying) speed *= 0.55;

    const accel = this.onGround || this.flying || this.inWater ? 14 : 3;
    const blend = Math.min(1, accel * dt);
    vx += (wishX * speed - vx) * blend;
    vz += (wishZ * speed - vz) * blend;

    if (this.flying) {
      let target = 0;
      if (jump) target += FLY;
      if (sprint) target -= FLY;
      vy += (target - vy) * Math.min(1, 10 * dt);
    } else if (this.inWater) {
      vy -= GRAVITY * 0.25 * dt;
      if (jump) vy = Math.min(vy + 30 * dt, 3.5);
      vy = Math.max(vy, -3);
    } else {
      vy -= GRAVITY * dt;
      if (jump && this.onGround) vy = JUMP;
      vy = Math.max(vy, -60);
    }

    this.vel.set(0, 0, 0)
      .addScaledVector(this.right, vx)
      .addScaledVector(up, vy)
      .addScaledVector(this.back, vz);

    // Sub-step so fast movement never tunnels through a block. Resolve the gravity axis first.
    const maxMove = Math.max(Math.abs(this.vel.x), Math.abs(this.vel.y), Math.abs(this.vel.z)) * dt;
    const steps = Math.max(1, Math.ceil(maxMove / 0.35));
    const sdt = dt / steps;
    const a = this.upAxis;
    const order = [a, (a + 1) % 3, (a + 2) % 3];
    const canStep = this.onGround && !this.flying;
    this.onGround = false;
    for (let i = 0; i < steps; i++) {
      for (const axis of order) this.moveAxis(axis, this.vel.getComponent(axis) * sdt, canStep);
    }
    const onOwnGround = this.onGround;
    const groundOther = this.resolveOtherGrids();
    if (groundOther) this.onGround = true;
    if (this.onGround && this.flying && !jump) this.flying = false;
    this.updateReference(groundOther, onOwnGround);

    // Falling endlessly through empty space (gravity can point anywhere): drop back in from
    // the sky above the terrain.
    this.fallTime = this.onGround || this.flying || this.inWater ? 0 : this.fallTime + dt;
    if (this.fallTime > FALL_RESCUE_TIME) {
      this.fallTime = 0;
      this.setReference(null);
      this.setUp(new THREE.Vector3(0, 1, 0), { instant: true });
      this.pos.y = TERRAIN_HEIGHT;
      this.vel.set(0, 0, 0);
    }

    this.syncCamera(dt);
  }

  // Move along one grid axis, stopping at the first box in the way. With `canStep`, a low
  // ledge (a slab, a slope) is climbed instead of blocking.
  moveAxis(axis, amount, canStep = false) {
    if (amount === 0) return;
    const name = AXES[axis];
    const p = this.pos;
    p[name] += amount;
    let hit = null;
    this.forEachOverlappingBox((b, x, y, z) => {
      const base = axis === 0 ? x : axis === 1 ? y : z;
      const edge = amount > 0 ? base + b[axis] : base + b[axis + 3];
      if (hit === null || (amount > 0 ? edge < hit : edge > hit)) hit = edge;
    });
    if (hit === null) return;
    if (canStep && axis !== this.upAxis && this.tryStepUp()) return;
    p[name] = amount > 0 ? hit - this.hi[axis] - EPS : hit - this.lo[axis] + EPS;
    // Landed if we were moving with gravity along the up axis.
    if (axis === this.upAxis && amount * this.upSign < 0) this.onGround = true;
    this.vel.setComponent(axis, 0);
  }

  // We've just moved sideways into something. If lifting by up to STEP_HEIGHT clears it,
  // stay lifted and settle back down onto the ledge.
  tryStepUp() {
    const start = this.pos.clone();
    this.pos.addScaledVector(this.up, STEP_HEIGHT);
    if (this.collides()) { this.pos.copy(start); return false; }
    const a = this.upAxis;
    this.moveAxis(a, -STEP_HEIGHT * this.upSign);
    const rise = (this.pos.getComponent(a) - start.getComponent(a)) * this.upSign;
    if (rise <= EPS * 2) {
      // Nothing to stand on up there (we were blocked by something else): undo.
      this.pos.copy(start);
      return false;
    }
    this.stepOffset += rise;
    this.onGround = true;
    return true;
  }

  // ---------- camera ----------

  yawPitchQuaternion(out) {
    _e.set(this.pitch, this.yaw, 0, 'YXZ');
    return out.setFromEuler(_e);
  }

  // Camera rotation in the reference grid's coordinates.
  viewQuaternion(out) {
    return out.copy(this.viewFrame).multiply(this.yawPitchQuaternion(_q2));
  }

  syncCamera(dt = 0) {
    const eyeUp = _v.copy(this.up);
    if (this.turn) {
      const turn = this.turn;
      turn.t = Math.min(1, turn.t + dt / TURN_TIME);
      const s = THREE.MathUtils.smootherstep(turn.t, 0, 1);
      this.viewFrame.slerpQuaternions(turn.from, this.frame, s);
      // Swing the eye from the old up to the new one around the body's centre.
      eyeUp.copy(turn.oldUp).applyQuaternion(_q1.identity().slerp(turn.delta, s));
      if (turn.t >= 1) {
        this.viewFrame.copy(this.frame);
        this.turn = null;
      }
    }
    this.stepOffset *= Math.exp(-dt * 18);
    const eye = _a.copy(this.pos)
      .addScaledVector(this.up, HEIGHT / 2 - this.stepOffset)
      .addScaledVector(eyeUp, EYE - HEIGHT / 2);
    this.grid.localToWorld(eye, this.camera.position);
    this.camera.quaternion.copy(this.grid.quaternion).multiply(this.viewQuaternion(_q1));
  }
}
