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
- Gravity generators: a full block that pulls toward itself from every side (build a mini planet), and plates
  and slopes that pull toward their base. Full strength near them (jumping feels normal), fading to nothing
  at 10 blocks. The terrain is a large body with its own gravity that fades above it; elsewhere you float in
  zero-g with a jetpack. Gravity acts on ships too: they fall, land, and are pulled by other ships' generators
  (never their own; the pull is mutual). A piloted ship's thrusters hold it against gravity
- Ships are rigid bodies (mass and inertia from their blocks): they tip off ledges, roll off corners, tumble in
  uneven gravity, and collide with friction and a little bounce; ships at rest go to sleep until disturbed
- Buoyancy: every block type has a density (hull 0.5, wood 0.6, stone 2.4, ...). Ships lighter than water float
  at a matching waterline and right themselves when tilted; heavier ones sink
- Gravity in any of the six axis directions, with the player smoothly reorienting to the new "down"
- Ships: free-moving block grids you can stand on, walk around, fly, and rebuild while they move.
- Thrusters push their ship away from their nozzle, from where they're mounted (so off-centre ones turn it).
  A navigation console maps them to W/A/S/D: drag thrusters from its list onto the key boxes, take the helm,
  and holding a key fires everything bound to it
  You ride along with a ship exactly (no sliding off), and neither you nor other ships can pass through it
- Mining (hold to break, with crack stages), placing, and picking blocks, with a 9-slot hotbar and a block inventory
- Ship hull: metal blocks in six shapes (full block, half block, plate, 45° slope, and a two-piece 26.6° slope)
  that orient to the surface you place them on. Hull damage is permanent: cracks stay and are saved
- Walking up half blocks and slopes without jumping
- Day/night cycle with a square sun and moon
- Saves automatically to `localStorage` (world edits, position, time, hotbar)

## Controls

| Key | Action |
| --- | --- |
| WASD | Move |
| Space | Jump / swim / fly up |
| Shift | Sprint / fly down |
| F | Toggle flying |
| T / Shift+T | Rotate the shaped block you're looking at / move its base to the next face (for gravity plates and slopes: change which way they pull) |
| WASD / Space / Shift (zero-g) | Jetpack |
| N | Spawn a starter ship (console + four thrusters, already mapped) |
| R | Open the navigation console you're looking at / leave the helm |
| W / A / S / D (at the helm) | Fire the thrusters bound to that key |
| Left click (hold) | Mine block |
| Right click | Place block |
| Middle click | Pick block into hotbar |
| 1–9, mouse wheel | Select hotbar slot |
| E | Block inventory (click a block to put it in the selected slot) |
| F3 | Debug overlay |
| Esc | Pause |

## Code layout

| File | Purpose |
| --- | --- |
| `src/main.js` | Renderer, input, block interaction, sky, game loop, saving |
| `src/grid.js` | Voxel grid base class: cubic chunk storage, meshing, editing, raycasting |
| `src/world.js` | The static world: terrain generation, chunk streaming, saved edits |
| `src/ship.js` | Ships: rigid-body grids with gravity, buoyancy, collisions, and thrusters |
| `src/console.js` | The navigation console screen (thruster-to-key mapping) |
| `src/gravity.js` | The gravity field from generator blocks and the terrain |
| `src/player.js` | First-person movement, collision, gravity frame, zero-g, and riding ships |
| `src/blocks.js` | Block definitions (hardness, shape, permanent damage) |
| `src/shapes.js` | Block shapes (slabs, plates, slopes): geometry, collision boxes, 24 orientations |
| `src/textures.js` | Procedural texture atlas |
| `src/noise.js` | Seeded simplex noise and hashing |
| `src/hud.js` | Hotbar and debug overlay |
