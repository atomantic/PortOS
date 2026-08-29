# OpenWorld

> **Renamed 2026-08-19.** This surface shipped as *CyberCity* at `/city`. It is now
> **OpenWorld** at `/openworld`; the whole `/city` prefix (including `/city/settings`
> and `/city/apps/:appId`) redirects, so old bookmarks, pinned sidebar rows, stored ⌘K
> history, and peers' deep links keep working. The nav-command **ids** are deliberately
> unchanged (`nav.cybercity`) — they're opaque and persisted in palette history.

## Intent

OpenWorld is the **spatial systems map** of PortOS. A single `/openworld` page that
turns the abstract state of every managed app, every active agent, every system
signal into a 3D world you can glance at, search, teleport across, and act in.

It does three jobs:

1. **Make operational pressure legible at a glance** — which buildings are hot,
   where is review pressure piling up, what needs your attention right now.
2. **Provide a fast spatial front-end to PortOS** — search any app, jump into
   any detail page, take action on any building.
3. **Be a memorable, distinctive aesthetic layer** — a bright low-poly OpenWorld
   or a neon-night Cyber City that feels good to spend time in.

## Current State (as of 2026-08-19)

Strong rendering shell already exists: 3D scene with apps as buildings (PM2-driven),
boroughs, archive district, weather, traffic, particles, neon signs, billboards,
HUD with vitals + activity log + agent bar, exploration mode (WASD), and an
OrbitControls default view.

Tech: React Three Fiber + Three.js (no postprocessing _library_ — bloom is custom
emissive/additive materials, not a composer pass). The one composited effect is
photo mode's depth-of-field, which mounts an `EffectComposer` + `BokehPass` from
three's bundled addons (no extra npm dependency) only while photo mode is active —
see `OpenWorldDepthOfField.jsx`.

Current gaps:

- **Always-on per-building signal** — live CPU/MEM/uptime/restarts from `app.pm2Status`
  now surface in the building hologram (hover / proximity / focus) and the focus panel
  (see `openWorldAppMetrics`); what remains is a glyph visible at any distance without
  approaching the building.
- **Mutation surface** — the city remains read-only; explicit restart, deploy, and log
  actions still belong to the canonical app surfaces.
- **Geometry breadth** — the shared app-building grammar still carries much of the live
  city; district-specific assets can continue replacing generic filler as the world grows.
- **High-frequency update budget** — noisy socket bursts should eventually be coalesced
  before they trigger scene-wide reconciliation.

## Design Rules

OpenWorld is an **interactive systems map**.

Allowed:

- query state from PortOS APIs and reflect it visually
- offer click-to-navigate into deeper app surfaces
- offer **explicit user-initiated actions** that already exist elsewhere in
  PortOS (restart app, deploy app, jump to logs, etc.) — the city is a
  faster path, not a hidden side channel
- render symbolic / atmospheric interpretations of state

Not allowed:

- mutate user goals, tasks, notes, or memory directly (those flow through their
  canonical pages with their own validation)
- trigger automations *implicitly* (no auto-restart on click, no batch actions
  without explicit confirmation)
- act as an undocumented write surface — every action exposed in the city must
  be discoverable elsewhere in PortOS too

In short: **interactive, but every action is intentional and user-initiated**.

## Semantic Layers

### 1. Infrastructure Layer
Maps operational state into city behavior.

- App health → district brightness, building façade, ember/spark intensity
- Active agents → tethered light to their assigned building, traffic density
- Alerts / review pressure → warning beacons, weather severity, red pulses
- Archived apps → cold-storage district
- Remote instances → distant skyline silhouettes on the horizon

### 2. Domain Layer
Maps PortOS domains into recognizable urban geography.

Districts:
- **Apps / operations** — main downtown, all PM2-managed buildings
- **CoS / agents** — agent bar + tether anchors
- **Review / alerts** — pressure landmarks
- **Memory / archive** — archived apps + memory crystal layer (future)
- **AI core** — central tower, all model activity radiates from here
- **Backup vault** — small monument tracking snapshot health
- **Federation horizon** — distant peer skyline
- **Void machine** — reserved zone for the remote primary instance

### 3. Interface Layer
Routes the user into the real app.

- click building → app detail (existing)
- click building façade health bar → live metrics page
- click review beacon → Review Hub
- click AI Core → AI runs page
- click backup vault → Backup page
- click distant peer city → instance management
- press `/` → search overlay → focus camera + jump

### 4. Atmosphere Layer
Personality without changing truth.

- ambient mood tied to system conditions (weather already does this)
- earned monuments / holograms from milestones
- chronotype-driven energy levels (peak hours = bright/fast, recovery = dim/slow)
- temporal events (night mode, storms, calm periods)
- ambient soundscape (future)

## Roadmap

