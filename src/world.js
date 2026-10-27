// The static world: a solar system generated from the seed, chunk streaming, and saved edits.
//
// The world is infinite on all three axes and stored in cubic chunks. It is mostly empty
// space holding a few celestial bodies: a star at the origin and planets around it. Each body
// is a rounded cube (a superellipsoid) with a noisy, contoured surface and a gravity core at
// its centre. Bodies pull with full gravity across their whole surface, fading to nothing
// GRAVITY_REACH blocks above it (see gravity.js).
import { B } from './blocks.js';
import { Noise, hash3, mulberry32 } from './noise.js';
import { VoxelGrid, Chunk, CS, CS3, idx } from './grid.js';
import { encodeFluid } from './fluids.js';
import { dirIndex } from './shapes.js';

export { CS };
export const GRAVITY_REACH = 50;  // blocks above a planet's surface where its gravity fades out
const MEDIUM_PLANET = 20;         // half-size of a planet with normal (100%) surface gravity
const ROUNDNESS = 4;              // superellipsoid exponent: 2 = sphere, higher = boxier
// Seas: which fluid fills each kind of planet's low ground, and how high (as a fraction of
// the planet's half-size, measured straight out from each face).
const SEAS = { verdant: [B.WATER, 0.965], volcanic: [B.LAVA, 0.95] };

// Planets: name, kind, half-size (blocks), and orbit radius around the star.
const PLANETS = [
  ['Ferrum', 'rocky', 12, 230],
  ['Gaia', 'verdant', 20, 340],
  ['Dune', 'desert', 30, 480],
  ['Rime', 'ice', 20, 640],
  ['Cinder', 'volcanic', 14, 780],
];
export const HOME_PLANET = 'Gaia';

export class World extends VoxelGrid {
  constructor(scene, materials, seed, saved = {}, renderDistance = 6) {
    super(scene, materials);
    this.seed = seed;
    this.noise = new Noise(seed);
    this.bodies = makeBodies(seed);
    this.edits = new Map();  // chunk key -> Map(local index -> block id | meta << 8)
    this.damage = new Map(); // chunk key -> Map(local index -> damage), shared with loaded chunks
    for (const [key, list] of Object.entries(saved.edits ?? {})) this.edits.set(key, new Map(list));
    for (const [key, list] of Object.entries(saved.damage ?? {})) this.damage.set(key, new Map(list));
    // Gravity generators only ever come from edits, so index them up front: they keep
    // working even while their chunk isn't loaded.
    for (const [key, map] of this.edits) {
      const [cx, cy, cz] = key.split(',').map(Number);
      for (const [i, v] of map) {
        this.indexGravity(cx * CS + (i % CS), cy * CS + Math.floor(i / (CS * CS)), cz * CS + (Math.floor(i / CS) % CS), v & 255, v >> 8);
      }
    }
    this.setRenderDistance(renderDistance);
  }

  setRenderDistance(r) {
    this.renderDistance = r;
    // Offsets sorted by distance so the closest chunks load first. One extra shell holds
    // data-only chunks so border faces of meshed chunks can be culled correctly.
    const offsets = [];
    for (let dx = -r - 1; dx <= r + 1; dx++) {
      for (let dy = -r - 1; dy <= r + 1; dy++) {
        for (let dz = -r - 1; dz <= r + 1; dz++) {
          const dist = Math.hypot(dx, dy, dz);
          if (dist <= r + 1.5) offsets.push([dx, dy, dz, dist]);
        }
      }
    }
    offsets.sort((a, b) => a[3] - b[3]);
    this.offsets = offsets;
  }

  // ---------- generation ----------

  // How far inside body `b` the block centre (x, y, z) is, in blocks (negative = outside).
  // The surface is a superellipsoid pushed in and out by noise, so edges are rounded and
  // faces are gently contoured.
  depthIn(b, x, y, z) {
    const dx = x + 0.5 - b.center[0], dy = y + 0.5 - b.center[1], dz = z + 0.5 - b.center[2];
    const shape = Math.pow(Math.abs(dx) ** ROUNDNESS + Math.abs(dy) ** ROUNDNESS + Math.abs(dz) ** ROUNDNESS, 1 / ROUNDNESS) / b.R;
    if (shape < 0.85) return (1 - shape) * b.R; // deep inside: skip the noise
    if (shape > 1.2) return -1;
    const n = this.noise;
    const contour = 1 + 0.07 * n.noise3(x * 0.05 + b.seed, y * 0.05, z * 0.05) + 0.03 * n.noise3(x * 0.14, y * 0.14 + b.seed, z * 0.14);
    return (contour - shape) * b.R;
  }

