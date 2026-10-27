import * as THREE from 'three';
import { createAtlas, ATLAS } from './textures.js';
import { B, BLOCKS, HOTBAR, T } from './blocks.js';
import { World, CS } from './world.js';
import { mulberry32 } from './noise.js';
import { VoxelGrid, crackStage } from './grid.js';
import { SHAPE, rotationFor, applyRotation, DIRS } from './shapes.js';
import { Ship, CONTROL_KEYS } from './ship.js';
import { NavConsoleUI } from './console.js';
import { Fluids, encodeFluid, NO_DOWN } from './fluids.js';
import { Player } from './player.js';
import { Hud } from './hud.js';

const SAVE_KEY = 'voxelcraft-save-v3'; // v3: the solar system replaced the old terrain
const REACH = 6;
const RENDER_DISTANCE = 3; // in chunks, on every axis
const METEORITES = 14;

let save = null;
try { save = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch { save = null; }
const seed = save?.seed ?? Math.floor(Math.random() * 2 ** 31);

// ---------- renderer & scene ----------

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 6000);
camera.rotation.order = 'YXZ';

const atlas = createAtlas();
const texture = new THREE.CanvasTexture(atlas);
texture.magFilter = THREE.NearestFilter;
texture.minFilter = THREE.NearestFilter;
texture.generateMipmaps = false;
texture.colorSpace = THREE.SRGBColorSpace;

const solidMat = new THREE.MeshBasicMaterial({ map: texture, vertexColors: true, alphaTest: 0.5 });
const waterMat = new THREE.MeshBasicMaterial({
  map: texture, vertexColors: true, transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide,
});
// Cracks are drawn on top of damaged faces; the polygon offset keeps them from z-fighting.
const crackMat = new THREE.MeshBasicMaterial({
  map: texture, transparent: true, alphaTest: 0.1, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
});
const materials = { solid: solidMat, water: waterMat, crack: crackMat };

// Space: a black sky with no haze (the distant-body stand-ins cover the edge of the loaded
// area). Fog is only used underwater.
const SPACE = new THREE.Color(0x02030a);
const waterFog = new THREE.Fog(0x1f4a8a, 1, 24);
scene.background = SPACE.clone();

// Distant stars: points on a huge sphere that travels with the camera.
const starfield = (() => {
  const rand = mulberry32(99);
  const count = 4000, pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = rand() * 2 - 1, a = rand() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    pos.set([Math.cos(a) * r * 4000, u * 4000, Math.sin(a) * r * 4000], i * 3);
    const b = 0.3 + 0.7 * rand() ** 3, tint = rand();
    col.set([b * (tint > 0.85 ? 1 : 0.85), b * 0.9, b * (tint < 0.15 ? 0.7 : 1)], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const points = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, fog: false }));
  points.renderOrder = -1;
  scene.add(points);
  return points;
})();

const highlight = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
  new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 }),
);
highlight.visible = false;
scene.add(highlight);

// Crack overlay for the block being mined (blocks whose damage isn't permanent).
const breakOverlay = new THREE.Mesh(new THREE.BoxGeometry(1.006, 1.006, 1.006), crackMat);
const breakUVs = breakOverlay.geometry.attributes.uv.array.slice();
breakOverlay.visible = false;
scene.add(breakOverlay);

function setBreakStage(stage) {
  const tile = T.CRACK + stage - 1, tu = tile % ATLAS, tv = Math.floor(tile / ATLAS);
  const uv = breakOverlay.geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.array[i * 2] = (tu + breakUVs[i * 2]) / ATLAS;
    uv.array[i * 2 + 1] = 1 - (tv + 1 - breakUVs[i * 2 + 1]) / ATLAS;
  }
  uv.needsUpdate = true;
}

