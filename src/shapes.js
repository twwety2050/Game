// Block shapes: geometry, collision boxes, and the 24 axis-aligned orientations.
//
// Every shape is defined in a canonical orientation: it rests on its bottom face (-Y) and
// sloped shapes rise toward -Z (their low edge faces +Z). A block's `meta` byte picks one of
// 24 rotations, which maps canonical "down" and "front" (+Z) to any pair of perpendicular axes.

export const SHAPE = { FULL: 0, SLAB: 1, PLATE: 2, SLOPE: 3, SLOPE_LOW: 4, SLOPE_HIGH: 5 };

// Face/direction indices, matching the face order used by the mesher: -X +X -Y +Y -Z +Z.
export const DIRS = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];
export const dirIndex = (x, y, z) => (x < 0 ? 0 : x > 0 ? 1 : y < 0 ? 2 : y > 0 ? 3 : z < 0 ? 4 : 5);

// ---------- rotations ----------

// All 24 proper rotations of a cube, as row-major 3x3 integer matrices. Index 0 is identity.
export const ROTATIONS = [];
for (const perm of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
  for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) {
    const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const signs = [sx, sy, sz];
    for (let r = 0; r < 3; r++) m[r * 3 + perm[r]] = signs[r];
    const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    if (det === 1) ROTATIONS.push(m);
  }
}

const rotate = (m, x, y, z) => [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];

// A direction (integer vector) rotated by orientation `meta`.
export const applyRotation = (meta, v) => rotate(ROTATIONS[meta], v[0], v[1], v[2]);

// Rotation whose canonical down (-Y) maps to `down` and front (+Z) maps to `front`.
export function rotationFor(down, front) {
  for (let i = 0; i < ROTATIONS.length; i++) {
    const d = rotate(ROTATIONS[i], 0, -1, 0), f = rotate(ROTATIONS[i], 0, 0, 1);
    if (d[0] === down[0] && d[1] === down[1] && d[2] === down[2] &&
      f[0] === front[0] && f[1] === front[1] && f[2] === front[2]) return i;
  }
  return 0;
}

// ---------- canonical shapes ----------

// A polygon is a convex loop of vertices with an outward normal. `cull` is the cube face it
// lies on (-1 if none), so it can be hidden by a neighbour covering that face.
const poly = (verts, normal, cull) => ({ verts, normal, cull });

function box(x0, y0, z0, x1, y1, z1) {
  return [
    poly([[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], [-1, 0, 0], x0 === 0 ? 0 : -1),
    poly([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0], x1 === 1 ? 1 : -1),
    poly([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], y0 === 0 ? 2 : -1),
    poly([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], [0, 1, 0], y1 === 1 ? 3 : -1),
    poly([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], [0, 0, -1], z0 === 0 ? 4 : -1),
    poly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], z1 === 1 ? 5 : -1),
  ];
}

