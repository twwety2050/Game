// A voxel grid: blocks stored in cubic chunks, meshed for rendering, editable and raycastable.
//
// The static world and every ship are grids. A grid has a rigid transform (identity for the
// world) mapping its local block coordinates to world space; ships override it.
//
// Per block a chunk stores an id, an orientation (`meta`, one of 24 rotations, used by shaped
// blocks), and optionally accumulated damage in [0, 1), which is drawn as cracks.
import * as THREE from 'three';
import { B, BLOCKS, T, CRACK_STAGES } from './blocks.js';
import { SHAPE, VARIANTS } from './shapes.js';
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

const PAD_META = new Uint8Array(P * P * P);

// Per-block lookup tables, faster than reading BLOCKS[id].flag in the meshing loop.
const table = (fn) => Uint8Array.from({ length: 256 }, (_, id) => (BLOCKS[id] ? fn(BLOCKS[id]) : 0));
const OPAQUE = table((d) => d.opaque);
const OCCLUDES = table((d) => d.occludes);
const LIQUID = table((d) => d.liquid);
export const SOLID = table((d) => d.solid);
const SELF_FACES = table((d) => d.selfFaces);
const SHAPE_OF = table((d) => d.shape);
// 2 = opaque full cube (hides every neighbouring face), 1 = opaque shape (hides only the
// neighbouring faces it fully covers), 0 = see-through.
const COVER = table((d) => (!d.opaque ? 0 : d.shape === SHAPE.FULL ? 2 : 1));
const FULL_MASK = new Uint8Array(VARIANTS.length * 24);
VARIANTS.forEach((rots, shape) => rots.forEach((v, r) => { FULL_MASK[shape * 24 + r] = v.full; }));

// Does block `id` with orientation `meta` completely cover its face in direction `dir`?
const covers = (id, meta, dir) => {
  const c = COVER[id];
  return c === 2 || (c === 1 && ((FULL_MASK[SHAPE_OF[id] * 24 + meta] >> dir) & 1) === 1);
};

const IS_GRAVITY = table((d) => d.gravity !== null);
const GRAVITY_BUCKET = 16; // edge length of the spatial hash cells for gravity sources

const FULL_BOXES = [[0, 0, 0, 1, 1, 1]];
// Collision boxes (block-local, 0..1) of a block with the given orientation.
export const blockBoxes = (id, meta) => (SHAPE_OF[id] === SHAPE.FULL ? FULL_BOXES : VARIANTS[SHAPE_OF[id]][meta].boxes);

export const crackStage = (damage) => (damage > 0 ? Math.min(CRACK_STAGES, Math.floor(damage * CRACK_STAGES) + 1) : 0);
const crackTile = (damage) => T.CRACK + crackStage(damage) - 1;

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
    this.data = null;   // block ids; null means the chunk is entirely air
    this.meta = null;   // orientations; null means all 0
    this.damage = null; // Map(local index -> damage in [0, 1)), or null
    this.dirty = true;
    this.mesh = null;
    this.waterMesh = null;
    this.crackMesh = null;
  }
}