// Render a small isometric picture of every block (using the real mesher, so shaped blocks
// look right) for the hotbar and inventory.
function renderBlockIcons() {
  const size = 96;
  const target = new THREE.WebGLRenderTarget(size, size);
  target.texture.colorSpace = THREE.SRGBColorSpace;
  const iconScene = new THREE.Scene();
  const iconMaterials = { solid: solidMat.clone(), water: waterMat.clone(), crack: crackMat };
  const cam = new THREE.OrthographicCamera(-0.92, 0.92, 0.92, -0.92, 0.1, 10);
  cam.position.set(2.2, 1.9, 2.2);
  cam.lookAt(0.5, 0.42, 0.5);
  const pixels = new Uint8Array(size * size * 4);
  const icons = new Map();
  renderer.setClearColor(0x000000, 0);
  for (const def of BLOCKS) {
    if (!def || def.id === B.AIR) continue;
    const grid = new VoxelGrid(iconScene, iconMaterials);
    grid.createChunks = true;
    grid.setBlock(0, 0, 0, def.id, { meta: def.liquid ? encodeFluid(0, false, NO_DOWN) : 0, remesh: false });
    const chunk = grid.getChunkAt(0, 0, 0);
    grid.buildMesh(chunk);
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(iconScene, cam);
    renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
    grid.disposeMeshes(chunk);

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      img.data.set(pixels.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4); // flip rows
    }
    ctx.putImageData(img, 0, 0);
    icons.set(def.id, canvas);
  }
  renderer.setRenderTarget(null);
  target.dispose();
  return icons;
}

// ---------- game objects ----------

const world = new World(scene, materials, seed, save?.world ?? {}, RENDER_DISTANCE);
const ships = (save?.ships ?? []).map((data) => Ship.deserialize(data, scene, materials));
const player = new Player(camera, world, ships);
const fluids = new Fluids(world, ships);

// Far-away stand-ins for the star and planets, so they're visible across the system before
// their blocks load. Each is the body's rounded-cube shape, slightly inside the real surface,
// and is hidden once you're close enough for the real blocks to be loaded around you.
const BODY_COLORS = { star: [1, 0.8, 0.35], verdant: [0.35, 0.6, 0.22], desert: [0.85, 0.78, 0.52], ice: [0.92, 0.96, 1], rocky: [0.48, 0.47, 0.46], volcanic: [0.32, 0.16, 0.12] };
const impostors = world.bodies.map((b) => {
  const g = new THREE.SphereGeometry(1, 64, 48);
  const pos = g.attributes.position, colors = [];
  const rand = mulberry32(Math.floor(b.seed * 1000));
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i);
    const k = Math.pow(Math.abs(v.x) ** 4 + Math.abs(v.y) ** 4 + Math.abs(v.z) ** 4, -1 / 4);
    pos.setXYZ(i, v.x * k, v.y * k, v.z * k);
    const shade = 0.85 + rand() * 0.15;
    colors.push(...BODY_COLORS[b.kind].map((c) => Math.pow(c * shade, 2.2)));
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }));
  mesh.position.set(b.center[0] + 0.5, b.center[1] + 0.5, b.center[2] + 0.5);
  mesh.scale.setScalar(b.R * 0.96);
  scene.add(mesh);
  return { body: b, mesh };
});

if (save?.player) player.restore(save.player);
else startNewGame();
player.syncCamera();

const hud = new Hud(renderBlockIcons(), save?.hotbar ?? HOTBAR);
let showDebug = false;

function persist() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      seed, world: world.serialize(), player: player.serialize(), hotbar: hud.items,
      ships: ships.map((ship) => ship.serialize()),
    }));
  } catch (e) {
    console.warn('Could not save world', e);
  }
}
setInterval(persist, 10000);
addEventListener('beforeunload', persist);

// ---------- input ----------

const menu = document.getElementById('menu');
const canvas = renderer.domElement;
let locked = false;

// Screens that free the mouse without pausing: the inventory and the navigation console.
const overlays = {
  inventory: { el: document.getElementById('inventory'), close: () => {} },
  console: { el: document.getElementById('console'), close: () => navConsole.close() },
};
let overlay = null; // name of the open overlay, if any

