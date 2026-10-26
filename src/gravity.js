// The gravity field: where "down" is, and how strong it is, at any point in the world.
//
// Sources are gravity generator blocks (in the world or on ships) and the terrain itself,
// which acts as a large body. Each source pulls with a strength in [0, 1]:
//   - full strength within FULL_RANGE of the block, so walking and jumping feel normal,
//   - then decaying with distance, reaching zero at RANGE.
// Radial blocks (full gravity blocks) pull toward their nearest point from every side.
// Directional blocks (plates and slopes) pull toward their base, and only on the side their
// emitter faces.
//
// Sources combine without stacking: the direction is the strength-weighted average, and the
// strength is that of the strongest source, so a floor of many plates pulls like one.
// Generators override the terrain's pull in proportion to their strength.
import * as THREE from 'three';
import { BLOCKS } from './blocks.js';
import { applyRotation } from './shapes.js';
import { TERRAIN_HEIGHT } from './world.js';

export const G = 28;           // acceleration at full strength, blocks/s^2 (players and ships)
export const FULL_RANGE = 2.5; // blocks from the generator's surface to the body's centre
export const RANGE = 10;
const TERRAIN_FULL_RANGE = 16; // distance from the terrain layer with full terrain gravity
const TERRAIN_RANGE = 128;

const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _sum = new THREE.Vector3();

// Strength at `dist` blocks from a source with the given full-strength and cut-off ranges.
export function falloff(dist, full = FULL_RANGE, range = RANGE) {
  if (dist <= full) return 1;
  if (dist >= range) return 0;
  // Inverse-square decay, faded smoothly to zero at the edge of the range.
  const fade = 1 - THREE.MathUtils.smoothstep(dist, range * 0.6, range);
  return (full / dist) ** 2 * fade;
}

// Pull of one generator block on local point p. Writes the pull direction (unit, grid-local)
// into `out` and returns the strength (0 if it doesn't act on p).
function sourcePull(src, p, out) {
  // Nearest point of the block's cell to p.
  const qx = THREE.MathUtils.clamp(p.x, src.x, src.x + 1);
  const qy = THREE.MathUtils.clamp(p.y, src.y, src.y + 1);
  const qz = THREE.MathUtils.clamp(p.z, src.z, src.z + 1);
  out.set(qx - p.x, qy - p.y, qz - p.z);
  const dist = out.length();
  if (BLOCKS[src.id].gravity === 'radial') {
    if (dist < 1e-6) return 0;
    out.divideScalar(dist);
    return falloff(dist);
  }
  const down = applyRotation(src.meta, [0, -1, 0]);
  // Only acts on the emitter side: p must be above the block's centre along "up".
  const above = -((p.x - src.x - 0.5) * down[0] + (p.y - src.y - 0.5) * down[1] + (p.z - src.z - 0.5) * down[2]);
  if (above <= 0) return 0;
  out.set(down[0], down[1], down[2]);
  return falloff(dist);
}

// Gravity at world point `wp`. Writes the pull into `out` (world space; its length is the
// strength in [0, 1]) and returns `out`. Gravity blocks on `exclude` (a ship asking about
// itself) are ignored: a ship isn't pulled by its own generators.
export function gravityAt(wp, world, ships, out = new THREE.Vector3(), exclude = null) {
  _sum.set(0, 0, 0);
  let strongest = 0;
  for (const grid of [world, ...ships]) {
    if (grid === exclude || grid.gravitySources.size === 0) continue;
    if (grid !== world && (grid.updateShape(), wp.distanceTo(grid.position) > grid.radius + RANGE + 1)) continue;
    grid.worldToLocal(wp, _p);
    grid.forEachGravitySource(_p, RANGE, (src) => {
      const s = sourcePull(src, _p, _d);
      if (s <= 0) return;
      _sum.addScaledVector(grid.dirToWorld(_d, _d), s);
      if (s > strongest) strongest = s;
    });
  }

  // The terrain layer (0 <= y < TERRAIN_HEIGHT) is a large body pulling toward itself.
  const dist = wp.y > TERRAIN_HEIGHT ? wp.y - TERRAIN_HEIGHT : wp.y < 0 ? -wp.y : 0;
  const terrain = falloff(dist, TERRAIN_FULL_RANGE, TERRAIN_RANGE) * (1 - strongest);
  if (terrain > 0) {
    _sum.y += (wp.y < 0 ? 1 : -1) * terrain;
    strongest = Math.max(strongest, terrain);
  }

  if (_sum.lengthSq() < 1e-10) return out.set(0, 0, 0);
  return out.copy(_sum).normalize().multiplyScalar(strongest);
}