  // Block at depth d inside body b.
  material(b, x, y, z, d) {
    if (b.kind === 'star') return B.STAR;
    const ore = hash3(x, y, z, this.seed);
    const stone = ore < (b.kind === 'rocky' ? 0.03 : 0.012) ? B.COAL_ORE : ore < (b.kind === 'rocky' ? 0.05 : 0.02) ? B.IRON_ORE : B.STONE;
    switch (b.kind) {
      case 'verdant': return d < 1 ? B.TURF : d < 4 ? B.DIRT : stone;
      case 'desert': return d < 5 ? B.SAND : stone;
      case 'ice': return d < 3 ? B.SNOW_BLOCK : stone;
      case 'volcanic': return d < 1 ? (ore < 0.3 ? B.OBSIDIAN : B.COBBLE) : stone;
      default: return d < 1 ? B.COBBLE : stone;
    }
  }

  // If (x, y, z) is above body b's ground but below its sea level, the sea's fluid and its
  // meta (a source whose "down" points into the face it lies on); else null. The sea surface
  // is flat on each face of the planet.
  seaAt(b, x, y, z) {
    const sea = SEAS[b.kind];
    if (!sea) return null;
    const dx = x + 0.5 - b.center[0], dy = y + 0.5 - b.center[1], dz = z + 0.5 - b.center[2];
    const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
    if (Math.max(ax, ay, az) > b.R * sea[1]) return null;
    // Stay within the planet's rounded outline, so seas don't spill off its edges.
    if (Math.pow(ax ** ROUNDNESS + ay ** ROUNDNESS + az ** ROUNDNESS, 1 / ROUNDNESS) > b.R) return null;
    const down = ax >= ay && ax >= az ? dirIndex(-Math.sign(dx), 0, 0) : ay >= az ? dirIndex(0, -Math.sign(dy), 0) : dirIndex(0, 0, -Math.sign(dz));
    return [sea[0], encodeFluid(0, false, down)];
  }

  generate(c) {
    const ox = c.cx * CS, oy = c.cy * CS, oz = c.cz * CS;
    const key = this.key(c.cx, c.cy, c.cz);
    const edits = this.edits.get(key);
    c.damage = this.damage.get(key) ?? null;
    const bodies = this.bodies.filter((b) => {
      const reach = b.R * 1.15 + 2;
      return ox + CS > b.center[0] - reach && ox < b.center[0] + reach &&
        oy + CS > b.center[1] - reach && oy < b.center[1] + reach &&
        oz + CS > b.center[2] - reach && oz < b.center[2] + reach;
    });
    if (bodies.length === 0 && !edits) return;

    const d = new Uint8Array(CS3);
    for (const b of bodies) {
      const reach = b.R * 1.15 + 2;
      const x0 = Math.max(ox, Math.floor(b.center[0] - reach)), x1 = Math.min(ox + CS, Math.ceil(b.center[0] + reach));
      const y0 = Math.max(oy, Math.floor(b.center[1] - reach)), y1 = Math.min(oy + CS, Math.ceil(b.center[1] + reach));
      const z0 = Math.max(oz, Math.floor(b.center[2] - reach)), z1 = Math.min(oz + CS, Math.ceil(b.center[2] + reach));
      for (let y = y0; y < y1; y++) {
        for (let z = z0; z < z1; z++) {
          for (let x = x0; x < x1; x++) {
            const depth = this.depthIn(b, x, y, z);
            if (depth < 0) {
              const sea = this.seaAt(b, x, y, z);
              if (!sea) continue;
              const i = idx(x - ox, y - oy, z - oz);
              d[i] = sea[0];
              if (!c.meta) c.meta = new Uint8Array(CS3);
              c.meta[i] = sea[1];
              continue;
            }
            const core = x === b.center[0] && y === b.center[1] && z === b.center[2];
            d[idx(x - ox, y - oy, z - oz)] = core ? B.GRAVITY_CORE : this.material(b, x, y, z, depth);
          }
        }
      }
    }

    if (edits) {
      for (const [i, v] of edits) {
        d[i] = v & 255;
        const meta = v >> 8;
        if (meta && !c.meta) c.meta = new Uint8Array(CS3);
        if (c.meta) c.meta[i] = meta;
      }
    }
    if (d.some((v) => v !== B.AIR)) c.data = d;
  }

