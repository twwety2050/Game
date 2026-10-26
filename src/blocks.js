// Block registry. Texture values are tile indices into the generated atlas (see textures.js).
import { SHAPE, shapeVolume } from './shapes.js';

export const B = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, LOG: 5, LEAVES: 6, PLANKS: 7,
  COBBLE: 8, GLASS: 9, WATER: 10, BEDROCK: 11, BRICK: 12, SNOW: 13, COAL_ORE: 14, IRON_ORE: 15,
  HULL: 16, HULL_SLAB: 17, HULL_PLATE: 18, HULL_SLOPE: 19, HULL_SLOPE_LOW: 20, HULL_SLOPE_HIGH: 21,
  GRAVITY: 22, GRAVITY_SLAB: 23, GRAVITY_SLOPE: 24, GRAVITY_SLOPE_LOW: 25, GRAVITY_SLOPE_HIGH: 26,
};

export const T = {
  GRASS_TOP: 0, GRASS_SIDE: 1, DIRT: 2, STONE: 3, SAND: 4, LOG_SIDE: 5, LOG_TOP: 6, LEAVES: 7,
  PLANKS: 8, COBBLE: 9, GLASS: 10, WATER: 11, BEDROCK: 12, BRICK: 13, SNOW: 14, SNOW_SIDE: 15,
  COAL_ORE: 16, IRON_ORE: 17, HULL: 18, GRAVITY: 19, GRAVITY_SIDE: 20,
  CRACK: 24, // 8 crack stages: tiles 24..31
};
export const CRACK_STAGES = 8;

export const BLOCKS = [];

function def(id, name, tex, opts = {}) {
  BLOCKS[id] = {
    id,
    name,
    top: tex.top ?? tex.all,
    side: tex.side ?? tex.all,
    bottom: tex.bottom ?? tex.all,
    solid: opts.solid ?? true,          // collides with the player
    opaque: opts.opaque ?? true,        // hides neighbouring faces
    liquid: opts.liquid ?? false,
    selfFaces: opts.selfFaces ?? false, // draw faces between two blocks of this type (leaves)
    shape: opts.shape ?? SHAPE.FULL,
    // Shaped blocks don't fill their cell, so they cast no ambient occlusion.
    occludes: opts.occludes ?? ((opts.opaque ?? true) && (opts.shape ?? SHAPE.FULL) === SHAPE.FULL),
    breakable: opts.breakable ?? true,
    hardness: opts.hardness ?? 1,                 // seconds to break by hand
    permanentDamage: opts.permanentDamage ?? false, // cracks stay when you stop mining
    placeable: opts.placeable ?? true,            // shown in the inventory
    // Gravity generator: 'radial' pulls toward the block from every side, 'directional'
    // pulls toward the block's base (its canonical -Y, rotated by its orientation).
    gravity: opts.gravity ?? null,
    // Density relative to water (below 1 floats). A block's mass is density x shape volume.
    density: opts.density ?? 1,
    mass: (opts.density ?? 1) * shapeVolume(opts.shape ?? SHAPE.FULL),
  };
}

def(B.AIR, 'Air', { all: 0 }, { solid: false, opaque: false, placeable: false });
def(B.GRASS, 'Grass Block', { top: T.GRASS_TOP, side: T.GRASS_SIDE, bottom: T.DIRT }, { hardness: 0.6, density: 1.5 });
def(B.DIRT, 'Dirt', { all: T.DIRT }, { hardness: 0.5, density: 1.5 });
def(B.STONE, 'Stone', { all: T.STONE }, { hardness: 1.5, density: 2.4 });
def(B.SAND, 'Sand', { all: T.SAND }, { hardness: 0.5, density: 1.6 });
def(B.LOG, 'Oak Log', { top: T.LOG_TOP, side: T.LOG_SIDE, bottom: T.LOG_TOP }, { hardness: 1.0, density: 0.7 });
def(B.LEAVES, 'Oak Leaves', { all: T.LEAVES }, { opaque: false, selfFaces: true, occludes: true, hardness: 0.2, density: 0.3 });
def(B.PLANKS, 'Oak Planks', { all: T.PLANKS }, { hardness: 1.0, density: 0.6 });
def(B.COBBLE, 'Cobblestone', { all: T.COBBLE }, { hardness: 1.5, density: 2.2 });
def(B.GLASS, 'Glass', { all: T.GLASS }, { opaque: false, hardness: 0.3, density: 1.5 });
def(B.WATER, 'Water', { all: T.WATER }, { solid: false, opaque: false, liquid: true, breakable: false, placeable: false });
def(B.BEDROCK, 'Bedrock', { all: T.BEDROCK }, { breakable: false, placeable: false });
def(B.BRICK, 'Bricks', { all: T.BRICK }, { hardness: 1.5, density: 2.0 });
def(B.SNOW, 'Snowy Grass', { top: T.SNOW, side: T.SNOW_SIDE, bottom: T.DIRT }, { hardness: 0.6, density: 1.5 });
def(B.COAL_ORE, 'Coal Ore', { all: T.COAL_ORE }, { hardness: 2, density: 2.6 });
def(B.IRON_ORE, 'Iron Ore', { all: T.IRON_ORE }, { hardness: 2.5, density: 3.5 });

// Ship hull: thin metal plating around a light frame (so hulls float), with permanent damage.
const hull = (shape) => ({ shape, hardness: 4, permanentDamage: true, density: 0.5 });
def(B.HULL, 'Hull Block', { all: T.HULL }, hull(SHAPE.FULL));
def(B.HULL_SLAB, 'Hull Half Block', { all: T.HULL }, hull(SHAPE.SLAB));
def(B.HULL_PLATE, 'Hull Plate', { all: T.HULL }, hull(SHAPE.PLATE));
def(B.HULL_SLOPE, 'Hull Slope 45°', { all: T.HULL }, hull(SHAPE.SLOPE));
def(B.HULL_SLOPE_LOW, 'Hull Slope 26.6° (low)', { all: T.HULL }, hull(SHAPE.SLOPE_LOW));
def(B.HULL_SLOPE_HIGH, 'Hull Slope 26.6° (high)', { all: T.HULL }, hull(SHAPE.SLOPE_HIGH));

// Gravity generators. The emitter face is the one you stand on; shaped ones pull toward their base.
const grav = (shape) => ({ shape, hardness: 4, permanentDamage: true, density: 0.8, gravity: shape === SHAPE.FULL ? 'radial' : 'directional' });
const gravTex = { top: T.GRAVITY, side: T.GRAVITY_SIDE, bottom: T.GRAVITY_SIDE };
def(B.GRAVITY, 'Gravity Block', { all: T.GRAVITY }, grav(SHAPE.FULL));
def(B.GRAVITY_SLAB, 'Gravity Plate', gravTex, grav(SHAPE.SLAB));
def(B.GRAVITY_SLOPE, 'Gravity Slope 45°', gravTex, grav(SHAPE.SLOPE));
def(B.GRAVITY_SLOPE_LOW, 'Gravity Slope 26.6° (low)', gravTex, grav(SHAPE.SLOPE_LOW));
def(B.GRAVITY_SLOPE_HIGH, 'Gravity Slope 26.6° (high)', gravTex, grav(SHAPE.SLOPE_HIGH));

export const HOTBAR = [B.HULL, B.HULL_SLAB, B.HULL_PLATE, B.HULL_SLOPE, B.HULL_SLOPE_LOW, B.HULL_SLOPE_HIGH, B.GRAVITY_SLAB, B.GRAVITY, B.GLASS];