function openOverlay(name) {
  overlay = name;
  if (locked) document.exitPointerLock();
  else showOverlays();
}

// Close the overlay and go back to playing (or to the pause menu).
function closeOverlay(toMenu = false) {
  if (!overlay) return;
  overlays[overlay].close();
  overlay = null;
  showOverlays();
  if (toMenu) menu.classList.remove('hidden');
  else lock();
}

function showOverlays() {
  for (const [name, o] of Object.entries(overlays)) o.el.classList.toggle('hidden', locked || overlay !== name);
  menu.classList.toggle('hidden', locked || overlay !== null);
}

hud.buildInventory((id) => {
  hud.setItem(id);
  closeOverlay();
});

// The helm: which console the player is flying from (null when not piloting).
let helm = null;

const navConsole = new NavConsoleUI(hud.icons, B.THRUSTER, {
  onPilot: () => {
    helm = { ship: navConsole.ship, key: navConsole.consoleKey };
    player.piloting = true;
    closeOverlay();
    hud.toast('At the helm');
  },
  onClose: () => closeOverlay(),
  onHover: (key) => {
    thrusterMarker.visible = !!key;
    if (key) markThruster(navConsole.ship, key);
  },
});

// Outline a ship's thruster in the world (while hovering it on the console screen).
const thrusterMarker = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.1, 1.1, 1.1)),
  new THREE.LineBasicMaterial({ color: 0xffa040, depthTest: false }),
);
thrusterMarker.renderOrder = 10;
thrusterMarker.visible = false;
scene.add(thrusterMarker);
function markThruster(ship, key) {
  const t = ship.thrusters.get(key);
  if (!t) return;
  ship.localToWorld(tmpA.set(t.x + 0.5, t.y + 0.5, t.z + 0.5), thrusterMarker.position);
  thrusterMarker.quaternion.copy(ship.quaternion);
}

function leaveHelm() {
  helm = null;
  player.piloting = false;
}

function useConsole() {
  if (player.piloting) { leaveHelm(); hud.toast('Left the helm'); return; }
  if (!target || !BLOCKS[target.id].console) { hud.toast('Look at a navigation console to use it'); return; }
  if (!(target.grid instanceof Ship)) { hud.toast('This console isn\'t on a ship'); return; }
  if (player.ref !== target.grid) { hud.toast('Board the ship to use its console'); return; }
  const key = `${target.x},${target.y},${target.z}`;
  navConsole.consoleKey = key;
  navConsole.open(target.grid, key, target.grid.getMeta(target.x, target.y, target.z));
  openOverlay('console');
}

const lock = () => canvas.requestPointerLock();
document.getElementById('play').addEventListener('click', lock);
document.getElementById('new-world').addEventListener('click', () => {
  if (!confirm('Delete this world and generate a new one?')) return;
  removeEventListener('beforeunload', persist);
  localStorage.removeItem(SAVE_KEY);
  location.reload();
});
canvas.addEventListener('click', () => { if (!locked) lock(); });

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  showOverlays();
  if (!locked) { held.clear(); persist(); }
});

document.addEventListener('mousemove', (e) => {
  if (locked) player.look(e.movementX, e.movementY);
});

const held = new Map(); // mouse button -> seconds until next repeat
document.addEventListener('mousedown', (e) => {
  if (!locked) return;
  if (e.button !== 0) act(e.button); // left button mines continuously, see updateMining
  held.set(e.button, 0.3);
});
document.addEventListener('mouseup', (e) => held.delete(e.button));
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('wheel', (e) => { if (locked) hud.scroll(Math.sign(e.deltaY)); }, { passive: true });