The roadmap unifies operational legibility (the *useful* layer) with atmospheric
polish (the *delightful* layer). Phase 1 prioritizes legibility because that's
what makes CyberCity worth visiting daily; later phases add depth.

### Phase 1 — Operational Legibility (current focus)

Goal: a person walking into `/openworld` for the first time can immediately see
what's healthy, what's not, find a specific app, and take action.

| ID | Item | Effort |
|----|------|--------|
| **1.1** | **Per-building health glyph** — live CPU/MEM/uptime/restarts aggregated from `app.pm2Status` (`openWorldAppMetrics`) and shown on every building hologram when hovered/near/focused plus CPU/MEM/UPTIME blocks in the focus panel. Shipped 2026-08-26; the remaining slice is an always-visible façade strip readable at any distance. | M |
| **1.2** | **Stress smoke / sparks** — reuse `OpenWorldEmbers` per-building. Persistent CPU spike = smoke trail; recent crash = sparks. Brings global weather vocabulary down to the per-building level. | S |
| **1.3** | **Health card replaces cryptic weather glyph** — HUD shows plain `CPU 34% / MEM 71% / DISK 88%` with a sentinel dot. Atmospheric weather effect stays. | XS |
| **1.4** | **System Health as City Atmosphere** — pipe `/api/system/health/details` into existing weather/fog/ground texture so the sky reflects real state. | S |
| **1.5** | **Notification beacons** — extend `OpenWorldSignalBeacons` with notification backlog from `/api/notifications/counts`; brightness = unread count, color = type, click = navigate. | S |
| **1.6** | **Brain inbox pulse** — central spire glow tracks `/api/brain/inbox` depth; new captures pulse the spire. | S |
| **1.7** | **"Needs attention" pane** — replace the right-side `cos:log` stream with a structured list ranked by urgency: stopped/errored apps, high CPU/mem, pending reviews, stale backups, failed agent runs, federation sync failures, unread notifications. Every item clickable. Live log demoted to a tab. | S |
| **1.8** | **Building search overlay** — press `/` to filter buildings by name/tag/status; non-matches dim, matches stay lit, Enter focuses camera. Local substring match against name/id/tags in `client/src/utils/openWorldFilter.js`. | S |
| **1.9** | **Status filter chips in HUD** — All / Online / Stopped / Errored / Has-Agent / Has-Pending-Review pill row above legend. Persists per-session. | S |
| **1.10** | **Hover preview card with quick actions** — show status / uptime / CPU / MEM / err / recent log line, with **Logs / Restart / Deploy / Open** buttons. Restart and Deploy POST to existing endpoints with explicit confirmation. | M |
| **1.11** | **Clickable HUD stats** — every count routes somewhere: PENDING REVIEWS → `/review`, AGENTS → `/cos`, NODES → `/instances`, etc. | XS |
| **1.12** | **Richer billboards** — rotate today's briefing headline, top actionable insight, recent agent completion summary, goal progress. | S |
| **1.13** | **Agent → building tether** — visible light from `AgentEntity` to its assigned building; color = agent state. Plus window-pulse animation on the building. | M |
| **1.14** | **Mobile / touch support** — `pointer: coarse` detection, single-finger orbit, two-finger pinch zoom, tap-to-select. Below 640px collapse HUD into a bottom sheet with search + filters + needs-attention. WASD exploration disables. AGENTS.md mandate. | M |
| **1.15** | **Adaptive render budget** — the scene selects an internal detail tier from sustained frame time; player settings do not expose renderer knobs. | XS |

### Phase 2 — Holistic Coverage

Goal: every major system PortOS tracks has a place in the city.

| ID | Item | Effort |
|----|------|--------|
| **2.1** | **AI Core landmark + activity beams** — central tower; on `ai:status` events, shoot a beam to the building whose agent issued the call. Thickness = tokens/sec, color = model tier. Solves the biggest current blind spot. | M |
| **2.2** | **CoS task queue silhouette** — warehouse with stack height = pending CoS tasks. Boxes load on `tasks:cos:created`, unload on completion. | M |
| **2.3** | **Backup vault landmark** — pulses on `backup:started/completed`, label shows time-since-last-snapshot, goes red when stale. | S |
| **2.4** | **Voice agent district marker** — small area whose lighting mirrors voice-agent state (idle / dictating / error). | S |
| **2.5** | **Federation horizon** — peers as distant skyline silhouettes; opacity = reachability, bridge condition = sync state. Even with one instance the void zone stays visible. | M |
| **2.6** | **Productivity district** — throughput monument, activity heatmap ground tiles, task flow river. Driven by `/api/cos/productivity/*`. | L |
| **2.7** | **Goal monuments** — active goals as construction sites; completed goals as polished monuments; stalled goals dimmed. Driven by `/api/digital-twin/identity/goals`. | L |
| **2.8** | **Mini-map overlay** — top-down map in HUD corner with click-to-teleport. | M |
| **2.9** | **Health vitals tower** — biometric tower in a wellness district visualizing heart rate / steps / sleep / calories from `/api/meatspace/apple-health/metrics/latest`. | M |
| **2.10** | **Data flow streams between buildings** — visible light streams for actual API/socket/file traffic; thickness = volume, color = type. | M |
| **2.11** | **Character XP HUD** — floating level/XP badge with particle burst on XP gain; level-up triggers fireworks. | S |

