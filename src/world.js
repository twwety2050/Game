// The static world: terrain generation, chunk streaming, and persisted edits.
//
// The world is infinite on all three axes and stored in cubic chunks. For now the
// terrain is a finite layer (y = 0 .. TERRAIN_HEIGHT) floating in otherwise empty space.
import { B } from './blocks.js';
import { Noise, hash3 } from './noise.js';
import { VoxelGrid, Chunk, CS, CS3, idx } from './grid.js';

export { CS };
export const TERRAIN_HEIGHT = 96;  // terrain occupies 0 <= y < TERRAIN_HEIGHT
export const WATER_LEVEL = 30;
const SNOW_LINE = 64;
const MARGIN = 2;                  // columns sampled beyond a chunk edge so trees can spill in
const COL = CS + 2 * MARGIN;

export class World extends VoxelGrid {
  constructor(scene, material, waterMaterial, seed, savedEdits, renderDistance = 6) {
    super(scene, material, waterMaterial);
    this.seed = seed;
    this.noise = new Noise(seed);
    this.caveNoiseA = new Noise(seed + 1);
    this.caveNoiseB = new Noise(seed + 2);
    this.columns = new Map(); // cached heightmaps and trees per (cx, cz) column
    this.edits = new Map(); // chunk key -> Map(local index -> block id)
    if (savedEdits) {
      for (const [key, list] of Object.entries(savedEdits)) this.edits.set(key, new Map(list));
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

  height(x, z) {
    const n = this.noise;
    const continent = n.fbm2(x * 0.0035, z * 0.0035, 4);
    const hills = n.fbm2(x * 0.015 + 100, z * 0.015 + 100, 4);
    const mountain = Math.max(0, n.fbm2(x * 0.006 - 300, z * 0.006 - 300, 3) - 0.1);
    const h = WATER_LEVEL + 2 + continent * 18 + hills * 6 + mountain * mountain * 160;
    return Math.max(4, Math.min(TERRAIN_HEIGHT - 12, Math.floor(h)));
  }

  surfaceBlock(h) {
    if (h <= WATER_LEVEL + 1) return B.SAND;
    if (h >= SNOW_LINE) return B.SNOW;
    return B.GRASS;
  }

  isTree(x, z, h) {
    if (this.surfaceBlock(h) !== B.GRASS) return false;
    const forest = this.noise.noise2(x * 0.01 + 500, z * 0.01 + 500);
    const chance = 0.002 + 0.03 * Math.max(0, forest);
    return hash3(x, 0, z, this.seed) < chance;
  }

  // Heightmap and tree list for a column of chunks, shared by every chunk stacked in it.
  column(cx, cz) {
    const key = cx + ',' + cz;
    let col = this.columns.get(key);
    if (col) return col;
    const heights = new Int16Array(COL * COL);
    const trees = [];
    const ox = cx * CS - MARGIN, oz = cz * CS - MARGIN;
    for (let z = 0; z < COL; z++) {
      for (let x = 0; x < COL; x++) {
        const wx = ox + x, wz = oz + z;
        const h = this.height(wx, wz);
        heights[z * COL + x] = h;
        if (this.isTree(wx, wz, h)) {
          trees.push({ x: x - MARGIN, z: z - MARGIN, h, trunk: 4 + Math.floor(hash3(wx, 1, wz, this.seed) * 3) });
        }
      }
    }
    col = { heights, trees };
    this.columns.set(key, col);
    if (this.columns.size > 1024) this.columns.delete(this.columns.keys().next().value);
    return col;
  }

  generate(c) {
    const ox = c.cx * CS, oy = c.cy * CS, oz = c.cz * CS;
    const edits = this.edits.get(this.key(c.cx, c.cy, c.cz));
    const hasTerrain = oy < TERRAIN_HEIGHT && oy + CS > 0;
    if (!hasTerrain && !edits) return;

    const d = new Uint8Array(CS3);
    const seed = this.seed;

    if (hasTerrain) {
      const { heights, trees } = this.column(c.cx, c.cz);
      for (let z = 0; z < CS; z++) {
        for (let x = 0; x < CS; x++) {
          const wx = ox + x, wz = oz + z;
          const h = heights[(z + MARGIN) * COL + x + MARGIN];
          const surface = this.surfaceBlock(h);
          const filler = h <= WATER_LEVEL + 1 ? B.SAND : B.DIRT;
          const caveCeiling = h <= WATER_LEVEL + 3 ? h - 6 : h;
          const top = Math.min(Math.max(h, WATER_LEVEL), oy + CS - 1);
          for (let y = Math.max(0, oy); y <= top; y++) {
            let b;
            if (y === 0) b = B.BEDROCK;
            else if (y < h - 3) {
              b = B.STONE;
              const r = hash3(wx, y, wz, seed);
              if (y < 50 && r < 0.012) b = B.COAL_ORE;
              else if (y < 28 && r < 0.02) b = B.IRON_ORE;
            } else if (y < h) b = h >= SNOW_LINE ? B.STONE : filler;
            else if (y === h) b = surface;
            else b = B.WATER;

            if (b !== B.WATER && y > 2 && y <= caveCeiling) {
              const a = this.caveNoiseA.noise3(wx * 0.045, y * 0.07, wz * 0.045);
              if (Math.abs(a) < 0.09) {
                const bn = this.caveNoiseB.noise3(wx * 0.045, y * 0.07, wz * 0.045);
                if (Math.abs(bn) < 0.09) b = B.AIR;
              }
            }
            d[idx(x, y - oy, z)] = b;
          }
        }
      }

      // Trees, including canopies spilling in from neighbouring columns.
      const inside = (x, y, z) => x >= 0 && x < CS && z >= 0 && z < CS && y >= 0 && y < CS;
      for (const t of trees) {
        const wx = ox + t.x, wz = oz + t.z;
        for (let dy = t.trunk - 2; dy <= t.trunk + 1; dy++) {
          const r = dy >= t.trunk ? 1 : 2;
          for (let dz = -r; dz <= r; dz++) {
            for (let dx = -r; dx <= r; dx++) {
              if (r === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2 && hash3(wx + dx, dy, wz + dz, seed) < 0.6) continue;
              if (dy === t.trunk + 1 && Math.abs(dx) + Math.abs(dz) > 1) continue;
              const lx = t.x + dx, ly = t.h + dy - oy, lz = t.z + dz;
              if (!inside(lx, ly, lz)) continue;
              const i = idx(lx, ly, lz);
              if (d[i] === B.AIR) d[i] = B.LEAVES;
            }
          }
        }
        for (let dy = 0; dy <= t.trunk; dy++) {
          const ly = t.h + dy - oy;
          if (inside(t.x, ly, t.z)) d[idx(t.x, ly, t.z)] = dy === 0 ? B.DIRT : B.LOG;
        }
      }
    }

    if (edits) for (const [i, b] of edits) d[i] = b;
    if (d.some((b) => b !== B.AIR)) c.data = d;
  }

  findSpawn() {
    for (let r = 0; r < 400; r += 4) {
      for (let a = 0; a < 16; a++) {
        const x = Math.round(Math.cos((a / 16) * Math.PI * 2) * r);
        const z = Math.round(Math.sin((a / 16) * Math.PI * 2) * r);
        const h = this.height(x, z);
        if (h > WATER_LEVEL + 1 && h < SNOW_LINE) return { x: x + 0.5, y: h + 1, z: z + 0.5 };
      }
    }
    return { x: 0.5, y: TERRAIN_HEIGHT, z: 0.5 };
  }

  // Remember every edit so chunks regenerate with it after being unloaded.
  onBlockChanged(_x, _y, _z, _old, id, key, i) {
    let e = this.edits.get(key);
    if (!e) { e = new Map(); this.edits.set(key, e); }
    e.set(i, id);
  }

  serializeEdits() {
    const out = {};
    for (const [key, map] of this.edits) out[key] = [...map];
    return out;
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
