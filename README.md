# VoxelCraft

A Minecraft-style voxel sandbox that runs in the browser, built with [Three.js](https://threejs.org/). No build step and no dependencies to install.

## Run it

ES modules need to be served over HTTP (opening `index.html` directly from disk won't work):

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static file server works (`npx serve`, VS Code Live Server, GitHub Pages, …).

## Features

- A world that is infinite on all three axes, streamed in cubic 32×32×32 chunks; you can build anywhere,
  including in the empty space above and below the terrain
- Seeded terrain (for now, a layer between y = 0 and 96): plains, beaches, oceans, forests, snowy mountains
- Caves, coal and iron ore, bedrock floor
- Procedurally painted pixel-art textures (no image files)
- Face-culled chunk meshes with smooth ambient occlusion
- Translucent water you can swim in, with an underwater fog effect
- Walking, sprinting, jumping, flying, and AABB collision
- Gravity in any of the six axis directions, with the player smoothly reorienting to the new "down"
- Ships: free-moving block grids you can stand on, walk around, pilot, and rebuild while they move.
  You ride along with a ship exactly (no sliding off), and neither you nor other ships can pass through it
- Breaking, placing, and picking blocks, with a 9-slot hotbar
- Day/night cycle with a square sun and moon
- Saves automatically to `localStorage` (world edits, position, time, hotbar)

## Controls

| Key | Action |
| --- | --- |
| WASD | Move |
| Space | Jump / swim / fly up |
| Shift | Sprint / fly down |
| F | Toggle flying |
| G | Shift gravity: the surface you're looking at becomes the floor |
| H | Reset gravity to normal |
| N | Spawn a small ship deck in front of you |
| R | Take / leave the controls of the ship you're on |
| WASD / Space / Shift (piloting) | Thrust forward/back/sideways/up/down, relative to where you face |
| Q / E (piloting) | Turn the ship |
| X (piloting) | Brake |
| Left click | Break block |
| Right click | Place block |
| Middle click | Pick block into hotbar |
| 1–9, mouse wheel | Select hotbar slot |
| F3 | Debug overlay |
| Esc | Pause |

## Code layout

| File | Purpose |
| --- | --- |
| `src/main.js` | Renderer, input, block interaction, sky, game loop, saving |
| `src/grid.js` | Voxel grid base class: cubic chunk storage, meshing, editing, raycasting |
| `src/world.js` | The static world: terrain generation, chunk streaming, saved edits |
| `src/ship.js` | Ships: moving grids with position, rotation, velocity, and collision |
| `src/player.js` | First-person movement, collision, gravity frame, and riding ships |
| `src/blocks.js` | Block definitions |
| `src/textures.js` | Procedural texture atlas |
| `src/noise.js` | Seeded simplex noise and hashing |
| `src/hud.js` | Hotbar and debug overlay |