  bodyNamed(name) {
    return this.bodies.find((b) => b.name === name);
  }

  // The body whose gravity you're in (or nearest to), with your altitude above its surface.
  nearestBody(p) {
    let best = null, bestAlt = Infinity;
    for (const b of this.bodies) {
      const alt = Math.hypot(p.x - b.center[0], p.y - b.center[1], p.z - b.center[2]) - b.R;
      if (alt < bestAlt) { bestAlt = alt; best = b; }
    }
    return { body: best, altitude: bestAlt };
  }

  // Where a new player starts: in open space just beyond the home planet's gravity, on the
  // side facing away from the star, so both are in view. Returns the point and the direction
  // toward the planet.
  findSpawn() {
    const home = this.bodyNamed(HOME_PLANET);
    const out = [home.center[0], home.center[1], home.center[2]];
    const len = Math.hypot(...out) || 1;
    const dir = out.map((v) => v / len);
    const dist = home.range + 20;
    return {
      position: out.map((v, i) => v + dir[i] * dist),
      toward: dir.map((v) => -v),
    };
  }

  // Remember every edit so chunks regenerate with it after being unloaded.
  onBlockChanged(x, y, z, _old, id, key, i, meta) {
    let e = this.edits.get(key);
    if (!e) { e = new Map(); this.edits.set(key, e); }
    e.set(i, id | (meta << 8));
    this.onEdit?.(x, y, z); // lets the fluids react
  }

  onDamageMapCreated(key, map) {
    this.damage.set(key, map);
  }

  serialize() {
    const edits = {}, damage = {};
    for (const [key, map] of this.edits) edits[key] = [...map];
    for (const [key, map] of this.damage) if (map.size) damage[key] = [...map];
    return { edits, damage };
  }

  // ---------- streaming ----------

  update(px, py, pz, budgetMs = 6) {
    const pcx = Math.floor(px / CS), pcy = Math.floor(py / CS), pcz = Math.floor(pz / CS);
    const start = performance.now();
    const r = this.renderDistance;

    for (const [dx, dy, dz, dist] of this.offsets) {
      if (performance.now() - start > budgetMs) break;
      const cx = pcx + dx, cy = pcy + dy, cz = pcz + dz;
      const key = this.key(cx, cy, cz);
      let c = this.chunks.get(key);
      if (!c) {
        c = new Chunk(cx, cy, cz);
        this.generate(c);
        this.chunks.set(key, c);
      }
      if (c.dirty && dist <= r + 0.5 && this.hasNeighbours(cx, cy, cz)) this.buildMesh(c);
    }

    if (performance.now() - start < budgetMs) {
      const far = r + 3;
      for (const [key, c] of this.chunks) {
        if (Math.abs(c.cx - pcx) > far || Math.abs(c.cy - pcy) > far || Math.abs(c.cz - pcz) > far) {
          this.disposeMeshes(c);
          this.chunks.delete(key);
        }
      }
    }
  }

  hasNeighbours(cx, cy, cz) {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      if (!this.chunks.has(this.key(cx + dx, cy + dy, cz + dz))) return false;
    }
    return true;
  }
}

// The star and planets for a seed. Gravity: each body pulls at `surfaceG` (1 = normal) out to
// `full` blocks from its centre (just past its furthest surface point), fading to nothing at
// `range`. Surface gravity scales with size, like real planets of the same density.
function makeBodies(seed) {
  const rand = mulberry32(seed ^ 0x5eed);
  const body = (name, kind, R, center) => {
    // Distance to the furthest surface point (a corner, pushed out by the contours).
    const full = Math.ceil(R * Math.pow(3, 1 / 2 - 1 / ROUNDNESS) * 1.1) + 2;
    return {
      name, kind, R, center, seed: rand() * 1000,
      surfaceG: kind === 'star' ? 2 : R / MEDIUM_PLANET,
      full,
      range: full + (kind === 'star' ? 3 * GRAVITY_REACH : GRAVITY_REACH),
    };
  };
  const bodies = [body('Sol', 'star', 36, [0, 0, 0])];
  for (const [name, kind, R, orbit] of PLANETS) {
    const angle = rand() * Math.PI * 2;
    const y = Math.round((rand() - 0.5) * 60);
    bodies.push(body(name, kind, R, [Math.round(Math.cos(angle) * orbit), y, Math.round(Math.sin(angle) * orbit)]));
  }
  return bodies;
}