addEventListener('keydown', (e) => {
  // At the helm, E fires thrusters instead of opening the inventory.
  if (e.code === 'KeyE' && !e.repeat && overlay !== 'console' && !player.piloting) {
    if (overlay === 'inventory') closeOverlay();
    else if (locked) openOverlay('inventory');
    return;
  }
  if (e.code === 'Escape' && overlay) {
    closeOverlay(true);
    return;
  }
  if (overlay) return;
  if (e.code.startsWith('Digit')) {
    const n = Number(e.code.slice(5));
    if (n >= 1 && n <= 9) hud.select(n - 1);
  } else if (e.code === 'KeyF') {
    player.toggleFly();
  } else if (e.code === 'KeyT' && locked && target) {
    rotateTarget(e.shiftKey);
  } else if (e.code === 'KeyN' && locked) {
    spawnShip();
  } else if (e.code === 'KeyR' && locked && !e.repeat) {
    useConsole();
  } else if (e.code === 'F3') {
    e.preventDefault();
    showDebug = !showDebug;
    hud.toggleDebug();
  }
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- block interaction ----------

let target = null;
const tmpDir = new THREE.Vector3();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

// Nearest block hit across the static world and every ship.
function raycastAll(origin, dir) {
  let best = world.raycast(origin, dir, REACH);
  if (best) best.grid = world;
  for (const ship of ships) {
    const hit = ship.raycast(ship.worldToLocal(origin, tmpA), ship.dirToLocal(dir, tmpB), best ? best.t : REACH);
    if (hit && (!best || hit.t < best.t)) { hit.grid = ship; best = hit; }
  }
  return best;
}

function act(button) {
  if (!target) return;
  const grid = target.grid;
  if (button === 2) {
    const x = target.x + target.nx, y = target.y + target.ny, z = target.z + target.nz;
    const existing = grid.getBlock(x, y, z);
    if (existing !== B.AIR && !BLOCKS[existing].liquid) return;
    const id = hud.current;
    if (BLOCKS[id].solid && player.overlapsBlock(grid, x, y, z)) return;
    // Fluids flow toward the local "down" (only in the world; on a ship they stay put).
    const meta = BLOCKS[id].liquid
      ? (grid === world ? fluids.sourceMeta(x, y, z) : encodeFluid(0, false, NO_DOWN))
      : placementRotation(id, grid);
    grid.setBlock(x, y, z, id, { meta });
  } else if (button === 1) {
    hud.setItem(target.id);
  }
}

// Orientation for a newly placed shaped block: it rests against the face you clicked, and a
// slope's low edge faces you, so it rises away from you like a ramp.
function placementRotation(id, grid) {
  if (BLOCKS[id].shape === SHAPE.FULL) return 0;
  const down = [-target.nx, -target.ny, -target.nz];
  const toward = grid.dirToLocal(tmpDir, tmpA).negate();
  toward.addScaledVector(tmpB.fromArray(down), -toward.dot(tmpB));
  if (toward.lengthSq() < 1e-6) {
    // Looking straight along the face normal: use the camera's up to pick a direction.
    grid.dirToLocal(tmpB.set(0, 1, 0).applyQuaternion(camera.quaternion), toward);
    toward.addScaledVector(tmpB.fromArray(down), -toward.dot(tmpB)).negate();
  }
  const a = [Math.abs(toward.x), Math.abs(toward.y), Math.abs(toward.z)];
  const axis = a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2;
  const front = [0, 0, 0];
  front[axis] = Math.sign(toward.getComponent(axis)) || 1;
  return rotationFor(down, front);
}

const AXIS_LABELS = ['-X', '+X', '-Y', '+Y', '-Z', '+Z'];

// Rotate the shaped block you're looking at. T spins it about its base; Shift+T moves its
// base to the next face (for gravity plates and slopes, that's the direction they pull).
function rotateTarget(changeBase) {
  const def = BLOCKS[target.id];
  if (def.shape === SHAPE.FULL) {
    hud.toast(def.gravity ? 'Gravity blocks pull toward themselves from every side' : 'Only shaped blocks can be rotated');
    return;
  }
  const { grid, x, y, z } = target;
  const meta = grid.getMeta(x, y, z);
  let down = applyRotation(meta, [0, -1, 0]);
  let front = applyRotation(meta, [0, 0, 1]);
  if (changeBase) {
    const i = DIRS.findIndex((d) => d[0] === down[0] && d[1] === down[1] && d[2] === down[2]);
    down = DIRS[(i + 1) % 6];
    if (Math.abs(down[0] * front[0] + down[1] * front[1] + down[2] * front[2]) === 1) front = [down[1], down[2], down[0]];
  } else {
    // Turn the front a quarter turn about the base direction.
    front = [down[1] * front[2] - down[2] * front[1], down[2] * front[0] - down[0] * front[2], down[0] * front[1] - down[1] * front[0]];
  }
  const damage = grid.getDamage(x, y, z);
  grid.setBlock(x, y, z, target.id, { meta: rotationFor(down, front) });
  if (damage) grid.setDamage(x, y, z, damage);
  const where = AXIS_LABELS[DIRS.findIndex((d) => d[0] === down[0] && d[1] === down[1] && d[2] === down[2])];
  hud.toast(def.gravity ? `Pulls toward ${where}${grid === world ? '' : ' (ship)'}` : `Base facing ${where}`);
}

// ---------- mining ----------

// Holding the left button wears a block down over its hardness time. Ordinary blocks heal
// if you stop; blocks with permanent damage (hull) keep their cracks, saved with the grid.
let mining = null; // { grid, x, y, z, id, progress }

function updateMining(dt) {
  const def = target && BLOCKS[target.id];
  if (!locked || !held.has(0) || !target || !def.breakable) { stopMining(); return; }
  const { grid, x, y, z } = target;
  if (!mining || mining.grid !== grid || mining.x !== x || mining.y !== y || mining.z !== z || mining.id !== target.id) {
    stopMining();
    mining = { grid, x, y, z, id: target.id, progress: def.permanentDamage ? grid.getDamage(x, y, z) : 0 };
  }
  mining.progress += dt / def.hardness;
  if (mining.progress >= 1) {
    grid.setBlock(x, y, z, B.AIR);
    if (grid instanceof Ship && grid.blockCount === 0) removeShip(grid);
    stopMining();
    return;
  }
  if (def.permanentDamage) {
    grid.setDamage(x, y, z, mining.progress);
  } else {
    breakOverlay.visible = true;
    grid.localToWorld(tmpA.set(x + 0.5, y + 0.5, z + 0.5), breakOverlay.position);
    breakOverlay.quaternion.copy(grid.quaternion);
    setBreakStage(crackStage(mining.progress));
  }
}

function stopMining() {
  mining = null;
  breakOverlay.visible = false;
}

// ---------- ships ----------

// The starter ship: a deck of gravity blocks (so you can stand on it in space), a sloped bow,
// a navigation console, and thrusters for moving, steering, and rolling, already mapped.
// Forward is -Z; stand at (0, 1, 3) behind the console to fly.
function buildStarterShip() {
  const ship = new Ship(scene, materials);
  for (let x = -2; x <= 2; x++) for (let z = -3; z <= 3; z++) ship.setBlock(x, 0, z, B.GRAVITY, { remesh: false });
  // A sloped bow so you can tell which way is forward.
  const bow = rotationFor([0, -1, 0], [0, 0, -1]);
  for (let x = -2; x <= 2; x++) ship.setBlock(x, 0, -4, B.HULL_SLOPE, { meta: bow, remesh: false });
  // A console at the stern facing aft (stand behind it to fly), a main engine on the stern,
  // a reverse thruster at the bow, two side thrusters at the bow for steering, and two pairs
  // of up/down thrusters along the sides for rolling.
  ship.setBlock(0, 1, 2, B.NAV_CONSOLE, { meta: rotationFor([0, -1, 0], [0, 0, 1]), remesh: false });
  const thruster = (x, y, z, base) => ship.setBlock(x, y, z, B.THRUSTER, { meta: rotationFor(base, base[1] ? [0, 0, 1] : [0, 1, 0]), remesh: false });
  thruster(0, 0, 4, [0, 0, -1]);  // nozzle aft: pushes forward
  thruster(0, 1, -3, [0, 0, 1]);  // nozzle forward: pushes back
  thruster(3, 0, -3, [-1, 0, 0]); // nozzle starboard: swings the bow to port
  thruster(-3, 0, -3, [1, 0, 0]); // nozzle port: swings the bow to starboard
  thruster(-3, 0, 0, [0, 1, 0]);  // port, nozzle down: lifts the port side
  thruster(3, 0, 0, [0, -1, 0]);  // starboard, nozzle up: pushes the starboard side down
  thruster(-3, 0, 1, [0, -1, 0]); // port, nozzle up
  thruster(3, 0, 1, [0, 1, 0]);   // starboard, nozzle down
  Object.assign(ship.consoleBindings('0,1,2'), {
    W: ['0,0,4'], S: ['0,1,-3'], A: ['3,0,-3'], D: ['-3,0,-3'],
    Q: ['-3,0,1', '3,0,1'], // roll left
    E: ['-3,0,0', '3,0,0'], // roll right
  });
  return ship;
}

// Spawn a starter ship in front of the player, level with (or just above) their feet and
// aligned with their current gravity.
function spawnShip() {
  const ship = buildStarterShip();

  const forward = tmpA, right = tmpB;
  player.moveBasis(forward, right);
  const g = player.grid;
  const feet = player.worldPosition(new THREE.Vector3());
  const fwd = g.dirToWorld(forward, new THREE.Vector3());
  const up = g.dirToWorld(player.up, new THREE.Vector3());
  for (let lift = 0.5; lift <= 6.5; lift++) {
    // Rotate the deck so its bow points where the player faces.
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), player.yaw);
    ship.quaternion.copy(player.grid.quaternion).multiply(player.frame).multiply(yaw);
    ship.position.copy(feet).addScaledVector(fwd, 6).addScaledVector(up, lift);
    ship.syncTransform();
    if (!ship.intersectsAnything(world, ships)) {
      ship.remeshAll();
      ships.push(ship);
      hud.toast('Ship spawned');
      return;
    }
  }
  ship.dispose();
  hud.toast('No room for a ship here');
}

