// First-person player: mouse look, walking/flying/swimming, and AABB collision against voxels.
//
// Gravity can point along any of the six axis directions. The player keeps an orthonormal
// "frame" (right/up/back in world space) whose up is opposite gravity. Movement, collision
// and the camera are all expressed relative to that frame, and when gravity changes the
// view rotates smoothly into the new frame.
import * as THREE from 'three';
import { BLOCKS } from './blocks.js';
import { CH } from './world.js';

const HALF = 0.3;      // half the player's width
const HEIGHT = 1.8;
const EYE = 1.62;
const EPS = 1e-3;
const GRAVITY = 28;
const JUMP = 8.6;
const WALK = 4.3;
const SPRINT = 6.2;
const FLY = 11;
const TURN_TIME = 0.45; // seconds to reorient after gravity changes

const AXES = ['x', 'y', 'z'];
const AXIS_NAMES = ['X', 'Y', 'Z'];

const snap = (v) => v.set(Math.round(v.x), Math.round(v.y), Math.round(v.z));
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _v = new THREE.Vector3();

export class Player {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    this.pos = new THREE.Vector3(); // centre of the feet
    this.vel = new THREE.Vector3(); // world space
    this.yaw = 0;                   // relative to the gravity frame
    this.pitch = 0;
    this.onGround = false;
    this.flying = false;
    this.inWater = false;
    this.headInWater = false;
    this.keys = new Set();

    // Gravity frame, as exact unit axis vectors in world space.
    this.right = new THREE.Vector3(1, 0, 0);
    this.up = new THREE.Vector3(0, 1, 0);
    this.back = new THREE.Vector3(0, 0, 1);
    this.frame = new THREE.Quaternion();     // local -> world rotation for physics
    this.viewFrame = new THREE.Quaternion(); // what the camera currently uses (lags during a turn)
    this.turn = null;                        // in-progress reorientation
    this.updateBounds();

    addEventListener('keydown', (e) => this.keys.add(e.code));
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  spawn(p) {
    this.pos.set(p.x, p.y, p.z);
    this.vel.set(0, 0, 0);
  }

