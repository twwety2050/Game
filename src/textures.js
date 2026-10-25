// Procedurally painted 16x16 pixel-art textures packed into one atlas canvas.
import { T } from './blocks.js';
import { mulberry32 } from './noise.js';

export const TILE = 16;
export const ATLAS = 8; // tiles per row/column

export function createAtlas() {
  const size = TILE * ATLAS;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const rand = mulberry32(1337);

  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const offset = (t, x, y) => (((Math.floor(t / ATLAS) * TILE + y) * size) + (t % ATLAS) * TILE + x) * 4;
  const put = (t, x, y, c, a = 255) => {
    const i = offset(t, x, y);
    d[i] = clamp(c[0]); d[i + 1] = clamp(c[1]); d[i + 2] = clamp(c[2]); d[i + 3] = a;
  };
  const vary = (c, amt) => {
    const k = 1 + (rand() * 2 - 1) * amt;
    return [c[0] * k, c[1] * k, c[2] * k];
  };
  const each = (fn) => { for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) fn(x, y); };
  const fill = (t, base, amt) => each((x, y) => put(t, x, y, vary(base, amt)));
  const copy = (src, dst) => each((x, y) => {
    const s = offset(src, x, y), o = offset(dst, x, y);
    for (let k = 0; k < 4; k++) d[o + k] = d[s + k];
  });

  const DIRT = [134, 96, 67];
  fill(T.DIRT, DIRT, 0.15);
  fill(T.GRASS_TOP, [95, 159, 53], 0.15);
  fill(T.SAND, [219, 207, 142], 0.07);
  fill(T.SNOW, [240, 248, 250], 0.03);
  fill(T.WATER, [47, 95, 210], 0.08);

  // Dirt sides with a jagged cap of grass or snow on top.
  const cappedSide = (t, cap, amt) => {
    copy(T.DIRT, t);
    for (let x = 0; x < TILE; x++) {
      const depth = 2 + Math.floor(rand() * 3);
      for (let y = 0; y < depth; y++) put(t, x, y, vary(cap, amt));
    }
  };
  cappedSide(T.GRASS_SIDE, [95, 159, 53], 0.15);
  cappedSide(T.SNOW_SIDE, [240, 248, 250], 0.03);

  fill(T.STONE, [125, 125, 125], 0.12);
  for (let k = 0; k < 7; k++) {
    const sx = Math.floor(rand() * TILE), sy = Math.floor(rand() * TILE), len = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < len; i++) put(T.STONE, (sx + i) % TILE, sy, vary([100, 100, 100], 0.05));
  }

  const ore = (t, color) => {
    copy(T.STONE, t);
    for (let k = 0; k < 5; k++) {
      const cx = 2 + Math.floor(rand() * 12), cy = 2 + Math.floor(rand() * 12);
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1], [-1, 0]]) {
        if (rand() < 0.8) put(t, cx + dx, cy + dy, vary(color, 0.12));
      }
    }
  };
  ore(T.COAL_ORE, [35, 35, 35]);
  ore(T.IRON_ORE, [216, 175, 147]);

  each((x, y) => put(T.LOG_SIDE, x, y, vary(x % 4 === 0 ? [80, 62, 38] : [107, 84, 51], 0.08)));
  each((x, y) => {
    const dist = Math.hypot(x - 7.5, y - 7.5);
    const c = dist > 6.5 ? [107, 84, 51] : (Math.floor(dist) % 2 ? [168, 135, 83] : [140, 110, 65]);
    put(T.LOG_TOP, x, y, vary(c, 0.05));
  });

  each((x, y) => {
    if (rand() < 0.18) put(T.LEAVES, x, y, [0, 0, 0], 0);
    else put(T.LEAVES, x, y, vary([58, 130, 40], 0.25));
  });

  each((x, y) => {
    const row = Math.floor(y / 4);
    const seam = y % 4 === 3 || x === (row * 7 + 3) % TILE;
    put(T.PLANKS, x, y, vary(seam ? [120, 95, 55] : [176, 143, 85], 0.07));
  });

  // Cobblestone: Voronoi cells with dark mortar where two cells meet.
  const pts = Array.from({ length: 9 }, () => [rand() * TILE, rand() * TILE, 0.8 + rand() * 0.4]);
  each((x, y) => {
    let best = Infinity, second = Infinity, cell = 0;
    for (let i = 0; i < pts.length; i++) {
      for (const ox of [-TILE, 0, TILE]) for (const oy of [-TILE, 0, TILE]) {
        const dist = Math.hypot(x + 0.5 - pts[i][0] - ox, y + 0.5 - pts[i][1] - oy);
        if (dist < best) { second = best; best = dist; cell = i; }
        else if (dist < second) second = dist;
      }
    }
    const k = pts[cell][2];
    put(T.COBBLE, x, y, second - best < 1 ? vary([70, 70, 70], 0.1) : vary([125 * k, 125 * k, 125 * k], 0.08));
  });

  each((x, y) => {
    const border = x === 0 || y === 0 || x === TILE - 1 || y === TILE - 1;
    put(T.GLASS, x, y, [205, 232, 240], border ? 255 : 0);
  });
  for (let i = 0; i < 4; i++) put(T.GLASS, 3 + i, 6 - i, [255, 255, 255], 255);
  for (let i = 0; i < 3; i++) put(T.GLASS, 9 + i, 12 - i, [255, 255, 255], 255);

  each((x, y) => {
    const r = rand();
    put(T.BEDROCK, x, y, r < 0.33 ? [40, 40, 40] : r < 0.66 ? [65, 65, 65] : [100, 100, 100]);
  });

  each((x, y) => {
    const row = Math.floor(y / 4);
    const mortar = y % 4 === 3 || x % 8 === (row % 2 ? 0 : 4);
    put(T.BRICK, x, y, mortar ? vary([180, 170, 160], 0.05) : vary([150, 70, 55], 0.1));
  });

  ctx.putImageData(img, 0, 0);
  return canvas;
}
