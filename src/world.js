// Chunked voxel world: terrain generation, block storage, and mesh building.
//
// The world is infinite on all three axes and stored in cubic chunks. For now the
// terrain is a finite layer (y = 0 .. TERRAIN_HEIGHT) floating in otherwise empty space.
import * as THREE from 'three';
import { B, BLOCKS } from './blocks.js';
import { Noise, hash3 } from './noise.js';
import { ATLAS } from './textures.js';

export const CS = 32;              // chunk edge length on every axis
export const TERRAIN_HEIGHT = 96;  // terrain occupies 0 <= y < TERRAIN_HEIGHT
export const WATER_LEVEL = 30;
const SNOW_LINE = 64;
const CS3 = CS * CS * CS;
const MARGIN = 2;                  // columns sampled beyond a chunk edge so trees can spill in
const COL = CS + 2 * MARGIN;

const idx = (x, y, z) => (y * CS + z) * CS + x;

// Faces with corner positions and UVs, wound counter-clockwise when viewed from outside.
const FACES = [
  { dir: [-1, 0, 0], shade: 0.75, corners: [[0, 1, 0, 0, 1], [0, 0, 0, 0, 0], [0, 1, 1, 1, 1], [0, 0, 1, 1, 0]] },
  { dir: [1, 0, 0], shade: 0.75, corners: [[1, 1, 1, 0, 1], [1, 0, 1, 0, 0], [1, 1, 0, 1, 1], [1, 0, 0, 1, 0]] },
  { dir: [0, -1, 0], shade: 0.55, corners: [[1, 0, 1, 1, 0], [0, 0, 1, 0, 0], [1, 0, 0, 1, 1], [0, 0, 0, 0, 1]] },
  { dir: [0, 1, 0], shade: 1.0, corners: [[0, 1, 1, 1, 1], [1, 1, 1, 0, 1], [0, 1, 0, 1, 0], [1, 1, 0, 0, 0]] },
  { dir: [0, 0, -1], shade: 0.88, corners: [[1, 0, 0, 0, 0], [0, 0, 0, 1, 0], [1, 1, 0, 0, 1], [0, 1, 0, 1, 1]] },
  { dir: [0, 0, 1], shade: 0.88, corners: [[0, 0, 1, 0, 0], [1, 0, 1, 1, 0], [0, 1, 1, 0, 1], [1, 1, 1, 1, 1]] },
];
const AO_CURVE = [0.45, 0.62, 0.8, 1.0];
const UV_EPS = 0.001;

// Padded chunk buffer used while meshing: the chunk plus a one-block border.
const P = CS + 2;
const PY = P * P;
const PAD = new Uint8Array(P * P * P);
const pidx = (x, y, z) => (y + 1) * PY + (z + 1) * P + (x + 1);

// Per-block flag tables, faster than reading BLOCKS[id].flag in the meshing loop.
const flagTable = (key) => Uint8Array.from({ length: 256 }, (_, id) => (BLOCKS[id]?.[key] ? 1 : 0));
const OPAQUE = flagTable('opaque');
const OCCLUDES = flagTable('occludes');
const LIQUID = flagTable('liquid');
const SOLID = flagTable('solid');
const SELF_FACES = flagTable('selfFaces');

// Precompute per-face neighbour offsets, per-corner AO sample offsets, UVs, and lighting.
for (const f of FACES) {
  const [dx, dy, dz] = f.dir;
  const step = (x, y, z) => y * PY + z * P + x;
  f.offset = step(dx, dy, dz);
  // Vertex colours are linear; convert so the shading reads correctly after sRGB output.
  f.light = AO_CURVE.map((a) => Math.pow(f.shade * a, 2.2));
  f.corners = f.corners.map(([x, y, z, u, v]) => {
    // Step toward this corner along the two axes that lie in the face's plane.
    const ax = dx === 0 ? (x ? 1 : -1) : 0;
    const ay = dy === 0 ? (y ? 1 : -1) : 0;
    const az = dz === 0 ? (z ? 1 : -1) : 0;
    const [side1, side2] = dx !== 0 ? [step(0, ay, 0), step(0, 0, az)]
      : dy !== 0 ? [step(ax, 0, 0), step(0, 0, az)]
        : [step(ax, 0, 0), step(0, ay, 0)];
    return {
      x, y, z,
      u: UV_EPS + u * (1 - 2 * UV_EPS),
      v: UV_EPS + v * (1 - 2 * UV_EPS),
      side1, side2, diag: step(ax, ay, az),
    };
  });
}