// A new game: the player stands on their own ship in open space near the home planet.
function startNewGame() {
  const spawn = world.findSpawn();
  const ship = buildStarterShip();
  // Point the bow at the home planet.
  ship.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), new THREE.Vector3(...spawn.toward));
  ship.position.set(...spawn.position);
  ship.syncTransform();
  ship.remeshAll();
  ships.push(ship);
  player.boardAt(ship, new THREE.Vector3(0.5, 1.01, 3.5));
  player.pitch = -0.15;
  scatterMeteorites(new THREE.Vector3(...spawn.position));
}

// Meteorites: lumpy rocks of stone and ore drifting and tumbling around the spawn area. They
// are ships without controls, so they collide, can be mined, and fall into gravity wells.
function scatterMeteorites(around) {
  const rand = mulberry32(seed ^ 0xbeef);
  const ores = [B.STONE, B.STONE, B.COBBLE, B.IRON_ORE, B.COAL_ORE];
  for (let n = 0; n < METEORITES; n++) {
    const dir = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();
    const at = around.clone().addScaledVector(dir, 40 + rand() * 220);
    if (world.bodies.some((b) => at.distanceTo(new THREE.Vector3(...b.center)) < b.R * 1.6 + 8)) continue;
    const rock = new Ship(scene, materials);
    const r = 1.5 + rand() * 2.5;
    for (let x = -4; x <= 4; x++) for (let y = -4; y <= 4; y++) for (let z = -4; z <= 4; z++) {
      if (Math.hypot(x, y, z) > r + (rand() - 0.5) * 1.2) continue;
      rock.setBlock(x, y, z, ores[Math.floor(rand() * ores.length)], { remesh: false });
    }
    if (rock.blockCount === 0) continue;
    rock.position.copy(at);
    rock.quaternion.setFromEuler(new THREE.Euler(rand() * 6, rand() * 6, rand() * 6));
    rock.velocity.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).setLength(1.5 + rand() * 4);
    rock.angularVelocity.set(rand() - 0.5, rand() - 0.5, rand() - 0.5);
    rock.syncTransform();
    rock.remeshAll();
    ships.push(rock);
  }
}