// A wedge whose top surface runs from height `hb` at the back (z = 0) to `hf` at the front.
function wedge(hb, hf) {
  const side = (x) => {
    const loop = [[x, 0, 0], [x, hb, 0], [x, hf, 1], [x, 0, 1]];
    return hf === 0 ? [loop[0], loop[1], loop[2]] : loop;
  };
  const len = Math.hypot(1, hb - hf);
  const polys = [
    poly([[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], [0, -1, 0], 2),
    poly([[0, 0, 0], [1, 0, 0], [1, hb, 0], [0, hb, 0]], [0, 0, -1], 4),
    poly([[0, hb, 0], [1, hb, 0], [1, hf, 1], [0, hf, 1]], [0, 1 / len, (hb - hf) / len], -1),
    poly(side(0), [-1, 0, 0], 0),
    poly(side(1), [1, 0, 0], 1),
  ];
  if (hf > 0) polys.push(poly([[0, 0, 1], [1, 0, 1], [1, hf, 1], [0, hf, 1]], [0, 0, 1], 5));
  return polys;
}

// Collision approximation of a wedge: columns along z, each as tall as the slope at its high
// edge. The player's step-up lets them walk up these smoothly.
function wedgeBoxes(hb, hf, columns = 4) {
  const boxes = [];
  for (let j = 0; j < columns; j++) {
    const z0 = j / columns, z1 = (j + 1) / columns;
    boxes.push([0, 0, z0, 1, hb + (hf - hb) * z0, z1]);
  }
  return boxes;
}

const DEFS = {
  [SHAPE.FULL]: { polys: box(0, 0, 0, 1, 1, 1), boxes: [[0, 0, 0, 1, 1, 1]], full: 0b111111, volume: 1 },
  [SHAPE.SLAB]: { polys: box(0, 0, 0, 1, 0.5, 1), boxes: [[0, 0, 0, 1, 0.5, 1]], full: 1 << 2, volume: 0.5 },
  [SHAPE.PLATE]: { polys: box(0, 0, 0, 1, 0.125, 1), boxes: [[0, 0, 0, 1, 0.125, 1]], full: 1 << 2, volume: 0.125 },
  [SHAPE.SLOPE]: { polys: wedge(1, 0), boxes: wedgeBoxes(1, 0), full: (1 << 2) | (1 << 4), volume: 0.5 },
  [SHAPE.SLOPE_LOW]: { polys: wedge(0.5, 0), boxes: wedgeBoxes(0.5, 0, 2), full: 1 << 2, volume: 0.25 },
  [SHAPE.SLOPE_HIGH]: { polys: wedge(1, 0.5), boxes: wedgeBoxes(1, 0.5, 2), full: (1 << 2) | (1 << 4), volume: 0.75 },
};

// Fraction of the cell a shape fills.
export const shapeVolume = (shape) => DEFS[shape].volume;

// ---------- rotated variants ----------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Rotate a point of the unit cube about its centre.
const rotatePoint = (m, p) => rotate(m, p[0] - 0.5, p[1] - 0.5, p[2] - 0.5).map((v) => Math.round((v + 0.5) * 1e6) / 1e6);

function buildVariant(def, m) {
  const polys = def.polys.map((p) => {
    const verts = p.verts.map((v) => rotatePoint(m, v));
    const normal = rotate(m, ...p.normal);
    // Fan-triangulate, flipping the winding if needed so triangles face outward.
    const tris = [];
    for (let i = 1; i + 1 < verts.length; i++) tris.push([0, i, i + 1]);
    const n = cross(sub(verts[1], verts[0]), sub(verts[2], verts[0]));
    if (dot(n, normal) < 0) for (const t of tris) t.reverse();
    const cull = p.cull < 0 ? -1 : dirIndex(...rotate(m, ...DIRS[p.cull]));
    // Which of the block's textures this polygon uses, from its canonical (unrotated) normal.
    const role = p.normal[1] > 0.3 ? 'top' : p.normal[1] < -0.3 ? 'bottom' : 'side';
    // Same lighting model as cube faces: blend face shades by the normal's components.
    const shade = 0.75 * normal[0] ** 2 + 0.88 * normal[2] ** 2 + (normal[1] > 0 ? 1.0 : 0.55) * normal[1] ** 2;
    return { verts, normal, tris, cull, shade, role };
  });
  const boxes = def.boxes.map((b) => {
    const a = rotatePoint(m, [b[0], b[1], b[2]]), c = rotatePoint(m, [b[3], b[4], b[5]]);
    return [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.min(a[2], c[2]), Math.max(a[0], c[0]), Math.max(a[1], c[1]), Math.max(a[2], c[2])];
  });
  let full = 0;
  for (let d = 0; d < 6; d++) if (def.full & (1 << d)) full |= 1 << dirIndex(...rotate(m, ...DIRS[d]));
  return { polys, boxes, full };
}

// VARIANTS[shape][rotation] -> { polys, boxes, full } in block-local coordinates (0..1).
export const VARIANTS = [];
for (const [shape, def] of Object.entries(DEFS)) {
  VARIANTS[shape] = ROTATIONS.map((m) => buildVariant(def, m));
}

// Bitmask of the faces a block fully covers (for culling neighbours), per shape and rotation.
export const fullFaces = (shape, rot) => VARIANTS[shape][rot].full;
