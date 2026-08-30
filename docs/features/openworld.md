# OpenWorld

> **Renamed 2026-08-19.** This surface shipped as *CyberCity* at `/city`. It is now
> **OpenWorld** at `/openworld`; the `/city` routes redirect so existing bookmarks,
> pinned rows, palette history, and peer deep links keep working. Persisted nav-command
> ids remain unchanged.

## Vision

OpenWorld is a playable, spatial interpretation of PortOS: a small world whose places
are shaped by the systems, memories, goals, apps, and agents inside an install. It is
not a 3D dashboard with ornamental streets. The world should be enjoyable to cross even
before the player reads a number.

The design has four priorities, in this order:

1. **A memorable place.** Water, silhouettes, terrain color, and landmarks make each
   part of the world recognizable before labels do.
2. **A satisfying traversal loop.** Arrive through the village gate, follow curving
   lanes, recover Echo Shards, and stop at cottages that open real PortOS places.
3. **PortOS made physical.** Live app and system state changes structures and motion,
   but never replaces the authored geography.
4. **A useful route back into the product.** Buildings, destinations, search, and URL
   deep links remain direct paths into canonical PortOS surfaces.

## PortOS Village

Street-level OpenWorld is a compact, continuous valley rather than a systems diagram spread
across a flat plane. Its named neighborhoods remain useful for the map and deep links, but
the player experiences them as parts of one village:

- **The Common** — a circular gathering place around the kinetic AI Core.
- **Memory Wilds** — the Memory House and Backup Cottage among denser trees.
- **Maker Reach** — the Task Workshop, Goals Lodge, and Trophy House.
- **Data Pier** — the waterfront cottage for database tables and data domains.
- **Focus Gardens** — crops, productivity, quiet discoveries, and activity terrain.
- **Wellness Grove** — the Wellness Greenhouse and personal-health destinations.

`client/src/utils/openWorldPlan.js` is the geography contract. Its curved lanes, terrain
height function, cottage footprints, region anchors, and walkability rules are shared by
rendering, player grounding, collision, camera avoidance, suspension, and map views.

The valley uses a deterministic irregular outline, rolling low-poly terrain, dense instanced
broadleaf trees, grass, flowers, rocks, crops, benches, lanterns, a pond, and a harbor. The
sea remains one inexpensive procedural surface outside the village shelf.

Live PortOS state is woven into this authored setting rather than displayed as a detached
dashboard. Active managed apps occupy small status-lit market kiosks around the Common;
nearby app interaction opens the same focused app route used elsewhere in PortOS. Cottage
plaques show their place name and a compact live metric, while memories grow a grove, tasks
stack as workshop cargo, goals raise flags, and backup, health, voice, trophy, and data state
alter their corresponding landmarks. Archived apps remain summarized at Archive Lodge so
the active market stays legible.

## The Village Run

Street-level exploration is the game layer:

1. The utility rover enters through the authored PortOS Village gate. App count never
   moves the starting line or blocks the arrival view.
2. A broad heart loop and short destination lanes keep a cottage, garden, pond, or landmark
   entering the frame every few seconds without floating horizon labels.
3. Echo Shards reward exploring the whole valley. Collection has audiovisual feedback and
   session persistence.
4. Landmark proximity offers one clear action with `F`: visit the visible nearby cottage
   or place. Invisible street-level warp triggers are not used.
5. `M` opens the Village Map. A destination warp is shareable via
   `/openworld/region/:regionId`, and dropping back to street level lands at that region.

The exploration HUD deliberately removes dashboard noise and takes over the whole viewport.
It shows only the current place, Echo progress, speed, nearby interaction, and four compact
tools. Operational vitals, filters, agent bars, and attention panes return in orbital view.

Controls:

| Input | Action |
|---|---|
| `W` / `S` | accelerate / reverse |
| `A` / `D` | steer |
| `Shift` | boost |
| `Ctrl` or `X` | brake |
| `Space` | jump |
| `F` | use the nearby building, landmark, or gate |
| `V` | switch rover and first-person camera |
| `M` | open the Village Map |
| `Tab` | switch street-level and orbital view |
| `R` | return to the latest arrival point |

Touch uses a joystick plus only three verbs: boost, hop, and action.

## PortOS Places

The cozy places are authored; their destinations still tell the truth about the install.