### Phase 3 — Atmosphere & Polish

Goal: the city feels alive, distinctive, and earned.

| ID | Item | Effort |
|----|------|--------|
| **3.1** | **Chronotype energy overlay** — city brightens/quickens during peak focus hours, dims during recovery, driven by `/api/digital-twin/identity/chronotype/energy-schedule`. | M |
| **3.2** | **Memory / knowledge district** — categories as crystal clusters, graph edges as light bridges, brain inbox as a glowing well. Driven by `/api/memory/graph`. | L |
| **3.3** | **Photo mode / cinematic camera** — pause animations, cinematic presets, depth-of-field, vignette, high-res screenshots, "city postcard" with stats overlay. | M |
| **3.4** | **Ambient soundscape tied to data** — base key/tempo follows system health; agent activity adds rhythmic voices; completed tasks chime. Extends existing synth music. | L |
| **3.5** | **Earned artifacts & achievements** — milestone statues and easter eggs. | M |
| **3.6** | **Historical timeline scrubber** — scrub back to past city states; buildings appear/disappear via construction animations. Requires snapshot data. | L |
| **3.7** | **JIRA sprint district** — current sprint tickets as crates / under-construction / completed structures. | M |
| **3.8** | **Throttle expensive socket-driven repaints** — coalesce noisy event bursts into a 100ms tick. Becomes load-bearing once Phase 2's beams/vehicles ship. | S |

## Performance & Polish (cross-cutting)

- Default to lower quality on `pointer: coarse` and `hardwareConcurrency < 8`
- Coalesce socket events into a render tick to avoid bursty repaints
- Lazy-load heavy effects (volumetric lights, postprocessing, particle storms)
  on the basis of the internally selected render tier
- Keep player-facing settings focused on world style, time, sound, and controls;
  renderer detail adapts without a quality dial

## Fast travel (regions)

The world is navigated by **warping**, not only by panning. Every district on the master
town plan is a named **region** with a one-line pitch and a door into the 2D PortOS page it
visualizes — Memory Quarter → `/brain/inbox`, Sprint Yard → `/devtools/jira`, Data Harbor
→ `/data`, and so on.

- **Registry:** `client/src/utils/openWorldRegions.js`. Geography is *not* re-declared —
  each region names a parcel in `openWorldPlan.js` and reads its anchor/footprint from there, so
  moving a district on the plan moves its warp marker with it.
- **Route:** `/openworld/region/:regionId`. The URL is the single source of truth for
  "where you warped to" — same contract as building focus — so a warp is shareable,
  bookmarkable, and reachable from ⌘K and voice.
- **UI:** `M` (or the HUD's FAST TRAVEL button / the compact dock's navigation icon) opens
  `OpenWorldFastTravel`, a searchable list beside a plate of the world with a marker per
  region. Picking one flies the orbital camera via `computeRegionCamera`; if you're on foot
  in exploration mode it also teleports the player rig to the region's arrival point.
- **Reachability guard:** `server/lib/navManifest.test.js` scrapes `OPEN_WORLD_REGIONS` and
  fails in both directions — a region with no `/openworld/region/<id>` nav command, or a
  command left behind by a deleted region.

## World style (art direction)

`settings.worldStyle` picks one of two looks; it is persisted with the rest of the city
settings and switchable from the Visual tab of the settings drawer.

| Style | Look | Time-of-day presets |
|-------|------|---------------------|
| `vibes` (default) | Bright low-poly open world — teal-to-warm sky, meadow ground, flat-shaded facades, warm sun | `vibesDay` / `vibesDusk` |
| `cyber` | The original neon-night Cyber City | `sunset` only |

The style is a single lever with three effects, all in `openWorldConstants.js`:

1. `resolveOpenWorldTimeOfDay` picks the preset pair. Open World follows the selected
   day/night setting; Cyber City is always nocturnal. The result feeds `OpenWorldSky`,
   `OpenWorldLights`, and `WorldGround` — and, through `daylightFactor`, every surface that already
   lerps between its night and day form.
2. `deriveOpenWorldPalette` swaps the *decorative and structural* surfaces (accent spread,
   building body, and surrounds). Status colors stay semantic in both.
