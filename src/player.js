// First-person player: mouse look, walking/flying/swimming, and AABB collision against voxels.
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

export class Player {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;
    this.flying = false;
    this.inWater = false;
    this.headInWater = false;
    this.keys = new Set();

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
  }

  serialize() {
    const { x, y, z } = this.pos;
    return { x, y, z, yaw: this.yaw, pitch: this.pitch, flying: this.flying };
  }

  look(dx, dy) {
    const sens = 0.0022;
    this.yaw -= dx * sens;
    this.pitch = Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, this.pitch - dy * sens));
  }

  toggleFly() {
    this.flying = !this.flying;
    this.vel.y = 0;
  }

  // True if the player's bounding box (feet at p) would overlap any solid block.
  intersectsBlock(bx, by, bz) {
    const p = this.pos;
    return bx + 1 > p.x - HALF && bx < p.x + HALF &&
      by + 1 > p.y && by < p.y + HEIGHT &&
      bz + 1 > p.z - HALF && bz < p.z + HALF;
  }

  update(dt) {
    const k = this.keys;
    const world = this.world;
    const feet = world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.4), Math.floor(this.pos.z));
    const head = world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y + EYE), Math.floor(this.pos.z));
    this.inWater = BLOCKS[feet].liquid;
    this.headInWater = BLOCKS[head].liquid;

    // Desired horizontal movement relative to where the player faces.
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
    this.vel.x += (wishX * speed - this.vel.x) * blend;
    this.vel.z += (wishZ * speed - this.vel.z) * blend;

    if (this.flying) {
      let vy = 0;
      if (k.has('Space')) vy += FLY;
      if (sprint) vy -= FLY;
      this.vel.y += (vy - this.vel.y) * Math.min(1, 10 * dt);
    } else if (this.inWater) {
      this.vel.y -= GRAVITY * 0.25 * dt;
      if (k.has('Space')) this.vel.y = Math.min(this.vel.y + 30 * dt, 3.5);
      this.vel.y = Math.max(this.vel.y, -3);
    } else {
      this.vel.y -= GRAVITY * dt;
      if (k.has('Space') && this.onGround) this.vel.y = JUMP;
      this.vel.y = Math.max(this.vel.y, -60);
    }

    // Sub-step so fast movement never tunnels through a block.
    const maxMove = Math.max(Math.abs(this.vel.x), Math.abs(this.vel.y), Math.abs(this.vel.z)) * dt;
    const steps = Math.max(1, Math.ceil(maxMove / 0.35));
    const sdt = dt / steps;
    this.onGround = false;
    for (let i = 0; i < steps; i++) {
      this.moveAxis('y', this.vel.y * sdt);
      this.moveAxis('x', this.vel.x * sdt);
      this.moveAxis('z', this.vel.z * sdt);
    }
    if (this.onGround && this.flying && !k.has('Space')) this.flying = false;

    if (this.pos.y < -20) this.pos.y = CH;
    this.syncCamera();
  }

  moveAxis(axis, amount) {
    if (amount === 0) return;
    const p = this.pos;
    p[axis] += amount;
    const minX = Math.floor(p.x - HALF), maxX = Math.floor(p.x + HALF);
    const minY = Math.floor(p.y), maxY = Math.floor(p.y + HEIGHT);
    const minZ = Math.floor(p.z - HALF), maxZ = Math.floor(p.z + HALF);
    let hit = null;
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          if (!BLOCKS[this.world.getBlock(x, y, z)].solid) continue;
          if (!this.intersectsBlock(x, y, z)) continue;
          const c = axis === 'x' ? x : axis === 'y' ? y : z;
          if (hit === null || (amount > 0 ? c < hit : c > hit)) hit = c;
        }
      }
    }
    if (hit === null) return;
    const extent = axis === 'y' ? (amount > 0 ? HEIGHT : 0) : HALF;
    p[axis] = amount > 0 ? hit - extent - EPS : hit + 1 + extent + EPS;
    if (axis === 'y' && amount < 0) this.onGround = true;
    this.vel[axis] = 0;
  }

  syncCamera() {
    this.camera.position.set(this.pos.x, this.pos.y + EYE, this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }
}
