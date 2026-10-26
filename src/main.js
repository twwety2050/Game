import * as THREE from 'three';
import { createAtlas } from './textures.js';
import { B, BLOCKS, HOTBAR } from './blocks.js';
import { World, CS } from './world.js';
import { Player } from './player.js';
import { Hud } from './hud.js';

const SAVE_KEY = 'voxelcraft-save-v2';
const REACH = 6;
const DAY_LENGTH = 600; // seconds for a full day/night cycle
const RENDER_DISTANCE = 3; // in chunks, on every axis

let save = null;
try { save = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch { save = null; }
const seed = save?.seed ?? Math.floor(Math.random() * 2 ** 31);

// ---------- renderer & scene ----------

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 1000);
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

const fogFar = RENDER_DISTANCE * CS;
scene.fog = new THREE.Fog(0x87ceeb, fogFar * 0.55, fogFar);
scene.background = new THREE.Color(0x87ceeb);

// Square sun and moon, kept at a fixed distance around the camera.
const sun = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshBasicMaterial({ color: 0xfff3b0, fog: false }));
const moon = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ color: 0xdde6f0, fog: false }));
scene.add(sun, moon);

const highlight = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
  new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 }),
);
highlight.visible = false;
scene.add(highlight);

// ---------- game objects ----------

const world = new World(scene, solidMat, waterMat, seed, save?.edits, RENDER_DISTANCE);
const player = new Player(camera, world);
if (save?.player) player.restore(save.player);
else player.spawn(world.findSpawn());
player.syncCamera();

const hud = new Hud(atlas, save?.hotbar ?? HOTBAR);
let time = save?.time ?? 0.3;
let showDebug = false;

function persist() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      seed, time, edits: world.serializeEdits(), player: player.serialize(), hotbar: hud.items,
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
  menu.classList.toggle('hidden', locked);
  if (!locked) { held.clear(); persist(); }
});

document.addEventListener('mousemove', (e) => {
  if (locked) player.look(e.movementX, e.movementY);
});

const held = new Map(); // mouse button -> seconds until next repeat
document.addEventListener('mousedown', (e) => {
  if (!locked) return;
  act(e.button);
  held.set(e.button, 0.3);
});
document.addEventListener('mouseup', (e) => held.delete(e.button));
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('wheel', (e) => { if (locked) hud.scroll(Math.sign(e.deltaY)); }, { passive: true });

