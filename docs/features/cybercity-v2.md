# CyberCity v2

## Intent

CyberCity is the **spatial systems map** of PortOS. A single `/cybercity` page that
turns the abstract state of every managed app, every active agent, every system
signal into a 3D environment you can glance at, search, and act in.

It does three jobs:

1. **Make operational pressure legible at a glance** — which buildings are hot,
   where is review pressure piling up, what needs your attention right now.
2. **Provide a fast spatial front-end to PortOS** — search any app, jump into
   any detail page, take action on any building.
3. **Be a memorable, distinctive aesthetic layer** — a cyberpunk city you
   actually enjoy spending time in, with personality that grows over use.

## Current State (as of 2026-04-29)

Strong rendering shell already exists: 3D scene with apps as buildings (PM2-driven),
boroughs, archive district, weather, traffic, particles, neon signs, billboards,
HUD with vitals + activity log + agent bar, exploration mode (WASD), and an
OrbitControls default view.

Tech: React Three Fiber + Three.js (no postprocessing lib — bloom is custom).

What it lacks:

- **Per-building real-time signal** — buildings show only binary online/stopped;
  CPU/memory/error rate are invisible.
- **Findability** — no search, no filter, scrolling through ~50 buildings is
  the only way to locate one.
- **Drill-down / actionability** — buildings click straight to `/apps/{id}`;
  HUD stats are not interactive; no hover preview, no quick actions.
- **Holistic coverage** — AI runs, CoS task queue depth, federation peers,
  backups, voice agent state, notifications all invisible.
- **Mobile** — desktop-only despite project mandate; no touch controls.
- **Mutation surface** — the city is read-only today, but it is the natural
  place to restart a stopped app or kick off a deploy without leaving the view.

## Design Rules

CyberCity is an **interactive systems map**.

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

Goal: a person walking into `/cybercity` for the first time can immediately see
what's healthy, what's not, find a specific app, and take action.

| ID | Item | Effort |
|----|------|--------|
| **1.1** | **Per-building health glyph** — vertical CPU/MEM/ERR strip on every building façade, cyan→amber→red mapped from `/api/system/health/details` + PM2 metrics. The single highest-leverage change: every building tells you what it's doing right now. | M |
| **1.2** | **Stress smoke / sparks** — reuse `CityEmbers` per-building. Persistent CPU spike = smoke trail; recent crash = sparks. Brings global weather vocabulary down to the per-building level. | S |
| **1.3** | **Health card replaces cryptic weather glyph** — HUD shows plain `CPU 34% / MEM 71% / DISK 88%` with a sentinel dot. Atmospheric weather effect stays. | XS |
| **1.4** | **System Health as City Atmosphere** — pipe `/api/system/health/details` into existing weather/fog/ground texture so the sky reflects real state. | S |
| **1.5** | **Notification beacons** — extend `CitySignalBeacons` with notification backlog from `/api/notifications/counts`; brightness = unread count, color = type, click = navigate. | S |
| **1.6** | **Brain inbox pulse** — central spire glow tracks `/api/brain/inbox` depth; new captures pulse the spire. | S |
| **1.7** | **"Needs attention" pane** — replace the right-side `cos:log` stream with a structured list ranked by urgency: stopped/errored apps, high CPU/mem, pending reviews, stale backups, failed agent runs, federation sync failures, unread notifications. Every item clickable. Live log demoted to a tab. | S |
| **1.8** | **Building search overlay** — press `/` to filter buildings by name/tag/status; non-matches dim, matches stay lit, Enter focuses camera. Local substring match against name/id/tags in `client/src/utils/cityFilter.js`. | S |
| **1.9** | **Status filter chips in HUD** — All / Online / Stopped / Errored / Has-Agent / Has-Pending-Review pill row above legend. Persists per-session. | S |
| **1.10** | **Hover preview card with quick actions** — show status / uptime / CPU / MEM / err / recent log line, with **Logs / Restart / Deploy / Open** buttons. Restart and Deploy POST to existing endpoints with explicit confirmation. | M |
| **1.11** | **Clickable HUD stats** — every count routes somewhere: PENDING REVIEWS → `/review`, AGENTS → `/cos`, NODES → `/instances`, etc. | XS |
| **1.12** | **Richer billboards** — rotate today's briefing headline, productivity streak, top actionable insight, recent agent completion summary, goal progress. | S |
| **1.13** | **Agent → building tether** — visible light from `AgentEntity` to its assigned building; color = agent state. Plus window-pulse animation on the building. | M |
| **1.14** | **Mobile / touch support** — `pointer: coarse` detection, single-finger orbit, two-finger pinch zoom, tap-to-select. Below 640px collapse HUD into a bottom sheet with search + filters + needs-attention. WASD exploration disables. CLAUDE.md mandate. | M |
| **1.15** | **Quality auto-detection** — default low/medium for mobile or weak hardware; settings panel still allows override. | XS |

