// Water and lava flow, following Minecraft's rules but with "down" taken from the gravity
// field at each block, so fluids pool on every face of a planet and pour over its edges.
//
// A fluid block's meta byte holds its state:
//   bits 0-2  level: 0 = source, 1..7 = flowing, further from its source as it rises
//   bit  3    falling: fed from above (spreads like a source when it lands)
//   bits 4-6  which way is down (a face index, see shapes.js DIRS), or NO_DOWN in zero-g
//
// Rules (per block, when scheduled):
//   - Flowing blocks re-derive their level from their neighbours: falling if the same fluid is
//     above, else one step (water) or two (lava) past the best neighbour. With nothing feeding
//     them they dry up. Two water sources beside a block over solid ground make it a source.
//   - Fluid falls into an empty block below. Otherwise (and for sources even when falling) it
//     spreads sideways to its four horizontal neighbours, preferring the directions with the
//     shortest path to a drop within 4 blocks (water) or 2 (lava).
//   - Lava touching water hardens: a source into obsidian, flowing lava into cobblestone.
//     Lava falling onto water turns the water into stone.
// Water updates every 5 ticks (0.25 s) and lava every 30, at 20 ticks per second.
import * as THREE from 'three';
import { B, BLOCKS } from './blocks.js';
import { DIRS, dirIndex } from './shapes.js';
import { gravityAt } from './gravity.js';

export const NO_DOWN = 6;
const TICK = 1 / 20;
const DELAY = { [B.WATER]: 5, [B.LAVA]: 30 };
const STEP = { [B.WATER]: 1, [B.LAVA]: 2 };      // level lost per block of sideways flow
const SEARCH = { [B.WATER]: 4, [B.LAVA]: 2 };    // how far flowing fluid looks for a drop
const MAX_UPDATES_PER_TICK = 400;

export const encodeFluid = (level, falling, down) => (level & 7) | (falling ? 8 : 0) | (down << 4);
export const fluidLevel = (meta) => meta & 7;
export const fluidFalling = (meta) => (meta & 8) !== 0;
export const fluidDown = (meta) => (meta >> 4) & 7;

const isFluid = (id) => id === B.WATER || id === B.LAVA;
const _p = new THREE.Vector3();
const _g = new THREE.Vector3();

// Which face index is "down" at block (x, y, z) of the world, or NO_DOWN in zero-g.
export function downAt(world, ships, x, y, z) {
  gravityAt(_p.set(x + 0.5, y + 0.5, z + 0.5), world, ships, _g);
  if (_g.lengthSq() < 0.05 * 0.05) return NO_DOWN;
  const ax = Math.abs(_g.x), ay = Math.abs(_g.y), az = Math.abs(_g.z);
  if (ax >= ay && ax >= az) return dirIndex(Math.sign(_g.x), 0, 0);
  if (ay >= az) return dirIndex(0, Math.sign(_g.y), 0);
  return dirIndex(0, 0, Math.sign(_g.z));
}

export class Fluids {
  constructor(world, ships) {
    this.world = world;
    this.ships = ships;
    this.tickCount = 0;
    this.accum = 0;
    this.queue = new Map(); // "x,y,z" -> due tick
    // Any edit to the world wakes the fluids around it.
    world.onEdit = (x, y, z) => this.wakeAround(x, y, z);
  }

  // Meta for a fluid block placed at (x, y, z): a source flowing toward the local "down".
  sourceMeta(x, y, z) {
    return encodeFluid(0, false, downAt(this.world, this.ships, x, y, z));
  }

  schedule(x, y, z) {
    const id = this.world.getBlock(x, y, z);
    if (!isFluid(id)) return;
    const key = x + ',' + y + ',' + z;
    const due = this.tickCount + DELAY[id];
    const prev = this.queue.get(key);
    if (prev === undefined || due < prev) this.queue.set(key, due);
  }

  wakeAround(x, y, z) {
    this.schedule(x, y, z);
    for (const [dx, dy, dz] of DIRS) this.schedule(x + dx, y + dy, z + dz);
  }

  tick(dt) {
    this.accum = Math.min(this.accum + dt, TICK * 4);
    while (this.accum >= TICK) {
      this.accum -= TICK;
      this.tickCount++;
      let budget = MAX_UPDATES_PER_TICK;
      for (const [key, due] of this.queue) {
        if (due > this.tickCount) continue;
        this.queue.delete(key);
        const [x, y, z] = key.split(',').map(Number);
        if (!this.world.getChunkAt(x, y, z)) continue; // unloaded: let it rest
        this.update(x, y, z);
        if (--budget === 0) break;
      }
    }
  }

  // ---------- block helpers ----------

  get(x, y, z) { return this.world.getBlock(x, y, z); }
  meta(x, y, z) { return this.world.getMeta(x, y, z); }

  set(x, y, z, id, meta = 0) {
    // Fluid changes come in bursts: let the chunk streamer remesh them in its own budget.
    if (!this.world.setBlock(x, y, z, id, { meta, remesh: false })) return;
    this.world.markDirtyAround(x, y, z);
  }

  // Can fluid `id` flow into (x, y, z) with level `level`?
  canFlowInto(x, y, z, id, level) {
    const t = this.get(x, y, z);
    if (t === B.AIR) return true;
    if (t !== id) return false;
    const m = this.meta(x, y, z);
    return fluidLevel(m) !== 0 && !fluidFalling(m) && fluidLevel(m) > level;
  }

  // ---------- the rules ----------

