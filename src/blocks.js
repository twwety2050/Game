// Block registry. Texture values are tile indices into the generated atlas (see textures.js).

export const B = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, LOG: 5, LEAVES: 6, PLANKS: 7,
  COBBLE: 8, GLASS: 9, WATER: 10, BEDROCK: 11, BRICK: 12, SNOW: 13, COAL_ORE: 14, IRON_ORE: 15,
};

export const T = {
  GRASS_TOP: 0, GRASS_SIDE: 1, DIRT: 2, STONE: 3, SAND: 4, LOG_SIDE: 5, LOG_TOP: 6, LEAVES: 7,
  PLANKS: 8, COBBLE: 9, GLASS: 10, WATER: 11, BEDROCK: 12, BRICK: 13, SNOW: 14, SNOW_SIDE: 15,
  COAL_ORE: 16, IRON_ORE: 17,
};

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
    occludes: opts.occludes ?? (opts.opaque ?? true), // casts ambient occlusion
    breakable: opts.breakable ?? true,
  };
}

def(B.AIR, 'Air', { all: 0 }, { solid: false, opaque: false });
def(B.GRASS, 'Grass Block', { top: T.GRASS_TOP, side: T.GRASS_SIDE, bottom: T.DIRT });
def(B.DIRT, 'Dirt', { all: T.DIRT });
def(B.STONE, 'Stone', { all: T.STONE });
def(B.SAND, 'Sand', { all: T.SAND });
def(B.LOG, 'Oak Log', { top: T.LOG_TOP, side: T.LOG_SIDE, bottom: T.LOG_TOP });
def(B.LEAVES, 'Oak Leaves', { all: T.LEAVES }, { opaque: false, selfFaces: true, occludes: true });
def(B.PLANKS, 'Oak Planks', { all: T.PLANKS });
def(B.COBBLE, 'Cobblestone', { all: T.COBBLE });
def(B.GLASS, 'Glass', { all: T.GLASS }, { opaque: false });
def(B.WATER, 'Water', { all: T.WATER }, { solid: false, opaque: false, liquid: true, breakable: false });
def(B.BEDROCK, 'Bedrock', { all: T.BEDROCK }, { breakable: false });
def(B.BRICK, 'Bricks', { all: T.BRICK });
def(B.SNOW, 'Snowy Grass', { top: T.SNOW, side: T.SNOW_SIDE, bottom: T.DIRT });
def(B.COAL_ORE, 'Coal Ore', { all: T.COAL_ORE });
def(B.IRON_ORE, 'Iron Ore', { all: T.IRON_ORE });

export const HOTBAR = [B.GRASS, B.DIRT, B.STONE, B.COBBLE, B.PLANKS, B.LOG, B.BRICK, B.GLASS, B.SAND];
