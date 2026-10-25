// Chunked voxel world: terrain generation, block storage, and mesh building.
import * as THREE from 'three';
import { B, BLOCKS } from './blocks.js';
import { Noise, hash3 } from './noise.js';
import { ATLAS } from './textures.js';

export const CS = 16;        // chunk size (x/z)
export const CH = 96;        // world height
export const WATER_LEVEL = 30;
const SNOW_LINE = 64;

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

class Chunk {
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.data = new Uint8Array(CS * CS * CH);
    this.maxY = 0;
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
    this.edits = new Map(); // chunk key -> Map(local index -> block id)
    if (savedEdits) {
      for (const [key, list] of Object.entries(savedEdits)) this.edits.set(key, new Map(list));
    }
    this.setRenderDistance(renderDistance);
  }

  setRenderDistance(r) {
    this.renderDistance = r;
    // Offsets sorted by distance so the closest chunks load first. One extra ring holds
    // data-only chunks so border faces of meshed chunks can be culled correctly.
    const offsets = [];
    for (let dx = -r - 1; dx <= r + 1; dx++) {
      for (let dz = -r - 1; dz <= r + 1; dz++) {
        if (dx * dx + dz * dz <= (r + 1.5) * (r + 1.5)) offsets.push([dx, dz, Math.hypot(dx, dz)]);
      }
    }
    offsets.sort((a, b) => a[2] - b[2]);
    this.offsets = offsets;
  }

  key(cx, cz) { return cx + ',' + cz; }

  // ---------- generation ----------

  height(x, z) {
    const n = this.noise;
    const continent = n.fbm2(x * 0.0035, z * 0.0035, 4);
    const hills = n.fbm2(x * 0.015 + 100, z * 0.015 + 100, 4);
    const mountain = Math.max(0, n.fbm2(x * 0.006 - 300, z * 0.006 - 300, 3) - 0.1);
    const h = WATER_LEVEL + 2 + continent * 18 + hills * 6 + mountain * mountain * 160;
    return Math.max(4, Math.min(CH - 12, Math.floor(h)));
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

  generate(c) {
    const d = c.data;
    const ox = c.cx * CS, oz = c.cz * CS;
    const seed = this.seed;

    for (let z = 0; z < CS; z++) {
      for (let x = 0; x < CS; x++) {
        const wx = ox + x, wz = oz + z;
        const h = this.height(wx, wz);
        const surface = this.surfaceBlock(h);
        const filler = h <= WATER_LEVEL + 1 ? B.SAND : B.DIRT;
        const caveCeiling = h <= WATER_LEVEL + 3 ? h - 6 : h;
        const top = Math.max(h, WATER_LEVEL);
        for (let y = 0; y <= top; y++) {
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
          d[idx(x, y, z)] = b;
        }
      }
    }

    // Trees: scan a margin around the chunk so canopies from neighbours spill in.
    for (let tz = -2; tz < CS + 2; tz++) {
      for (let tx = -2; tx < CS + 2; tx++) {
        const wx = ox + tx, wz = oz + tz;
        const h = this.height(wx, wz);
        if (!this.isTree(wx, wz, h)) continue;
        const trunk = 4 + Math.floor(hash3(wx, 1, wz, seed) * 3);
        const inside = (x, z) => x >= 0 && x < CS && z >= 0 && z < CS;
        for (let dy = trunk - 2; dy <= trunk + 1; dy++) {
          const r = dy >= trunk ? 1 : 2;
          for (let dz = -r; dz <= r; dz++) {
            for (let dx = -r; dx <= r; dx++) {
              if (r === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2 && hash3(wx + dx, dy, wz + dz, seed) < 0.6) continue;
              if (dy === trunk + 1 && Math.abs(dx) + Math.abs(dz) > 1) continue;
              const lx = tx + dx, lz = tz + dz, y = h + dy;
              if (!inside(lx, lz) || y >= CH) continue;
              const i = idx(lx, y, lz);
              if (d[i] === B.AIR) d[i] = B.LEAVES;
            }
          }
        }
        if (inside(tx, tz)) {
          d[idx(tx, h, tz)] = B.DIRT;
          for (let dy = 1; dy <= trunk; dy++) d[idx(tx, h + dy, tz)] = B.LOG;
        }
      }
    }

    const edits = this.edits.get(this.key(c.cx, c.cz));
    if (edits) for (const [i, b] of edits) d[i] = b;

    let maxY = 0;
    for (let i = d.length - 1; i >= 0; i--) {
      if (d[i]) { maxY = Math.floor(i / (CS * CS)); break; }
    }
    c.maxY = maxY;
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
    return { x: 0.5, y: CH - 10, z: 0.5 };
  }

  // ---------- block access ----------

  getChunkAt(x, z) {
    return this.chunks.get(this.key(Math.floor(x / CS), Math.floor(z / CS)));
  }

  getBlock(x, y, z) {
    if (y < 0) return B.BEDROCK;
    if (y >= CH) return B.AIR;
    const cx = Math.floor(x / CS), cz = Math.floor(z / CS);
    const c = this.chunks.get(this.key(cx, cz));
    if (!c) return B.AIR;
    return c.data[idx(x - cx * CS, y, z - cz * CS)];
  }

  setBlock(x, y, z, id) {
    if (y < 0 || y >= CH) return false;
    const cx = Math.floor(x / CS), cz = Math.floor(z / CS);
    const key = this.key(cx, cz);
    const c = this.chunks.get(key);
    if (!c) return false;
    const lx = x - cx * CS, lz = z - cz * CS;
    const i = idx(lx, y, lz);
    c.data[i] = id;
    if (y > c.maxY) c.maxY = y;
    let e = this.edits.get(key);
    if (!e) { e = new Map(); this.edits.set(key, e); }
    e.set(i, id);

    // Rebuild this chunk and any neighbour whose faces or AO touch the edited block.
    const xs = [0], zs = [0];
    if (lx === 0) xs.push(-1); if (lx === CS - 1) xs.push(1);
    if (lz === 0) zs.push(-1); if (lz === CS - 1) zs.push(1);
    for (const dx of xs) for (const dz of zs) {
      const n = this.chunks.get(this.key(cx + dx, cz + dz));
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

  update(px, pz, budgetMs = 6) {
    const pcx = Math.floor(px / CS), pcz = Math.floor(pz / CS);
    const start = performance.now();
    const r = this.renderDistance;

    for (const [dx, dz, dist] of this.offsets) {
      if (performance.now() - start > budgetMs) break;
      const cx = pcx + dx, cz = pcz + dz;
      const key = this.key(cx, cz);
      let c = this.chunks.get(key);
      if (!c) {
        c = new Chunk(cx, cz);
        this.generate(c);
        this.chunks.set(key, c);
      }
      if (c.dirty && dist <= r + 0.5 && this.hasNeighbours(cx, cz)) this.buildMesh(c);
    }

    if (performance.now() - start < budgetMs) {
      for (const [key, c] of this.chunks) {
        if (Math.abs(c.cx - pcx) > r + 3 || Math.abs(c.cz - pcz) > r + 3) {
          this.disposeMeshes(c);
          this.chunks.delete(key);
        }
      }
    }
  }

  hasNeighbours(cx, cz) {
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (!this.chunks.has(this.key(cx + dx, cz + dz))) return false;
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
    const ox = c.cx * CS, oz = c.cz * CS;
    const get = (x, y, z) => {
      if (y < 0) return B.BEDROCK;
      if (y >= CH) return B.AIR;
      if (x >= 0 && x < CS && z >= 0 && z < CS) return data[idx(x, y, z)];
      return this.getBlock(ox + x, y, oz + z);
    };
    const occ = (x, y, z) => (BLOCKS[get(x, y, z)].occludes ? 1 : 0);

    const solid = new GeometryBuilder();
    const water = new GeometryBuilder();
    const maxY = Math.min(c.maxY + 1, CH - 1);
    const aos = [0, 0, 0, 0];

    for (let y = 0; y <= maxY; y++) {
      for (let z = 0; z < CS; z++) {
        for (let x = 0; x < CS; x++) {
          const b = data[idx(x, y, z)];
          if (b === B.AIR) continue;
          const def = BLOCKS[b];
          const lowerTop = def.liquid && get(x, y + 1, z) !== B.WATER;

          for (const f of FACES) {
            const [dx, dy, dz] = f.dir;
            const nb = get(x + dx, y + dy, z + dz);
            const nd = BLOCKS[nb];
            let visible;
            if (def.liquid) visible = !nd.opaque && !nd.liquid && !(nd.solid && dy === 0);
            else if (def.opaque) visible = !nd.opaque;
            else visible = !nd.opaque && (nb !== b || def.selfFaces);
            if (!visible) continue;

            const tile = dy === 1 ? def.top : dy === -1 ? def.bottom : def.side;
            const tu = tile % ATLAS, tv = Math.floor(tile / ATLAS);
            const g = def.liquid ? water : solid;
            const base = g.count;

            for (let k = 0; k < 4; k++) {
              const [cx, cy, cz, u, v] = f.corners[k];
              let vy = y + cy;
              if (lowerTop && cy === 1) vy -= 0.12;
              g.pos.push(ox + x + cx, vy, oz + z + cz);
              const uu = UV_EPS + u * (1 - 2 * UV_EPS), vv = UV_EPS + v * (1 - 2 * UV_EPS);
              g.uv.push((tu + uu) / ATLAS, 1 - (tv + 1 - vv) / ATLAS);

              let ao = 3;
              if (!def.liquid) {
                // The two in-plane axes for this face, stepping toward this corner.
                const nx = x + dx, ny = y + dy, nz = z + dz;
                const ax = dx === 0 ? (cx ? 1 : -1) : 0;
                const ay = dy === 0 ? (cy ? 1 : -1) : 0;
                const az = dz === 0 ? (cz ? 1 : -1) : 0;
                let s1, s2;
                if (dx !== 0) { s1 = occ(nx, ny + ay, nz); s2 = occ(nx, ny, nz + az); }
                else if (dy !== 0) { s1 = occ(nx + ax, ny, nz); s2 = occ(nx, ny, nz + az); }
                else { s1 = occ(nx + ax, ny, nz); s2 = occ(nx, ny + ay, nz); }
                const corner = occ(nx + ax, ny + ay, nz + az);
                ao = s1 && s2 ? 0 : 3 - (s1 + s2 + corner);
              }
              aos[k] = ao;
              // Vertex colours are linear; convert so the shading reads correctly after sRGB output.
              const l = Math.pow(f.shade * AO_CURVE[ao], 2.2);
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
      this.scene.add(c.mesh);
    }
    const wg = water.build();
    if (wg) {
      c.waterMesh = new THREE.Mesh(wg, this.waterMaterial);
      c.waterMesh.renderOrder = 1;
      this.scene.add(c.waterMesh);
    }
    c.dirty = false;
  }
}