class GeometryBuilder {
  // Append one textured polygon: `verts` block-local, offset by (x, y, z); `uvs` within a tile.
  addPolygon(x, y, z, verts, uvs, tris, tile, light) {
    const base = this.count;
    const tu = tile % ATLAS, tv = Math.floor(tile / ATLAS);
    for (let k = 0; k < verts.length; k++) {
      const v = verts[k];
      this.pos.push(x + v[0], y + v[1], z + v[2]);
      const u = UV_EPS + uvs[k][0] * (1 - 2 * UV_EPS), w = UV_EPS + uvs[k][1] * (1 - 2 * UV_EPS);
      this.uv.push((tu + u) / ATLAS, 1 - (tv + 1 - w) / ATLAS);
      this.col.push(light, light, light);
    }
    for (const t of tris) this.ind.push(base + t[0], base + t[1], base + t[2]);
  }

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

// Texture coordinates for a shaped polygon: project onto the plane its normal faces most.
const projectUVs = (verts, n) => {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  if (ay >= ax && ay >= az) return verts.map((v) => [v[0], v[2]]);
  if (ax >= az) return verts.map((v) => [v[2], v[1]]);
  return verts.map((v) => [v[0], v[1]]);
};
for (const rots of VARIANTS) {
  for (const v of rots) for (const p of v.polys) {
    p.uvs = projectUVs(p.verts, p.normal);
    p.light = Math.pow(p.shade, 2.2);
  }
}

// Ray vs axis-aligned box entry. Returns the entry distance and the axis/sign of the face
// entered, or null if the ray misses (or starts inside).
function rayBox(o, d, x0, y0, z0, x1, y1, z1) {
  let tmin = -Infinity, tmax = Infinity, axis = 0, sign = 0;
  const lo = [x0, y0, z0], hi = [x1, y1, z1], oo = [o.x, o.y, o.z], dd = [d.x, d.y, d.z];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(dd[a]) < 1e-12) {
      if (oo[a] < lo[a] || oo[a] > hi[a]) return null;
      continue;
    }
    let t0 = (lo[a] - oo[a]) / dd[a], t1 = (hi[a] - oo[a]) / dd[a];
    const s = dd[a] > 0 ? -1 : 1;
    if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
    if (t0 > tmin) { tmin = t0; axis = a; sign = s; }
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  return { t: Math.max(tmin, 0), axis, sign };
}