  restore(s) {
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
    };
  }

  get upAxis() { return Math.abs(this.up.x) ? 0 : Math.abs(this.up.y) ? 1 : 2; }
  get upSign() { return this.up.getComponent(this.upAxis); }

  gravityLabel() {
    const sign = this.upSign > 0 ? '-' : '+';
    return `${sign}${AXIS_NAMES[this.upAxis]}`;
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

  // ---------- gravity ----------

  applyFrame() {
    this.frame.setFromRotationMatrix(new THREE.Matrix4().makeBasis(this.right, this.up, this.back));
    this.updateBounds();
  }

  // Box extents relative to the feet position, per world axis.
  updateBounds() {
    const a = this.upAxis, s = this.upSign;
    this.lo = [-HALF, -HALF, -HALF];
    this.hi = [HALF, HALF, HALF];
    this.lo[a] = s > 0 ? 0 : -HEIGHT;
    this.hi[a] = s > 0 ? HEIGHT : 0;
  }

  // Make `newUp` (an axis-aligned unit vector) the player's up, i.e. gravity pulls toward -newUp.
  setUp(newUp, { instant = false } = {}) {
    newUp = snap(newUp.clone());
    if (newUp.equals(this.up)) return false;

    const oldUp = this.up.clone();
    const oldView = this.viewQuaternion(new THREE.Quaternion());
    const look = new THREE.Vector3(0, 0, -1).applyQuaternion(oldView);
    const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(oldView);

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

    // Keep looking at the same point in the world, re-expressed in the new frame.
    const invFrame = this.frame.clone().invert();
    const local = look.applyQuaternion(invFrame);
    this.pitch = Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, Math.asin(THREE.MathUtils.clamp(local.y, -1, 1))));
    if (Math.abs(local.y) < 0.99) {
      this.yaw = Math.atan2(-local.x, -local.z);
    } else {
      // Looking straight along the new up axis: the camera's up tells us which way we face.
      const u = camUp.applyQuaternion(invFrame);
      const f = local.y < 0 ? u : u.negate();
      this.yaw = Math.atan2(-f.x, -f.z);
    }

    this.onGround = false;
    if (instant) {
      this.viewFrame.copy(this.frame);
      this.turn = null;
    } else {
      // Start the camera exactly where it was and ease into the new frame.
      this.yawPitchQuaternion(_q1);
      const from = oldView.multiply(_q1.invert());
      this.turn = { t: 0, from, oldUp, delta };
    }
    return true;
  }

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
    const p = this.pos;
    const minX = Math.floor(p.x + this.lo[0]), maxX = Math.floor(p.x + this.hi[0]);
    const minY = Math.floor(p.y + this.lo[1]), maxY = Math.floor(p.y + this.hi[1]);
    const minZ = Math.floor(p.z + this.lo[2]), maxZ = Math.floor(p.z + this.hi[2]);
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          if (BLOCKS[this.world.getBlock(x, y, z)].solid && this.intersectsBlock(x, y, z)) return true;
        }
      }
    }
    return false;
  }

  // True if the player's bounding box overlaps the block at (bx, by, bz).
  intersectsBlock(bx, by, bz) {
    const p = this.pos, lo = this.lo, hi = this.hi;
    return bx + 1 > p.x + lo[0] && bx < p.x + hi[0] &&
      by + 1 > p.y + lo[1] && by < p.y + hi[1] &&
      bz + 1 > p.z + lo[2] && bz < p.z + hi[2];
  }

  // ---------- simulation ----------

  update(dt) {
    const k = this.keys;
    const world = this.world;
    const up = this.up;

    _v.copy(this.pos).addScaledVector(up, 0.4).floor();
    this.inWater = BLOCKS[world.getBlock(_v.x, _v.y, _v.z)].liquid;
    _v.copy(this.pos).addScaledVector(up, EYE).floor();
    this.headInWater = BLOCKS[world.getBlock(_v.x, _v.y, _v.z)].liquid;

    // Work in the gravity frame: x = right, y = up, z = back.
    let vx = this.vel.dot(this.right), vy = this.vel.dot(up), vz = this.vel.dot(this.back);

    let fx = 0, fz = 0;
    if (k.has('KeyW')) fz -= 1;
    if (k.has('KeyS')) fz += 1;
    if (k.has('KeyA')) fx -= 1;
    if (k.has('KeyD')) fx += 1;
    const len = Math.hypot(fx, fz) || 1;
    fx /= len; fz /= len;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wishX = fx * cos + fz * sin;
    const wishZ = -fx * sin + fz * cos;

    const sprint = k.has('ShiftLeft') || k.has('ShiftRight');
    let speed = this.flying ? FLY : (sprint && !this.inWater ? SPRINT : WALK);
    if (this.inWater && !this.flying) speed *= 0.55;

    const accel = this.onGround || this.flying || this.inWater ? 14 : 3;
    const blend = Math.min(1, accel * dt);
    vx += (wishX * speed - vx) * blend;
    vz += (wishZ * speed - vz) * blend;

    if (this.flying) {
      let target = 0;
      if (k.has('Space')) target += FLY;
      if (sprint) target -= FLY;
      vy += (target - vy) * Math.min(1, 10 * dt);
    } else if (this.inWater) {
      vy -= GRAVITY * 0.25 * dt;
      if (k.has('Space')) vy = Math.min(vy + 30 * dt, 3.5);
      vy = Math.max(vy, -3);
    } else {
      vy -= GRAVITY * dt;
      if (k.has('Space') && this.onGround) vy = JUMP;
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
    this.onGround = false;
    for (let i = 0; i < steps; i++) {
      for (const axis of order) this.moveAxis(axis, this.vel.getComponent(axis) * sdt);
    }
    if (this.onGround && this.flying && !k.has('Space')) this.flying = false;

    // Fell out of the world (gravity can point anywhere): drop back in from the sky.
    if (this.pos.y < -20 || this.pos.y > CH + 64) {
      this.setUp(new THREE.Vector3(0, 1, 0), { instant: true });
      this.pos.y = CH;
      this.vel.set(0, 0, 0);
    }

    this.syncCamera(dt);
  }

  moveAxis(axis, amount) {
    if (amount === 0) return;
    const name = AXES[axis];
    const p = this.pos;
    p[name] += amount;
    const minX = Math.floor(p.x + this.lo[0]), maxX = Math.floor(p.x + this.hi[0]);
    const minY = Math.floor(p.y + this.lo[1]), maxY = Math.floor(p.y + this.hi[1]);
    const minZ = Math.floor(p.z + this.lo[2]), maxZ = Math.floor(p.z + this.hi[2]);
    let hit = null;
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          if (!BLOCKS[this.world.getBlock(x, y, z)].solid) continue;
          if (!this.intersectsBlock(x, y, z)) continue;
          const c = axis === 0 ? x : axis === 1 ? y : z;
          if (hit === null || (amount > 0 ? c < hit : c > hit)) hit = c;
        }
      }
    }
    if (hit === null) return;
    p[name] = amount > 0 ? hit - this.hi[axis] - EPS : hit + 1 - this.lo[axis] + EPS;
    // Landed if we were moving with gravity along the up axis.
    if (axis === this.upAxis && amount * this.upSign < 0) this.onGround = true;
    this.vel.setComponent(axis, 0);
  }

  // ---------- camera ----------

  yawPitchQuaternion(out) {
    _e.set(this.pitch, this.yaw, 0, 'YXZ');
    return out.setFromEuler(_e);
  }

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
    this.camera.position.copy(this.pos)
      .addScaledVector(this.up, HEIGHT / 2)
      .addScaledVector(eyeUp, EYE - HEIGHT / 2);
    this.viewQuaternion(this.camera.quaternion);
  }
}
