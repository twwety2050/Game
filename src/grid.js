// A voxel grid: blocks stored in cubic chunks, meshed for rendering, editable and raycastable.
//
// The static world and every ship are grids. A grid has a rigid transform (identity for the
// world) mapping its local block coordinates to world space; ships override it.
import * as THREE from 'three';
import { B, BLOCKS } from './blocks.js';
import { ATLAS } from './textures.js';

export const CS = 32; // chunk edge length on every axis
export const CS3 = CS * CS * CS;

export const idx = (x, y, z) => (y * CS + z) * CS + x;

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
export const SOLID = flagTable('solid');
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

export class Chunk {
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

export class VoxelGrid {
  constructor(container, material, waterMaterial) {
    this.container = container; // THREE object the chunk meshes are added to
    this.material = material;
    this.waterMaterial = waterMaterial;
    this.chunks = new Map();
    this.createChunks = false;  // whether setBlock may create missing chunks
    this.quaternion = new THREE.Quaternion();
  }

  key(cx, cy, cz) { return cx + ',' + cy + ',' + cz; }

  // ---------- transform (identity; ships override) ----------

  localToWorld(v, out = new THREE.Vector3()) { return out.copy(v); }
  worldToLocal(v, out = new THREE.Vector3()) { return out.copy(v); }
  dirToWorld(v, out = new THREE.Vector3()) { return out.copy(v); }
  dirToLocal(v, out = new THREE.Vector3()) { return out.copy(v); }
  velocityAt(_worldPoint, out = new THREE.Vector3()) { return out.set(0, 0, 0); }

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

  isSolid(x, y, z) {
    return SOLID[this.getBlock(Math.floor(x), Math.floor(y), Math.floor(z))] === 1;
  }

  // Sets a block and rebuilds the affected meshes. `remesh: false` defers meshing (bulk loads).
  setBlock(x, y, z, id, { remesh = true } = {}) {
    const cx = Math.floor(x / CS), cy = Math.floor(y / CS), cz = Math.floor(z / CS);
    const key = this.key(cx, cy, cz);
    let c = this.chunks.get(key);
    if (!c) {
      if (!this.createChunks) return false;
      c = new Chunk(cx, cy, cz);
      this.chunks.set(key, c);
    }
    const lx = x - cx * CS, ly = y - cy * CS, lz = z - cz * CS;
    const i = idx(lx, ly, lz);
    if (!c.data) c.data = new Uint8Array(CS3);
    const old = c.data[i];
    if (old === id) return true;
    c.data[i] = id;
    this.onBlockChanged(x, y, z, old, id, key, i);

    if (!remesh) { c.dirty = true; return true; }
    // Rebuild this chunk and any neighbour whose faces or AO touch the edited block.
    const near = (l) => (l === 0 ? [0, -1] : l === CS - 1 ? [0, 1] : [0]);
    for (const dx of near(lx)) for (const dy of near(ly)) for (const dz of near(lz)) {
      const n = this.chunks.get(this.key(cx + dx, cy + dy, cz + dz));
      if (n) this.buildMesh(n);
    }
    return true;
  }

  onBlockChanged() {}

  // Voxel DDA raycast in local coordinates. Returns the first non-liquid block hit, the face
  // normal, and the distance along the ray.
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
      if (b !== B.AIR && !BLOCKS[b].liquid) return { x, y, z, nx, ny, nz, id: b, t };
      if (tmx < tmy && tmx < tmz) { x += sx; t = tmx; tmx += tdx; nx = -sx; ny = 0; nz = 0; }
      else if (tmy < tmz) { y += sy; t = tmy; tmy += tdy; nx = 0; ny = -sy; nz = 0; }
      else { z += sz; t = tmz; tmz += tdz; nx = 0; ny = 0; nz = -sz; }
    }
    return null;
  }

  disposeMeshes(c) {
    for (const m of [c.mesh, c.waterMesh]) {
      if (m) { this.container.remove(m); m.geometry.dispose(); }
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
      this.container.add(c.mesh);
    }
    const wg = water.build();
    if (wg) {
      c.waterMesh = new THREE.Mesh(wg, this.waterMaterial);
      c.waterMesh.position.set(ox, oy, oz);
      c.waterMesh.renderOrder = 1;
      this.container.add(c.waterMesh);
    }
  }
}