class Chunk {
  constructor(cx, cy, cz) {
    this.cx = cx;
    this.cy = cy;
    this.cz = cz;
    this.data = null; // null means the chunk is entirely air
    this.dirty = true;
    this.mesh = null;
    this.waterMesh = null;
  }
}

class GeometryBuilder {
  constructor() { this.pos = []; this.uv = []; this.col = []; this.ind = []; }
  get count() { return this.pos.length / 3; }
  build() {
    if (this.ind.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.ind);
    g.computeBoundingSphere();
    return g;
  }
}

export class World {
  constructor(scene, material, waterMaterial, seed, savedEdits, renderDistance = 6) {
    this.scene = scene;
    this.material = material;
    this.waterMaterial = waterMaterial;
    this.seed = seed;
    this.noise = new Noise(seed);
    this.caveNoiseA = new Noise(seed + 1);
    this.caveNoiseB = new Noise(seed + 2);
    this.chunks = new Map();
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

  key(cx, cy, cz) { return cx + ',' + cy + ',' + cz; }

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

  // ---------- block access ----------

  getChunkAt(x, y, z) {
    return this.chunks.get(this.key(Math.floor(x / CS), Math.floor(y / CS), Math.floor(z / CS)));
  }

  getBlock(x, y, z) {
    const cx = Math.floor(x / CS), cy = Math.floor(y / CS), cz = Math.floor(z / CS);
    const c = this.chunks.get(this.key(cx, cy, cz));
    if (!c || !c.data) return B.AIR;
    return c.data[idx(x - cx * CS, y - cy * CS, z - cz * CS)];
  }

  setBlock(x, y, z, id) {
    const cx = Math.floor(x / CS), cy = Math.floor(y / CS), cz = Math.floor(z / CS);
    const key = this.key(cx, cy, cz);
    const c = this.chunks.get(key);
    if (!c) return false;
    const lx = x - cx * CS, ly = y - cy * CS, lz = z - cz * CS;
    const i = idx(lx, ly, lz);
    if (!c.data) c.data = new Uint8Array(CS3);
    c.data[i] = id;
    let e = this.edits.get(key);
    if (!e) { e = new Map(); this.edits.set(key, e); }
    e.set(i, id);

    // Rebuild this chunk and any neighbour whose faces or AO touch the edited block.
    const near = (l) => (l === 0 ? [0, -1] : l === CS - 1 ? [0, 1] : [0]);
    for (const dx of near(lx)) for (const dy of near(ly)) for (const dz of near(lz)) {
      const n = this.chunks.get(this.key(cx + dx, cy + dy, cz + dz));
      if (n) this.buildMesh(n);
    }
    return true;
  }

  serializeEdits() {
    const out = {};
    for (const [key, map] of this.edits) out[key] = [...map];
    return out;
  }

  // Voxel DDA raycast. Returns the first non-liquid block hit and the face normal.
  raycast(origin, dir, maxDist) {
    let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
    const sx = Math.sign(dir.x), sy = Math.sign(dir.y), sz = Math.sign(dir.z);
    const tdx = sx ? Math.abs(1 / dir.x) : Infinity;
    const tdy = sy ? Math.abs(1 / dir.y) : Infinity;
    const tdz = sz ? Math.abs(1 / dir.z) : Infinity;
    let tmx = sx > 0 ? (x + 1 - origin.x) * tdx : sx < 0 ? (origin.x - x) * tdx : Infinity;
    let tmy = sy > 0 ? (y + 1 - origin.y) * tdy : sy < 0 ? (origin.y - y) * tdy : Infinity;
    let tmz = sz > 0 ? (z + 1 - origin.z) * tdz : sz < 0 ? (origin.z - z) * tdz : Infinity;
    let nx = 0, ny = 0, nz = 0, t = 0;
    while (t <= maxDist) {
      const b = this.getBlock(x, y, z);
      if (b !== B.AIR && !BLOCKS[b].liquid) return { x, y, z, nx, ny, nz, id: b };
      if (tmx < tmy && tmx < tmz) { x += sx; t = tmx; tmx += tdx; nx = -sx; ny = 0; nz = 0; }
      else if (tmy < tmz) { y += sy; t = tmy; tmy += tdy; nx = 0; ny = -sy; nz = 0; }
      else { z += sz; t = tmz; tmz += tdz; nx = 0; ny = 0; nz = -sz; }
    }
    return null;
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

  disposeMeshes(c) {
    for (const m of [c.mesh, c.waterMesh]) {
      if (m) { this.scene.remove(m); m.geometry.dispose(); }
    }
    c.mesh = c.waterMesh = null;
  }

  // ---------- meshing ----------

  buildMesh(c) {
    const data = c.data;
    c.dirty = false;
    if (!data) { this.disposeMeshes(c); return; }
    const ox = c.cx * CS, oy = c.cy * CS, oz = c.cz * CS;

    // Copy the chunk plus a one-block border from its neighbours into a padded buffer so
    // every neighbour lookup below is a plain array read.
    const pad = PAD;
    for (let y = 0; y < CS; y++) {
      for (let z = 0; z < CS; z++) {
        const i = idx(0, y, z);
        pad.set(data.subarray(i, i + CS), pidx(0, y, z));
      }
    }
    for (let y = -1; y <= CS; y++) {
      const yEdge = y === -1 || y === CS;
      for (let z = -1; z <= CS; z++) {
        const zEdge = z === -1 || z === CS;
        for (let x = -1; x <= CS; x++) {
          if (yEdge || zEdge || x === -1 || x === CS) pad[pidx(x, y, z)] = this.getBlock(ox + x, oy + y, oz + z);
        }
      }
    }

    const solid = new GeometryBuilder();
    const water = new GeometryBuilder();
    const aos = [0, 0, 0, 0];

    // Vertices are chunk-local (the mesh is positioned at the chunk origin) so that
    // float precision holds up far from the world origin.
    for (let y = 0; y < CS; y++) {
      for (let z = 0; z < CS; z++) {
        let i = idx(0, y, z), p = pidx(0, y, z);
        for (let x = 0; x < CS; x++, i++, p++) {
          const b = data[i];
          if (b === B.AIR) continue;
          const liquid = LIQUID[b], opaque = OPAQUE[b];
          const def = BLOCKS[b];
          const lowerTop = liquid && pad[p + PY] !== B.WATER;

          for (let fi = 0; fi < 6; fi++) {
            const f = FACES[fi];
            const q = p + f.offset;
            const nb = pad[q];
            let visible;
            if (liquid) visible = !OPAQUE[nb] && !LIQUID[nb] && !(SOLID[nb] && f.dir[1] === 0);
            else if (opaque) visible = !OPAQUE[nb];
            else visible = !OPAQUE[nb] && (nb !== b || SELF_FACES[b]);
            if (!visible) continue;

            const dy = f.dir[1];
            const tile = dy === 1 ? def.top : dy === -1 ? def.bottom : def.side;
            const tu = tile % ATLAS, tv = Math.floor(tile / ATLAS);
            const g = liquid ? water : solid;
            const base = g.count;

            for (let k = 0; k < 4; k++) {
              const corner = f.corners[k];
              g.pos.push(x + corner.x, y + corner.y - (lowerTop && corner.y === 1 ? 0.12 : 0), z + corner.z);
              g.uv.push((tu + corner.u) / ATLAS, 1 - (tv + 1 - corner.v) / ATLAS);
              let ao = 3;
              if (!liquid) {
                const s1 = OCCLUDES[pad[q + corner.side1]], s2 = OCCLUDES[pad[q + corner.side2]];
                ao = s1 && s2 ? 0 : 3 - (s1 + s2 + OCCLUDES[pad[q + corner.diag]]);
              }
              aos[k] = ao;
              const l = f.light[ao];
              g.col.push(l, l, l);
            }

            if (aos[0] + aos[3] > aos[1] + aos[2]) {
              g.ind.push(base, base + 1, base + 3, base, base + 3, base + 2);
            } else {
              g.ind.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
            }
          }
        }
      }
    }

    this.disposeMeshes(c);
    const sg = solid.build();
    if (sg) {
      c.mesh = new THREE.Mesh(sg, this.material);
      c.mesh.position.set(ox, oy, oz);
      this.scene.add(c.mesh);
    }
    const wg = water.build();
    if (wg) {
      c.waterMesh = new THREE.Mesh(wg, this.waterMaterial);
      c.waterMesh.position.set(ox, oy, oz);
      c.waterMesh.renderOrder = 1;
      this.scene.add(c.waterMesh);
    }
  }
}