### Phase 2 — Holistic Coverage

Goal: every major system PortOS tracks has a place in the city.

| ID | Item | Effort |
|----|------|--------|
| **2.1** | **AI Core landmark + activity beams** — central tower; on `ai:status` events, shoot a beam to the building whose agent issued the call. Thickness = tokens/sec, color = model tier. Solves the biggest current blind spot. | M |
| **2.2** | **CoS task queue silhouette** — warehouse with stack height = pending CoS tasks. Boxes load on `tasks:cos:created`, unload on completion. | M |
| **2.3** | **Backup vault landmark** — pulses on `backup:started/completed`, label shows time-since-last-snapshot, goes red when stale. | S |
| **2.4** | **Voice agent district marker** — small area whose lighting mirrors voice-agent state (idle / dictating / error). | S |
| **2.5** | **Federation horizon** — peers as distant skyline silhouettes; opacity = reachability, bridge condition = sync state. Even with one instance the void zone stays visible. | M |
| **2.6** | **Productivity district** — streak monument, activity heatmap ground tiles, task flow river. Driven by `/api/cos/productivity/*`. | L |
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
| **3.5** | **Earned artifacts & achievements** — milestone statues, streak trophies, seasonal decorations, easter eggs. | M |
| **3.6** | **Historical timeline scrubber** — scrub back to past city states; buildings appear/disappear via construction animations. Requires snapshot data. | L |
| **3.7** | **JIRA sprint district** — current sprint tickets as crates / under-construction / completed structures. | M |
| **3.8** | **Throttle expensive socket-driven repaints** — coalesce noisy event bursts into a 100ms tick. Becomes load-bearing once Phase 2's beams/vehicles ship. | S |

## Performance & Polish (cross-cutting)

- Default to lower quality on `pointer: coarse` and `hardwareConcurrency < 8`
- Coalesce socket events into a render tick to avoid bursty repaints
- Lazy-load heavy effects (volumetric lights, postprocessing, particle storms)
  on the basis of the active quality preset
- All new components must respect the existing settings panel quality dial

## Critical Files

- `client/src/pages/CyberCity.jsx` — page wrapper
- `client/src/components/city/CityScene.jsx` — Canvas, 3D containers, controls
- `client/src/components/city/CityHud.jsx` — overlay HUD (most Phase 1 UX changes)
- `client/src/components/city/Building.jsx`, `Borough.jsx` — façade work (1.1, 1.2, 1.13)
- `client/src/components/city/AgentEntity.jsx` — tether (1.13)
- `client/src/components/city/CityTraffic.jsx`, `CityDataStreams.jsx` — meaningful traffic (2.10)
- `client/src/components/city/CitySignalBeacons.jsx` — extend for notifications (1.5) + landmarks (2.x)
- `client/src/components/city/CityBillboards.jsx` — richer content (1.12)
- `client/src/hooks/useCityData.js` — data layer; extend with new endpoints
- `client/src/utils/cityFilter.js` — pure status/search filter logic (1.8, 1.9)
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
| `/api/cos/productivity/summary` | 1.12, 2.6 | streak, throughput |
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
- `app:deploy:start/step/complete/error` (Phase 1.13, 2.10)
- `backup:started` / `completed` (Phase 2.3)
- `voice:idle` / `dictation` / `error` (Phase 2.4)
- `system:critical-error` / `health:check` / `health:critical` (Phase 1.4, 1.7)
- `peer:online` / `peers:updated` (Phase 2.5)

## Verification per phase

**Phase 1 acceptance test:** open `/cybercity`, confirm at a glance which apps
need attention, search for a specific app by name in <2s, click any HUD stat
and land on the relevant page, work the same flow on a phone via Tailscale.

**Phase 2 acceptance test:** every major system in PortOS has a visible spatial
representation; new socket events animate the city in real time; opening
`/cybercity` instead of `/dashboard` is a viable daily workflow.

**Phase 3 acceptance test:** the city feels distinctive — soundscape and mood
shift with system state, milestones leave permanent visual artifacts, and
photo mode produces shareable postcards.