- App state → Common market kiosks, status lamps, active-agent markers, and focused app routes.
- AI activity → the suspended seed and orbital rings at the AI Core, with targeted beams.
- CoS tasks → crates outside the Task Workshop.
- Backup state → the status lamp outside Backup Cottage.
- Memory graph and inbox → blossom clusters and the memory well at Memory House.
- Goals and artifacts → flags and earned displays around their cottages.
- Productivity and calendar history → terrain heat and task-flow motion.
- Health → the Wellness landmark.
- Database introspection → Data Harbor structures.
- Federated peers → distant silhouettes beyond the local islands.

These mappings are symbolic and read-only. OpenWorld may navigate to an existing action,
but it must not invent an implicit write path or trigger an automation merely because the
player approached something.

## Views and URL Contracts

- `/openworld` is the whole-world route.
- `/openworld/apps/:appId` focuses one live app borough.
- `/openworld/region/:regionId` focuses or warps to one named destination.
- `/openworld/settings` opens world settings.
- Legacy `/city` routes redirect to the equivalent OpenWorld route.

Selection remains in the URL. Building focus and region travel are bookmarkable,
back/forward safe, and reachable from the command palette and voice navigation.

Orbital view is an establishing shot of the complete archipelago, with pan/orbit/zoom,
search, operational filters, attention, history, and photo tools. Street-level view is
for movement and discovery. The two modes intentionally have different information
hierarchies.

## Art Direction

`settings.worldStyle` selects one of two material languages over the same world:

| Style | Look |
|---|---|
| `vibes` (default) | colorful low-poly valley, cottage destinations, dense trees, rolling lanes, drifting clouds |
| `cyber` | nocturnal orbital dashboard, galaxy and weather layers, emissive live-state accents |

The new direction follows current Three.js practice without making experimental renderer
features a runtime requirement:

- Procedural, data-driven terrain is authored as deterministic buffer geometry, inspired
  by Three.js’s
  [procedural terrain example](https://threejs.org/examples/webgpu_tsl_procedural_terrain).
- Repeated world detail is instanced and geometry is reused, following
  [React Three Fiber’s scaling guidance](https://r3f.docs.pmnd.rs/advanced/scaling-performance).
- Dense procedural city generation informed the decision to keep live structures modular,
  while making geography a stronger authored composition; see Three.js’s
  [city generator example](https://threejs.org/examples/webgpu_generator_city.html).

WebGPU/TSL is not required for OpenWorld. The current WebGL path supports the app’s browsers
and quality tiers, while the geometry/data separation leaves room for a future renderer
upgrade.

## Performance Contract

- No per-frame React state for camera, player, water, pulses, or instanced dressing.
- Geometry derived from static geography is memoized and explicitly disposed.
- Repeated terrain detail uses instancing; the village terrain and curved lane ribbons are memoized.
- Expensive atmosphere layers mount only for the appropriate style/tier.
- Adaptive quality remains internal. Player-facing settings describe mood, sound, and
  controls rather than renderer implementation.
- Photo-only postprocessing stays out of the always-on live canvas.
- Hidden tabs stop the live frame loop.

## Critical Files

- `client/src/utils/openWorldPlan.js` — terrain height, lanes, cottage collision, parcels, and walkability
- `client/src/components/openworld/OpenWorldArchipelago.jsx` — village terrain, cottages, routes, and dressing
- `client/src/components/openworld/OpenWorldWater.jsx` — world sea
- `client/src/pages/OpenWorld.jsx` — route state and mode/game orchestration
- `client/src/components/openworld/OpenWorldScene.jsx` — Canvas and scene composition
- `client/src/components/openworld/PlayerController.jsx` — rover movement and interaction
- `client/src/utils/openWorldPlayerRig.js` — camera and vehicle math
- `client/src/utils/openWorldCollectibles.js` — Echo Shard placement and progress
- `client/src/utils/openWorldRegions.js` — region registry and arrival projection
- `client/src/utils/openWorldMiniMap.js` — shared world-map projection
- `client/src/components/openworld/OpenWorldFastTravel.jsx` — searchable Village Map
- `client/src/components/openworld/OpenWorldHud.jsx` — desktop mode hierarchy
- `client/src/components/openworld/OpenWorldHudCompact.jsx` — compact/touch hierarchy

## Verification

Before shipping a geography or traversal change:

1. Run the focused OpenWorld utility and component tests.
2. Run the client production build.
3. Inspect orbital view and confirm the full PortOS world remains readable and useful.
4. Drop into street level and confirm the rover enters at the village gate, the next bend and
   destination are visible, cottages are solid, suspension follows terrain, shards collect,
   and `F` exposes only a visible nearby place.
5. Open the Village Map and confirm its neighborhoods, player, cottages, and destinations
   match the 3D world.
6. Check at least one compact viewport and one desktop viewport.