addEventListener('keydown', (e) => {
  if (e.code.startsWith('Digit')) {
    const n = Number(e.code.slice(5));
    if (n >= 1 && n <= 9) hud.select(n - 1);
  } else if (e.code === 'KeyF') {
    player.toggleFly();
  } else if (e.code === 'KeyG' && locked && target) {
    // Make the face you're looking at the floor: gravity pulls into that block.
    if (player.setUp(new THREE.Vector3(target.nx, target.ny, target.nz))) hud.toast(`Gravity ${player.gravityLabel()}`);
    else if (!player.up.equals(new THREE.Vector3(target.nx, target.ny, target.nz))) hud.toast('No room to turn');
  } else if (e.code === 'KeyH' && locked) {
    if (player.setUp(new THREE.Vector3(0, 1, 0))) hud.toast('Gravity reset');
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

function act(button) {
  if (!target) return;
  if (button === 0) {
    if (BLOCKS[target.id].breakable) world.setBlock(target.x, target.y, target.z, B.AIR);
  } else if (button === 2) {
    const x = target.x + target.nx, y = target.y + target.ny, z = target.z + target.nz;
    const existing = world.getBlock(x, y, z);
    if (existing !== B.AIR && !BLOCKS[existing].liquid) return;
    if (BLOCKS[hud.current].solid && player.intersectsBlock(x, y, z)) return;
    world.setBlock(x, y, z, hud.current);
  } else if (button === 1) {
    hud.setItem(target.id);
  }
}

// ---------- sky ----------

const DAY_SKY = new THREE.Color(0x87ceeb);
const NIGHT_SKY = new THREE.Color(0x0b1026);
const SUNSET = new THREE.Color(0xf08a4b);
const WATER_FOG = new THREE.Color(0x1f4a8a);
const skyColor = new THREE.Color();

function updateSky(dt) {
  time = (time + dt / DAY_LENGTH) % 1;
  const angle = time * Math.PI * 2;
  const sunHeight = Math.sin(angle);
  const daylight = THREE.MathUtils.smoothstep(sunHeight, -0.25, 0.25);
  skyColor.copy(NIGHT_SKY).lerp(DAY_SKY, daylight);
  const dusk = Math.max(0, 1 - Math.abs(sunHeight) * 4) * 0.45;
  skyColor.lerp(SUNSET, dusk);

  const brightness = 0.22 + 0.78 * daylight;
  solidMat.color.setScalar(brightness);
  waterMat.color.setScalar(brightness);

  const dir = new THREE.Vector3(Math.cos(angle), sunHeight, 0.25).normalize();
  sun.position.copy(camera.position).addScaledVector(dir, 400);
  moon.position.copy(camera.position).addScaledVector(dir, -400);
  sun.lookAt(camera.position);
  moon.lookAt(camera.position);

  if (player.headInWater) {
    scene.fog.color.copy(WATER_FOG).multiplyScalar(brightness);
    scene.fog.near = 1;
    scene.fog.far = 24;
    scene.background.copy(scene.fog.color);
  } else {
    scene.fog.color.copy(skyColor);
    scene.fog.near = fogFar * 0.55;
    scene.fog.far = fogFar;
    scene.background.copy(skyColor);
  }
  document.getElementById('underwater').classList.toggle('hidden', !player.headInWater);
}

// ---------- main loop ----------

let last = performance.now();
let fps = 0, frames = 0, fpsTimer = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  world.update(player.pos.x, player.pos.y, player.pos.z, 8);

  // Hold physics until the chunk under the player exists, so we never fall through the world.
  if (locked && world.getChunkAt(player.pos.x, player.pos.y, player.pos.z)) player.update(dt);
  else player.syncCamera();

  camera.getWorldDirection(tmpDir);
  target = world.raycast(camera.position, tmpDir, REACH);
  highlight.visible = !!target;
  if (target) highlight.position.set(target.x + 0.5, target.y + 0.5, target.z + 0.5);

  for (const [button, t] of held) {
    const next = t - dt;
    if (next <= 0) { act(button); held.set(button, 0.2); } else held.set(button, next);
  }

  updateSky(locked ? dt : 0);
  renderer.render(scene, camera);

  frames++;
  fpsTimer += dt;
  if (fpsTimer >= 0.5) { fps = Math.round(frames / fpsTimer); frames = 0; fpsTimer = 0; }
  if (showDebug) {
    const p = player.pos;
    hud.setDebug([
      `VoxelCraft  ${fps} fps`,
      `XYZ: ${p.x.toFixed(2)} / ${p.y.toFixed(2)} / ${p.z.toFixed(2)}`,
      `Chunk: ${Math.floor(p.x / CS)}, ${Math.floor(p.y / CS)}, ${Math.floor(p.z / CS)}   loaded: ${world.chunks.size}`,
      `Facing: ${target ? `${BLOCKS[target.id].name} @ ${target.x} ${target.y} ${target.z}` : '-'}`,
      `Mode: ${player.flying ? 'flying' : player.inWater ? 'swimming' : 'walking'}   gravity: ${player.gravityLabel()}   seed: ${seed}`,
      `Draw calls: ${renderer.info.render.calls}  tris: ${renderer.info.render.triangles}`,
    ].join('\n'));
  }
}
requestAnimationFrame(frame);

// Exposed for debugging from the browser console.
window.game = { world, player, hud, camera, renderer };