  update(x, y, z) {
    const id = this.get(x, y, z);
    if (!isFluid(id)) return;
    let meta = this.meta(x, y, z);
    const down = downAt(this.world, this.ships, x, y, z);
    if (down === NO_DOWN) {
      if (fluidDown(meta) !== NO_DOWN) this.set(x, y, z, id, encodeFluid(fluidLevel(meta), false, NO_DOWN));
      return; // zero-g: fluids float where they are
    }
    const up = down ^ 1;
    const [dx, dy, dz] = DIRS[down];
    const [ux, uy, uz] = DIRS[up];
    const sides = DIRS.filter((_, i) => i !== down && i !== up);

    if (id === B.LAVA && this.hardenLava(x, y, z, meta, down)) return;

    let level = fluidLevel(meta);
    let falling = fluidFalling(meta);
    const source = level === 0 && !falling;

    if (!source) {
      // Re-derive this flowing block's state from what feeds it.
      const above = this.get(x + ux, y + uy, z + uz) === id;
      let best = 8, sources = 0;
      for (const [sx, sy, sz] of sides) {
        if (this.get(x + sx, y + sy, z + sz) !== id) continue;
        const m = this.meta(x + sx, y + sy, z + sz);
        const effective = fluidFalling(m) ? 0 : fluidLevel(m);
        if (effective === 0 && !fluidFalling(m)) sources++;
        best = Math.min(best, effective + STEP[id]);
      }
      const below = this.get(x + dx, y + dy, z + dz);
      const belowMeta = this.meta(x + dx, y + dy, z + dz);
      const belowFirm = BLOCKS[below].solid || (below === id && fluidLevel(belowMeta) === 0 && !fluidFalling(belowMeta));
      let newMeta;
      if (id === B.WATER && sources >= 2 && belowFirm) newMeta = encodeFluid(0, false, down);
      else if (above) newMeta = encodeFluid(0, true, down);
      else if (best <= 7) newMeta = encodeFluid(best, false, down);
      else { this.set(x, y, z, B.AIR); return; } // nothing feeds it: dry up
      if (newMeta !== meta) {
        this.set(x, y, z, id, newMeta);
        meta = newMeta;
        level = fluidLevel(meta);
        falling = fluidFalling(meta);
      }
    } else if (fluidDown(meta) !== down) {
      this.set(x, y, z, id, encodeFluid(0, false, down));
    }

    // Fall into the space below. Flowing fluid that can fall, or that's resting on more of the
    // same fluid, doesn't also spread sideways; sources always do.
    const isSource = level === 0 && !falling;
    const bx = x + dx, by = y + dy, bz = z + dz;
    const below = this.get(bx, by, bz);
    if (id === B.LAVA && below === B.WATER) { this.set(bx, by, bz, B.STONE); return; }
    if (this.canFlowInto(bx, by, bz, id, 0)) {
      this.set(bx, by, bz, id, encodeFluid(0, true, down));
      if (!isSource) return;
    } else if (below === id && !isSource) {
      return;
    }

    // Spread sideways.
    const effective = falling ? 0 : level;
    const next = effective + STEP[id];
    if (next > 7) return;
    // Prefer the directions with the shortest way to a drop, judged over every direction the
    // fluid could pass (even ones it already fills), then flow into those it can.
    let preferred = sides.filter(([sx, sy, sz]) => this.canFlowInto(x + sx, y + sy, z + sz, id, 7) || this.get(x + sx, y + sy, z + sz) === id);
    const dist = preferred.map((s) => this.distanceToDrop(x + s[0], y + s[1], z + s[2], id, down, s, SEARCH[id]));
    const nearest = Math.min(...dist);
    if (nearest < Infinity) preferred = preferred.filter((_, i) => dist[i] === nearest);
    for (const [sx, sy, sz] of preferred) {
      if (this.canFlowInto(x + sx, y + sy, z + sz, id, next)) this.set(x + sx, y + sy, z + sz, id, encodeFluid(next, false, down));
    }
  }

  // Steps from (x, y, z) to a spot where fluid could fall, searching sideways (not back the
  // way we came) up to `limit` blocks. Infinity if none.
  distanceToDrop(x, y, z, id, down, from, limit) {
    const [dx, dy, dz] = DIRS[down];
    const sides = DIRS.filter((_, i) => i !== down && i !== (down ^ 1));
    let frontier = [[x, y, z, from]];
    const seen = new Set([x + ',' + y + ',' + z]);
    for (let d = 0; d <= limit && frontier.length; d++) {
      const next = [];
      for (const [px, py, pz, came] of frontier) {
        if (this.canFlowInto(px + dx, py + dy, pz + dz, id, 0)) return d;
        if (d === limit) continue;
        for (const s of sides) {
          if (s[0] === -came[0] && s[1] === -came[1] && s[2] === -came[2]) continue;
          const nx = px + s[0], ny = py + s[1], nz = pz + s[2], key = nx + ',' + ny + ',' + nz;
          if (seen.has(key) || !this.canFlowInto(nx, ny, nz, id, 7)) continue;
          seen.add(key);
          next.push([nx, ny, nz, s]);
        }
      }
      frontier = next;
    }
    return Infinity;
  }

  // Lava touching water (anywhere but below it) hardens. Returns true if it did.
  hardenLava(x, y, z, meta, down) {
    for (let i = 0; i < 6; i++) {
      if (i === down) continue;
      const [dx, dy, dz] = DIRS[i];
      if (this.get(x + dx, y + dy, z + dz) !== B.WATER) continue;
      const source = fluidLevel(meta) === 0 && !fluidFalling(meta);
      this.set(x, y, z, source ? B.OBSIDIAN : B.COBBLE);
      return true;
    }
    return false;
  }
}