function removeShip(ship) {
  if (player.ref === ship) player.setReference(null);
  ship.dispose();
  ships.splice(ships.indexOf(ship), 1);
}

// At the helm, each held key fires the thrusters bound to it on the console.
function fireThrusters() {
  for (const ship of ships) ship.firing.clear();
  if (!player.piloting || !helm || player.ref !== helm.ship || !ships.includes(helm.ship)) {
    if (helm) leaveHelm();
    return;
  }
  const [x, y, z] = helm.key.split(',').map(Number);
  if (!BLOCKS[helm.ship.getBlock(x, y, z)].console) { leaveHelm(); hud.toast('The console was destroyed'); return; }
  const bindings = helm.ship.consoleBindings(helm.key);
  for (const key of CONTROL_KEYS) {
    if (player.keys.has('Key' + key)) for (const t of bindings[key]) helm.ship.firing.add(t);
  }
}

// ---------- sky ----------

const WATER_FOG = new THREE.Color(0x1f4a8a);
const LAVA_FOG = new THREE.Color(0xc0400c);
const lavaFog = new THREE.Fog(LAVA_FOG, 0.2, 3);

function updateSky() {
  starfield.position.copy(camera.position);
  for (const { body, mesh } of impostors) {
    // Hidden once the real blocks around you are loaded.
    mesh.visible = camera.position.distanceTo(mesh.position) > body.R * 1.4 + 60;
  }
  const inLava = player.headFluid === B.LAVA;
  scene.fog = !player.headInWater ? null : inLava ? lavaFog : waterFog;
  scene.background.copy(!player.headInWater ? SPACE : inLava ? LAVA_FOG : WATER_FOG);
  const tint = document.getElementById('underwater');
  tint.classList.toggle('hidden', !player.headInWater);
  tint.classList.toggle('lava', inLava);
}