export class VoxelGrid {
  // materials: { solid, water, crack }
  constructor(container, materials) {
    this.container = container; // THREE object the chunk meshes are added to
    this.materials = materials;
    this.chunks = new Map();
    this.createChunks = false;  // whether setBlock may create missing chunks
    // Gravity generator blocks, indexed by position and bucketed spatially for range queries.
    this.gravitySources = new Map(); // "x,y,z" -> { x, y, z, id, meta, bucket }
    this.gravityBuckets = new Map(); // bucket key -> Set of sources
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

  getMeta(x, y, z) {
    const cx = Math.floor(x / CS), cy = Math.floor(y / CS), cz = Math.floor(z / CS);
    const c = this.chunks.get(this.key(cx, cy, cz));
    if (!c || !c.meta) return 0;
    return c.meta[idx(x - cx * CS, y - cy * CS, z - cz * CS)];
  }

  // Is the point (in local, fractional block coordinates) inside a solid block's shape?
  isSolid(x, y, z) {
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    const id = this.getBlock(bx, by, bz);
    if (!SOLID[id]) return false;
    if (SHAPE_OF[id] === SHAPE.FULL) return true;
    const fx = x - bx, fy = y - by, fz = z - bz;
    for (const b of blockBoxes(id, this.getMeta(bx, by, bz))) {
      if (fx >= b[0] && fx <= b[3] && fy >= b[1] && fy <= b[4] && fz >= b[2] && fz <= b[5]) return true;
    }
    return false;
  }

  getDamage(x, y, z) {
    const cx = Math.floor(x / CS), cy = Math.floor(y / CS), cz = Math.floor(z / CS);
    const c = this.chunks.get(this.key(cx, cy, cz));
    return c?.damage?.get(idx(x - cx * CS, y - cy * CS, z - cz * CS)) ?? 0;
  }

  // Record damage on a block; the chunk is remeshed when the visible crack stage changes.
  setDamage(x, y, z, value) {
    const cx = Math.floor(x / CS), cy = Math.floor(y / CS), cz = Math.floor(z / CS);
    const key = this.key(cx, cy, cz);
    const c = this.chunks.get(key);
    if (!c || !c.data) return;
    const i = idx(x - cx * CS, y - cy * CS, z - cz * CS);
    const old = c.damage?.get(i) ?? 0;
    if (value > 0) {
      if (!c.damage) { c.damage = new Map(); this.onDamageMapCreated(key, c.damage); }
      c.damage.set(i, value);
    } else if (c.damage) {
      c.damage.delete(i);
    }
    if (crackStage(old) !== crackStage(value)) this.buildMesh(c);
  }

  onDamageMapCreated() {}

  // Sets a block and rebuilds the affected meshes. `remesh: false` defers meshing (bulk loads).
  // Placing or removing a block clears any damage it had.
  setBlock(x, y, z, id, { meta = 0, remesh = true } = {}) {
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
    const oldMeta = c.meta ? c.meta[i] : 0;
    if (old === id && oldMeta === meta) return true;
    c.data[i] = id;
    if (meta && !c.meta) c.meta = new Uint8Array(CS3);
    if (c.meta) c.meta[i] = meta;
    c.damage?.delete(i);
    if (IS_GRAVITY[old] || IS_GRAVITY[id]) this.indexGravity(x, y, z, id, meta);
    this.onBlockChanged(x, y, z, old, id, key, i, meta);

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

  // ---------- gravity sources ----------

  indexGravity(x, y, z, id, meta) {
    const key = x + ',' + y + ',' + z;
    const old = this.gravitySources.get(key);
    if (old) {
      this.gravityBuckets.get(old.bucket).delete(old);
      this.gravitySources.delete(key);
    }
    if (!IS_GRAVITY[id]) return;
    const bucket = this.key(Math.floor(x / GRAVITY_BUCKET), Math.floor(y / GRAVITY_BUCKET), Math.floor(z / GRAVITY_BUCKET));
    const entry = { x, y, z, id, meta, bucket };
    this.gravitySources.set(key, entry);
    let set = this.gravityBuckets.get(bucket);
    if (!set) { set = new Set(); this.gravityBuckets.set(bucket, set); }
    set.add(entry);
  }

  // Call fn(source) for every gravity block within roughly `range` of local point p.
  forEachGravitySource(p, range, fn) {
    if (this.gravitySources.size === 0) return;
    const b0x = Math.floor((p.x - range) / GRAVITY_BUCKET), b1x = Math.floor((p.x + range) / GRAVITY_BUCKET);
    const b0y = Math.floor((p.y - range) / GRAVITY_BUCKET), b1y = Math.floor((p.y + range) / GRAVITY_BUCKET);
    const b0z = Math.floor((p.z - range) / GRAVITY_BUCKET), b1z = Math.floor((p.z + range) / GRAVITY_BUCKET);
    for (let bx = b0x; bx <= b1x; bx++) for (let by = b0y; by <= b1y; by++) for (let bz = b0z; bz <= b1z; bz++) {
      const set = this.gravityBuckets.get(this.key(bx, by, bz));
      if (set) for (const src of set) fn(src);
    }
  }

  // Voxel DDA raycast in local coordinates. Returns the first non-liquid block hit, the face
  // normal, and the distance along the ray. Shaped blocks are hit only where their shape is.
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
      if (b !== B.AIR && !LIQUID[b]) {
        if (SHAPE_OF[b] === SHAPE.FULL) return { x, y, z, nx, ny, nz, id: b, t };
        const meta = this.getMeta(x, y, z);
        let best = null;
        for (const bx of blockBoxes(b, meta)) {
          const hit = rayBox(origin, dir, x + bx[0], y + bx[1], z + bx[2], x + bx[3], y + bx[4], z + bx[5]);
          if (hit && hit.t <= maxDist && (!best || hit.t < best.t)) best = hit;
        }
        if (best) {
          const n = [0, 0, 0];
          n[best.axis] = best.sign;
          return { x, y, z, nx: n[0], ny: n[1], nz: n[2], id: b, t: best.t };
        }
      }
      if (tmx < tmy && tmx < tmz) { x += sx; t = tmx; tmx += tdx; nx = -sx; ny = 0; nz = 0; }
      else if (tmy < tmz) { y += sy; t = tmy; tmy += tdy; nx = 0; ny = -sy; nz = 0; }
      else { z += sz; t = tmz; tmz += tdz; nx = 0; ny = 0; nz = -sz; }
    }
    return null;
  }

  disposeMeshes(c) {
    for (const m of [c.mesh, c.waterMesh, c.crackMesh]) {
      if (m) { this.container.remove(m); m.geometry.dispose(); }
    }
    c.mesh = c.waterMesh = c.crackMesh = null;
  }

  // ---------- meshing ----------

