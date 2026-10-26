import * as THREE from 'three';
import { createAtlas } from './textures.js';
import { B, BLOCKS, HOTBAR } from './blocks.js';
import { World, CS } from './world.js';
import { Ship } from './ship.js';
import { Player } from './player.js';
import { Hud } from './hud.js';

const SAVE_KEY = 'voxelcraft-save-v2';
const REACH = 6;
const DAY_LENGTH = 600; // seconds for a full day/night cycle
const RENDER_DISTANCE = 3; // in chunks, on every axis
const SHIP_ACCEL = 12;     // blocks/s^2 of thrust while piloting
const SHIP_MAX_SPEED = 40;
const SHIP_TURN_RATE = 0.8; // radians/s

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
const ships = (save?.ships ?? []).map((data) => Ship.deserialize(data, scene, solidMat, waterMat));
const player = new Player(camera, world, ships);
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
  } else if (e.code === 'KeyN' && locked) {
    spawnShip();
  } else if (e.code === 'KeyR' && locked) {
    if (player.ref) {
      player.piloting = !player.piloting;
      hud.toast(player.piloting ? 'Piloting' : 'Left the controls');
    } else {
      hud.toast('Stand on a ship to pilot it');
    }
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
  if (button === 0) {
    if (!BLOCKS[target.id].breakable) return;
    grid.setBlock(target.x, target.y, target.z, B.AIR);
    if (grid instanceof Ship && grid.blockCount === 0) removeShip(grid);
  } else if (button === 2) {
    const x = target.x + target.nx, y = target.y + target.ny, z = target.z + target.nz;
    const existing = grid.getBlock(x, y, z);
    if (existing !== B.AIR && !BLOCKS[existing].liquid) return;
    if (BLOCKS[hud.current].solid && player.overlapsBlock(grid, x, y, z)) return;
    grid.setBlock(x, y, z, hud.current);
  } else if (button === 1) {
    hud.setItem(target.id);
  }
}

// ---------- ships ----------

// Spawn a small starter deck in front of the player, level with (or just above) their feet
// and aligned with their current gravity.
function spawnShip() {
  const ship = new Ship(scene, solidMat, waterMat);
  for (let x = -2; x <= 2; x++) for (let z = -3; z <= 3; z++) ship.setBlock(x, 0, z, B.PLANKS, { remesh: false });
  ship.setBlock(0, 0, -3, B.COBBLE, { remesh: false }); // marks the bow

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

function removeShip(ship) {
  if (player.ref === ship) player.setReference(null);
  ship.dispose();
  ships.splice(ships.indexOf(ship), 1);
}

const thrust = new THREE.Vector3();
const spin = new THREE.Vector3();

// Fly the ship the player is standing on. Thrust follows the player's view; with no input
// the inertial dampeners bring it to rest. Leave the controls and it keeps drifting.
function pilotShip(dt) {
  const ship = player.ref;
  if (!ship) { player.piloting = false; return; }
  if (!player.piloting) return;
  const k = player.keys;
  const forward = tmpA, right = tmpB;
  player.moveBasis(forward, right);
  thrust.set(0, 0, 0);
  if (k.has('KeyW')) thrust.add(forward);
  if (k.has('KeyS')) thrust.sub(forward);
  if (k.has('KeyD')) thrust.add(right);
  if (k.has('KeyA')) thrust.sub(right);
  if (k.has('Space')) thrust.add(player.up);
  if (k.has('ShiftLeft') || k.has('ShiftRight')) thrust.sub(player.up);

  if (k.has('KeyX')) {
    ship.velocity.multiplyScalar(Math.exp(-6 * dt));
  } else if (thrust.lengthSq() > 0) {
    ship.velocity.addScaledVector(ship.dirToWorld(thrust.normalize(), thrust), SHIP_ACCEL * dt);
  } else {
    ship.velocity.multiplyScalar(Math.exp(-1.5 * dt));
  }
  if (ship.velocity.length() > SHIP_MAX_SPEED) ship.velocity.setLength(SHIP_MAX_SPEED);
  if (ship.velocity.lengthSq() < 1e-4 && thrust.lengthSq() === 0) ship.velocity.set(0, 0, 0);

  const turn = (k.has('KeyQ') ? 1 : 0) - (k.has('KeyE') ? 1 : 0);
  ship.dirToWorld(player.up, spin).multiplyScalar(turn * SHIP_TURN_RATE);
  ship.angularVelocity.lerp(spin, Math.min(1, 4 * dt));
  if (!turn && ship.angularVelocity.lengthSq() < 1e-6) ship.angularVelocity.set(0, 0, 0);
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

  const wp = player.worldPosition(new THREE.Vector3());
  world.update(wp.x, wp.y, wp.z, 8);

  if (locked) {
    pilotShip(dt);
    for (const ship of ships) {
      if (ship.update(dt, world, ships) === 'collided' && ship === player.ref) hud.toast('Collision!');
    }
  }

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
    const p = wp;
    const ship = player.ref;
    hud.setDebug([
      `VoxelCraft  ${fps} fps`,
      `XYZ: ${p.x.toFixed(2)} / ${p.y.toFixed(2)} / ${p.z.toFixed(2)}`,
      `Chunk: ${Math.floor(p.x / CS)}, ${Math.floor(p.y / CS)}, ${Math.floor(p.z / CS)}   loaded: ${world.chunks.size}`,
      `Facing: ${target ? `${BLOCKS[target.id].name} @ ${target.x} ${target.y} ${target.z}${target.grid === world ? '' : ' (ship)'}` : '-'}`,
      `Ships: ${ships.length}   riding: ${ship ? `ship #${ships.indexOf(ship)} (${ship.blockCount} blocks, ${ship.velocity.length().toFixed(1)} m/s)` : 'world'}`,
      `Mode: ${player.flying ? 'flying' : player.inWater ? 'swimming' : 'walking'}   gravity: ${player.gravityLabel()}   seed: ${seed}`,
      `Draw calls: ${renderer.info.render.calls}  tris: ${renderer.info.render.triangles}`,
    ].join('\n'));
  }
}
requestAnimationFrame(frame);

const statusEl = document.getElementById('status');
function updateStatus() {
  const ship = player.ref;
  let text = '';
  if (ship && player.piloting) {
    text = `PILOTING  ${ship.velocity.length().toFixed(1)} m/s  ·  WASD / Space / Shift thrust  ·  Q/E turn  ·  X brake  ·  R leave controls`;
  } else if (ship) {
    const drift = ship.velocity.length();
    text = `Aboard ship${drift > 0.05 ? ` (drifting ${drift.toFixed(1)} m/s)` : ''}  ·  R to pilot`;
  }
  if (statusEl.textContent !== text) statusEl.textContent = text;
  statusEl.classList.toggle('hidden', !text);
}

// Exposed for debugging from the browser console.
window.game = { world, ships, player, hud, camera, renderer, spawnShip, removeShip, pilotShip };