// ---------- main loop ----------

let last = performance.now();
let fps = 0, frames = 0, fpsTimer = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  const wp = player.worldPosition(new THREE.Vector3());
  world.update(wp.x, wp.y, wp.z, 8);
  if (locked) fluids.tick(dt);

  if (locked) {
    fireThrusters();
    for (const ship of ships) {
      ship.piloted = player.piloting && player.ref === ship;
      // Ships out where the world isn't loaded wait, rather than drift through unloaded planets.
      if (ship !== player.ref && !world.getChunkAt(ship.position.x, ship.position.y, ship.position.z)) continue;
      const impact = ship.update(dt, world, ships);
      if (impact > 4 && ship === player.ref) hud.toast('Collision!');
    }
  }
  for (const ship of ships) ship.updateFlames();

  // Hold physics until the chunk under the player exists, so we never fall through the world.
  if (locked && (player.ref || world.getChunkAt(wp.x, wp.y, wp.z))) player.update(dt);
  else player.syncCamera();

  camera.getWorldDirection(tmpDir);
  target = raycastAll(camera.position, tmpDir);
  highlight.visible = !!target;
  if (target) {
    target.grid.localToWorld(tmpA.set(target.x + 0.5, target.y + 0.5, target.z + 0.5), highlight.position);
    highlight.quaternion.copy(target.grid.quaternion);
  }
  updateStatus();

  updateMining(dt);
  for (const [button, t] of held) {
    if (button === 0) continue;
    const next = t - dt;
    if (next <= 0) { act(button); held.set(button, 0.2); } else held.set(button, next);
  }

  updateSky();
  renderer.render(scene, camera);

  frames++;
  fpsTimer += dt;
  if (fpsTimer >= 0.5) { fps = Math.round(frames / fpsTimer); frames = 0; fpsTimer = 0; }
  if (showDebug) {
    const p = wp;
    const ship = player.ref;
    hud.setDebug([
      `VoxelCraft  ${fps} fps`,
      `XYZ: ${p.x.toFixed(2)} / ${p.y.toFixed(2)} / ${p.z.toFixed(2)}`,
      `Chunk: ${Math.floor(p.x / CS)}, ${Math.floor(p.y / CS)}, ${Math.floor(p.z / CS)}   loaded: ${world.chunks.size}`,
      `Facing: ${target ? `${BLOCKS[target.id].name} @ ${target.x} ${target.y} ${target.z}${target.grid === world ? '' : ' (ship)'}  damage ${Math.round(target.grid.getDamage(target.x, target.y, target.z) * 100)}%` : '-'}`,
      (() => { const { body, altitude } = world.nearestBody(p); return `Nearest body: ${body.name} (${body.kind}, ${body.R * 2} wide, surface gravity ${Math.round(body.surfaceG * 100)}%)  altitude ${Math.round(altitude)}`; })(),
      `Ships: ${ships.length}   riding: ${ship ? `ship #${ships.indexOf(ship)} (${ship.blockCount} blocks, mass ${ship.mass.toFixed(1)}, ${ship.velocity.length().toFixed(1)} m/s${ship.buoyancy > 0 ? `, ${Math.round(ship.buoyancy * 100)}% submerged` : ''}${ship.sleeping ? ', resting' : ''})` : 'world'}`,
      `Mode: ${player.flying ? 'flying' : player.zeroG ? 'zero-g' : player.inWater ? 'swimming' : 'walking'}   gravity: ${player.gravityLabel()} ${Math.round(player.gravityStrength * 100)}%   seed: ${seed}`,
      `Draw calls: ${renderer.info.render.calls}  tris: ${renderer.info.render.triangles}`,
    ].join('\n'));
  }
}
requestAnimationFrame(frame);