  buildMesh(c) {
    const data = c.data;
    c.dirty = false;
    if (!data) { this.disposeMeshes(c); return; }
    const ox = c.cx * CS, oy = c.cy * CS, oz = c.cz * CS;

    // Copy the chunk plus a one-block border from its neighbours into a padded buffer so
    // every neighbour lookup below is a plain array read.
    const pad = PAD, padMeta = PAD_META;
    const meta = c.meta;
    for (let y = 0; y < CS; y++) {
      for (let z = 0; z < CS; z++) {
        const i = idx(0, y, z), p = pidx(0, y, z);
        pad.set(data.subarray(i, i + CS), p);
        if (meta) padMeta.set(meta.subarray(i, i + CS), p);
        else padMeta.fill(0, p, p + CS);
      }
    }
    for (let y = -1; y <= CS; y++) {
      const yEdge = y === -1 || y === CS;
      for (let z = -1; z <= CS; z++) {
        const zEdge = z === -1 || z === CS;
        for (let x = -1; x <= CS; x++) {
          if (yEdge || zEdge || x === -1 || x === CS) {
            const p = pidx(x, y, z);
            pad[p] = this.getBlock(ox + x, oy + y, oz + z);
            padMeta[p] = pad[p] ? this.getMeta(ox + x, oy + y, oz + z) : 0;
          }
        }
      }
    }

    const solid = new GeometryBuilder();
    const water = new GeometryBuilder();
    const cracks = new GeometryBuilder();
    const damage = c.damage && c.damage.size ? c.damage : null;
    const aos = [0, 0, 0, 0];
    const quadUVs = [[0, 0], [0, 0], [0, 0], [0, 0]];
    const quadVerts = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const QUAD_TRIS = [[0, 1, 2], [2, 1, 3]];

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
          const dmg = damage ? damage.get(i) ?? 0 : 0;

          if (SHAPE_OF[b] !== SHAPE.FULL) {
            // Shaped block: emit its polygons, hiding those flush against a covering neighbour.
            for (const poly of VARIANTS[SHAPE_OF[b]][padMeta[p]].polys) {
              if (poly.cull >= 0) {
                const q = p + FACES[poly.cull].offset;
                if (covers(pad[q], padMeta[q], poly.cull ^ 1)) continue;
              }
              solid.addPolygon(x, y, z, poly.verts, poly.uvs, poly.tris, def[poly.role], poly.light);
              if (dmg) cracks.addPolygon(x, y, z, poly.verts, poly.uvs, poly.tris, crackTile(dmg), 1);
            }
            continue;
          }

          for (let fi = 0; fi < 6; fi++) {
            const f = FACES[fi];
            const q = p + f.offset;
            const nb = pad[q];
            let visible;
            if (liquid) visible = !OPAQUE[nb] && !LIQUID[nb] && !(SOLID[nb] && f.dir[1] === 0);
            else if (opaque) visible = !covers(nb, padMeta[q], fi ^ 1);
            else visible = !covers(nb, padMeta[q], fi ^ 1) && (nb !== b || SELF_FACES[b]);
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

            if (dmg) {
              for (let k = 0; k < 4; k++) {
                const corner = f.corners[k];
                quadVerts[k][0] = corner.x; quadVerts[k][1] = corner.y; quadVerts[k][2] = corner.z;
                quadUVs[k][0] = corner.u; quadUVs[k][1] = corner.v;
              }
              cracks.addPolygon(x, y, z, quadVerts, quadUVs, QUAD_TRIS, crackTile(dmg), 1);
            }
          }
        }
      }
    }

    this.disposeMeshes(c);
    const sg = solid.build();
    if (sg) {
      c.mesh = new THREE.Mesh(sg, this.materials.solid);
      c.mesh.position.set(ox, oy, oz);
      this.container.add(c.mesh);
    }
    const wg = water.build();
    if (wg) {
      c.waterMesh = new THREE.Mesh(wg, this.materials.water);
      c.waterMesh.position.set(ox, oy, oz);
      c.waterMesh.renderOrder = 1;
      this.container.add(c.waterMesh);
    }
    const cg = cracks.build();
    if (cg) {
      c.crackMesh = new THREE.Mesh(cg, this.materials.crack);
      c.crackMesh.position.set(ox, oy, oz);
      c.crackMesh.renderOrder = 2;
      this.container.add(c.crackMesh);
    }
  }
}