3. `palette.neonLayers` gates the neon-only scene layers — galaxy spheremap, starfield, shooting
   stars, data rain, embers, volumetric light cones, neon signage — so they don't mount at
   all under `vibes` rather than being faded out per frame. `palette.lowPoly` turns on flat
   shading for facades and terrain.

Keeping `cyber` as a real option isn't only nostalgia: it keeps the whole neon layer
exercised by the suite instead of bit-rotting behind a default nobody selects.

The style change keeps the operational geometry and live data mappings stable while changing
their material language. The Vibes pass now adds grounded nature patches, a varied plaza grove,
planter-framed warp pads, and a deterministic drifting cloud bank that scales with the adaptive
render tier; the shared app-building grammar remains intentionally recognizable across both
styles so a status means the same thing in either world.

## Critical Files

- `client/src/pages/OpenWorld.jsx` — page wrapper
- `client/src/utils/openWorldRegions.js` — fast-travel region registry (also the nav-guard source)
- `client/src/components/openworld/OpenWorldFastTravel.jsx` — the warp panel (M)
- `client/src/utils/openWorldFocusCamera.js` — framing math for a borough (`computeFocusCamera`) and a region (`computeRegionCamera`)
- `client/src/components/openworld/openWorldConstants.js` — world styles, time-of-day presets, palette derivation
- `client/src/components/openworld/OpenWorldScene.jsx` — Canvas, 3D containers, controls
- `client/src/components/openworld/OpenWorldHud.jsx` — overlay HUD (most Phase 1 UX changes)
- `client/src/components/openworld/Building.jsx`, `Borough.jsx` — façade work (1.1, 1.2, 1.13)
- `client/src/components/openworld/AgentEntity.jsx` — tether (1.13)
- `client/src/components/openworld/OpenWorldTraffic.jsx`, `OpenWorldDataStreams.jsx` — meaningful traffic (2.10)
- `client/src/components/openworld/OpenWorldSignalBeacons.jsx` — landmarks and warp pads
- `client/src/components/openworld/OpenWorldBillboards.jsx` — richer content (1.12)
- `client/src/hooks/useOpenWorldData.js` — data layer; extend with new endpoints
- `client/src/utils/openWorldFilter.js` — pure status/search filter logic (1.8, 1.9)
- `client/src/utils/formatters.js` — reuse formatters; do not duplicate

## Endpoints used / to use

| Endpoint | Phase | Purpose |
|----------|-------|---------|
| `/api/system/health/details` | 1.1, 1.3, 1.4 | CPU/MEM/DISK |
| `/api/notifications/counts` | 1.5 | beacon brightness/colors |
| `/api/brain/inbox` | 1.6 | spire pulse |
| `/api/cos/queue` (or `/api/cos`) | 1.7, 2.2 | task queue depth |
| `/api/instances/peers` | 1.7, 2.5 | sync failures, peer rendering |
| `/api/cos/briefings/latest` | 1.12 | billboard headline |
| `/api/cos/productivity/summary` | 1.12, 2.6 | throughput, pace |
| `/api/cos/productivity/trends` | 2.6 | activity heatmap |
| `/api/digital-twin/identity/goals` | 2.7 | goal monuments |
| `/api/digital-twin/identity/chronotype/energy-schedule` | 3.1 | energy overlay |
| `/api/meatspace/apple-health/metrics/latest` | 2.9 | health vitals tower |
| `/api/memory/graph` | 3.2 | memory district |
| `/api/character/` | 2.11 | XP HUD |
| `/api/backup/*` | 2.3 | vault state |

## Sockets used / to use

Existing events the city should hook into more deeply:

- `apps:changed` (already used)
- `cos:agent:spawned` / `updated` / `completed` (already used)
- `cos:status`, `cos:log` (already used)
- `tasks:cos:created` / `changed` / `completed` (Phase 2.2)
- `ai:status` (Phase 2.1)
- `app:deploy:start/step/complete/error` (Phase 1.10, 2.10)
- `backup:started` / `completed` (Phase 2.3)
- `voice:idle` / `dictation` / `error` (Phase 2.4)
- `system:critical-error` / `health:check` / `health:critical` (Phase 1.4, 1.7)
- `peer:online` / `peers:updated` (Phase 2.5)

## Verification per phase

**Phase 1 acceptance test:** open `/openworld`, confirm at a glance which apps
need attention, search for a specific app by name in <2s, click any HUD stat
and land on the relevant page, work the same flow on a phone via Tailscale.

**Phase 2 acceptance test:** every major system in PortOS has a visible spatial
representation; new socket events animate the city in real time; opening
`/openworld` instead of `/dashboard` is a viable daily workflow.

**Phase 3 acceptance test:** the city feels distinctive — soundscape and mood
shift with system state, milestones leave permanent visual artifacts, and
photo mode produces shareable postcards.