const statusEl = document.getElementById('status');
function updateStatus() {
  const ship = player.ref;
  let text = '';
  if (!ship || !player.piloting) {
    const { body, altitude } = world.nearestBody(player.worldPosition(tmpA));
    const where = altitude < body.range - body.R ? `${body.name}  ·  ` : '';
    if (player.zeroG) text = 'ZERO-G  ·  WASD / Space / Shift jetpack';
    else if (Math.abs(player.gravityStrength - 1) > 0.03 && !player.flying) text = `${where}Gravity ${Math.round(player.gravityStrength * 100)}%`;
    else if (where && altitude > 3) text = `${body.name}  ·  altitude ${Math.round(altitude)}`;
  }
  if (ship && player.piloting) {
    text = `AT THE HELM  ${ship.velocity.length().toFixed(1)} m/s  ·  Q W E A S D fire thrusters  ·  R leave the helm`;
  } else if (ship) {
    const drift = ship.velocity.length();
    text = `Aboard ship${drift > 0.05 ? ` (drifting ${drift.toFixed(1)} m/s)` : ''}  ·  R at a navigation console to fly${text ? `  ·  ${text}` : ''}`;
  }
  if (statusEl.textContent !== text) statusEl.textContent = text;
  statusEl.classList.toggle('hidden', !text);
}

// Exposed for debugging from the browser console.
window.game = { world, ships, player, hud, camera, renderer, fluids, spawnShip, removeShip, navConsole, useConsole, fireThrusters, getHelm: () => helm, setTarget: (t) => { target = t; } };
