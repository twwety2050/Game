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

1. **Now:** keep the current ground-terrain world generation as a test bed while the building and crafting systems
   are fleshed out.
2. **Building and crafting:** expand blocks, inventory, and crafting. These are the foundation for ships.
3. **Space world:** replace terrain generation with empty space, stars, and (eventually) large bodies. The world is
   already infinite on all three axes (cubic 32×32×32 chunks), so this only changes what gets generated.
4. **Zero-g movement and gravity plates:** drifting movement, plus gravity plates that create local gravity. *Done:*
   gravity blocks, plates and slopes with distance falloff, zero-g with a jetpack.
5. **Ships:** turn a group of blocks into a ship entity that can be piloted and moved as one. *Started:* ships are
   moving block grids you can ride, pilot, and rebuild while they move (spawned with N for now).
6. **Body gravity:** large bodies attract the player and objects according to their mass and distance. *Started:*
   the terrain layer pulls like a large body, fading with distance.

## Open questions

- What counts as a "ship": every block connected to a cockpit or control block, or something else?
- How is a ship powered and steered (thrusters, fuel or energy)?
- What do large bodies look like: voxel asteroids and planets you can land on and mine, or something else?
- Is there survival (health, oxygen, resources), or is it creative-first?
- Which way is "down" on a gravity plate: always the plate's facing direction?
