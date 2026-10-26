// Procedurally painted 16x16 pixel-art textures packed into one atlas canvas.
import { T, CRACK_STAGES } from './blocks.js';
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

  // Hull: brushed metal panel with bevelled seams, rivets, and a soft sheen.
  each((x, y) => {
    const streak = Math.sin(y * 2.3 + Math.sin(x * 0.7) * 0.6) * 4;
    const sheen = 14 * Math.exp(-(((x - y) / 6) ** 2));
    let c = [152 + streak + sheen, 160 + streak + sheen, 170 + streak + sheen];
    if (x === 0 || y === 0) c = [196, 202, 210];             // lit bevel
    else if (x === TILE - 1 || y === TILE - 1) c = [86, 92, 102]; // shadowed seam
    else if (y === 8) c = [118, 124, 134];                   // panel split
    put(T.HULL, x, y, vary(c, 0.025));
  });
  for (const [rx, ry] of [[2, 2], [13, 2], [2, 13], [13, 13]]) {
    put(T.HULL, rx, ry, [214, 220, 228]);
    put(T.HULL, rx + 1, ry + 1, [96, 102, 112]);
  }

  // Gravity generator: dark gunmetal with a glowing cyan emitter ring (emitter face) or a
  // thin glowing stripe (other faces).
  const glow = (d) => [60 + 40 * d, 200 + 40 * d, 255];
  each((x, y) => {
    const ring = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
    let c = vary([46, 50, 60], 0.05);
    if (x === 0 || y === 0) c = [78, 84, 96];
    else if (x === TILE - 1 || y === TILE - 1) c = [26, 28, 34];
    else if (ring >= 4 && ring <= 5) c = glow(ring === 4 ? 1 : 0.5);
    else if (ring <= 1.5) c = glow(0.8);
    else if (ring < 4) c = [30 + 8 * (4 - ring), 70 + 20 * (4 - ring), 90 + 25 * (4 - ring)];
    put(T.GRAVITY, x, y, c);
    let side = vary([46, 50, 60], 0.05);
    if (x === 0 || y === 0) side = [78, 84, 96];
    else if (x === TILE - 1 || y === TILE - 1) side = [26, 28, 34];
    else if (y === 3 || y === 4) side = glow(y === 3 ? 0.8 : 0.3);
    put(T.GRAVITY_SIDE, x, y, side);
  });

  // Thruster body: steel with dark vents and a hazard band.
  each((x, y) => {
    let c = vary([140, 146, 156], 0.04);
    if (y >= 12) c = (x + y) % 6 < 3 ? [222, 150, 40] : [40, 40, 44];   // hazard stripes
    else if (y % 4 === 1 && x > 2 && x < 13) c = [52, 56, 64];           // vents
    if (x === 0 || x === TILE - 1) c = [96, 100, 110];
    put(T.THRUSTER_SIDE, x, y, c);
  });
  // Nozzle: dark concentric rings around a white-hot core.
  each((x, y) => {
    const r = Math.hypot(x - 7.5, y - 7.5);
    let c = [44, 46, 52];
    if (r < 2) c = [255, 240, 200];
    else if (r < 3.5) c = [255, 160, 60];
    else if (r < 5) c = [120, 50, 20];
    else if (Math.floor(r) % 2) c = [70, 72, 80];
    put(T.THRUSTER_NOZZLE, x, y, vary(c, 0.03));
  });
  // Console screen: a dark display with a bezel, a radar ring, and readout lines.
  each((x, y) => {
    let c = [16, 26, 40];
    const r = Math.hypot(x - 5, y - 6);
    if (x === 0 || y === 0 || x === TILE - 1 || y === TILE - 1) c = [70, 76, 88];
    else if (Math.abs(r - 3.2) < 0.6 || (r < 3.5 && (x === 5 || y === 6))) c = [60, 220, 170];
    else if (x >= 10 && x <= 13 && y % 3 === 2) c = [90, 180, 255];
    else if (y === 12 && x > 1 && x < 9) c = [255, 190, 70];
    put(T.CONSOLE_SCREEN, x, y, c);
  });
  each((x, y) => {
    let c = vary([58, 62, 72], 0.04);
    if (x === 0 || y === 0) c = [92, 98, 110];
    else if (x === TILE - 1 || y === TILE - 1) c = [34, 36, 42];
    else if (y === 5 && x > 3 && x < 12) c = [60, 220, 170];
    put(T.CONSOLE_SIDE, x, y, c);
  });

  // Crack overlays: one random crack pattern revealed progressively over the stages.
  const segments = [];
  for (let k = 0; k < 6; k++) {
    let x = 4 + rand() * 8, y = 4 + rand() * 8;
    let a = rand() * Math.PI * 2;
    for (let n = 0; n < 7; n++) {
      a += (rand() - 0.5) * 1.6;
      const nx = x + Math.cos(a) * 2.2, ny = y + Math.sin(a) * 2.2;
      segments.push([x, y, nx, ny]);
      x = nx; y = ny;
    }
  }
  // Order segments roughly from the centre outwards so early stages show small cracks.
  segments.sort((p, q) => Math.hypot(p[0] - 8, p[1] - 8) - Math.hypot(q[0] - 8, q[1] - 8));
  for (let stage = 0; stage < CRACK_STAGES; stage++) {
    const t = T.CRACK + stage;
    each((x, y) => put(t, x, y, [0, 0, 0], 0));
    const shown = Math.ceil(segments.length * (stage + 1) / CRACK_STAGES);
    for (const [x0, y0, x1, y1] of segments.slice(0, shown)) {
      for (let s = 0; s <= 1; s += 0.1) {
        const px = Math.floor(x0 + (x1 - x0) * s), py = Math.floor(y0 + (y1 - y0) * s);
        if (px >= 0 && py >= 0 && px < TILE && py < TILE) put(t, px, py, [20, 20, 22], 230);
      }
    }
  }

  ctx.putImageData(img, 0, 0);
  return canvas;
}
