# Game Vision

This is a living document describing the game we are building. It is **not** a straight Minecraft clone: it reuses
Minecraft's core systems (a voxel world, building block by block, crafting) but is set in space.

## Core idea

- **Space, not terrain.** The world is mostly empty space: a starfield and the void, not an endless landscape to
  walk across.
- **Build ships from blocks.** Players build ships out of voxel blocks, using the same building system as the rest
  of the game.
- **Fly your ship.** A finished ship can be piloted and flown through space.

## Gravity

- **Zero-g by default.** Away from a gravity source, the player drifts weightlessly in the direction they were
  already moving.
- **Gravity plates.** The player can build a gravity plate block. While standing on gravity plates, they get normal
  "down" gravity, which lets them walk around inside a ship.
- **Large bodies attract.** Large bodies (asteroids, planets and so on) pull the player and other objects toward
  them slightly, like real gravity: the bigger the body and the closer you are, the stronger the pull.

## Roadmap

1. **Done:** the ground-terrain test bed has been replaced by the solar system (step 3).
2. **Building and crafting:** expand blocks, inventory, and crafting. These are the foundation for ships.
3. **Space world:** *Done:* a seeded solar system: a star, five cube-ish planets with contoured surfaces, a
   starfield, and drifting meteorites. New players start on a small ship near the home planet.
4. **Zero-g movement and gravity plates:** drifting movement, plus gravity plates that create local gravity. *Done:*
   gravity blocks, plates and slopes with distance falloff, zero-g with a jetpack.
5. **Ships:** turn a group of blocks into a ship entity that can be piloted and moved as one. *Started:* ships are
   moving block grids you can ride, pilot, and rebuild while they move, flown with thrusters mapped to keys
   on a navigation console.
6. **Body gravity:** large bodies attract the player and objects according to their mass and distance. *Done:*
   each body has a gravity core; surface gravity scales with size and fades out about 50 blocks up.

## Open questions

- What counts as a "ship": every block connected to a cockpit or control block, or something else?
- How are thrusters powered (fuel or energy)? Do they need more control keys (up/down, roll)?
- Should planets orbit (move), have water and atmospheres, or more biomes?
- Is there survival (health, oxygen, resources), or is it creative-first?
- Which way is "down" on a gravity plate: always the plate's facing direction?
