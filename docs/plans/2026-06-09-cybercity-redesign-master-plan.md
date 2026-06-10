# CyberCity Redesign: Master Town Plan, Data Harbor, Street Fabric, Third-Person Character

## Context

The `/city` page renders PortOS state as a 3D R3F city, but it reads as scattered monuments on an empty plane: districts sit at arbitrary compass anchors with no connecting fabric, buildings are plain boxes, and exploration mode is an invisible first-person camera (`PlayerAvatar.jsx` is dead code — never imported). The user granted **full liberty to redesign the city UX** with two hard requirements: **day/night themes that match PortOS themes** (already the backbone: `cityDayMix(settings)` + `CityPaletteContext` theme-derived palette — preserved and extended, never bypassed) and **3D navigation around the city**.

Chosen direction (user-confirmed): **refined cyberpunk metropolis** — keep the neon identity, make it a real town — via a **new master plan that evolves the existing ~60 data-driven components** (repositioned/reskinned, all live data bindings kept) rather than a ground-up rewrite.

House rules that shape everything below: pure helpers in `client/src/utils/city*.js` (node-env vitest, no three/React/window imports) + thin components; no live-mode postprocessing (emissive + additive only); drei `<Line>` is broken in this stack (native three geometry only); headless WebGL renders the city blank, so correctness leans on pure-helper tests + dev-server GPU verification.

---

## Workstream 1 — Master town plan (`cityPlan.js`)

**The structural redesign.** Today every district helper exports its own ad-hoc position constant. Replace that with a single source of truth:

- **New `client/src/utils/cityPlan.js` + test** — exports the whole town topology as data:
  - `CITY_PLAN.plaza` — central AI Core plaza (clearance radius 12, as today) with sidewalk ring tiles.
  - `CITY_PLAN.parcels` — named parcels for every district (`memory`, `goals`, `health`, `productivity`, `taskQueue`, `backupVault`, `jira`, `artifacts`, `voice`, `easterEggs`, `dataHarbor`, `warehouse`, `downtown`), each `{ anchor: [x,y,z], width, depth, facing }`, arranged as coherent *neighborhoods* along the street network instead of lone compass monuments: civic core (AI plaza + health + task queue) center-north, memory/knowledge quarter NW, productivity/goals quarter E, industrial warehouse N+Z as today, and a **waterfront on the south edge** where the Data Harbor docks sit.
  - `CITY_PLAN.shoreline` — the south world edge becomes water: shoreline z-coordinate, water plane bounds, dock positions.
  - `CITY_PLAN.streets` — ring road around downtown + spokes to every parcel, plaza ring, crosswalks (consumed by Workstream 3).
  - `CITY_PLAN.transit` — an elevated transit loop path (evolves the existing `CityTubeLine.jsx`) linking the quarters — the "alive game city" motion layer.
  - Invariant tests: no two parcels overlap, every parcel inside world bound ±180, every parcel reachable by a street spoke, plaza clearance respected, shoreline south of all non-harbor parcels.
- **Evolve, mechanically**: each district helper (`cityMemoryDistrict.js`, `cityGoalMonuments.js`, `cityHealthTower.js`, …) swaps its hardcoded position constant for `CITY_PLAN.parcels.<name>.anchor`. `cityLayout.js` `computeCityLayout` keeps its grid algorithm but reads downtown/warehouse origin + bounds from the plan. Existing per-district tests keep passing (they assert shape, not absolute coordinates; update the few that pin positions).
- **New `CityWater.jsx`** — animated water plane along the south shoreline: large plane, dark semi-reflective `meshStandardMaterial`, slow-scrolling procedural canvas wave texture (same canvas-texture technique as `CityGround`), additive shimmer strip at the shoreline, color lerped by `cityDayMix` (night: ink with neon reflections tint; day: steel blue). No reflections/refraction passes.
- **Evolve `CityGround.jsx` / `CityLandscape.jsx`** — ground texture gains district-tinted zones (subtle color wash per parcel from the palette) and stops at the shoreline.

This workstream is the enabler: streets, harbor, and props all consume `CITY_PLAN` instead of inventing geometry.

---

## Workstream 2 — "Data Harbor" district (DB + filesystem visualization)

A waterfront dock district on parcel `dataHarbor` (south shore):

- **Database Quay**: one glowing disk-stack silo per Postgres table on dock piers (stack height = log-scaled row count, radius = log-scaled relation size); pgvector tables get a rotating emissive torus ring; a migration obelisk shows applied-migration count.
- **Archive Racks**: shipping-container-style rack wall, one per `data/` domain directory, emissive slat fill = log-scaled disk usage.
- Click a silo/rack → drei `Html` holo-card (name, rows, bytes, files, embedding badge) styled like `HolographicPanel.jsx`. DB down → dimmed red silos + "DB OFFLINE" label (`db: null` ≠ empty arrays, per the sentinel rule).

### Server

- **New `server/services/cityIntrospection.js`** — `getCityIntrospection()` → `{ ts, db, fs }`; 45s TTL cache + in-flight dedupe + **stale-while-revalidate** (`data/images` is ~3.1GB / thousands of files — never block the route on a re-walk).
  - `db`: `pg_stat_user_tables` (relname, `n_live_tup`, `pg_total_relation_size`), `information_schema.columns` where `udt_name='vector'` → `hasEmbedding`, `pg_database_size`, `schema_migrations` count + max(applied_at). Each piece `.catch(() => null)`.
  - `fs`: depth-1 domains under `PATHS.data`, async recursive walk (concurrency ~4, skip symlinks, per-entry error tolerance), loose root files → `(root)` pseudo-domain.
- **Modify `server/routes/cityRoutes.js`** — `GET /api/city/introspection` (no params → no new Zod schema). Document in `docs/API.md`.

### Client

- `apiCity.js`: `getCityIntrospection(options)`. `CyberCity.jsx`: `useAutoRefetch(... , 120_000)` with `{ silent: true }` (same pattern as `memoryGraph`), pass to `CityScene`.
- **New `client/src/utils/cityDataHarbor.js` + test** — `computeDataHarbor(introspection)` → `{ empty, dbDown, silos[], racks[], obelisk, totals, overflow }`; anchors from `CITY_PLAN.parcels.dataHarbor`; reuse `scaleMetricToHeight`/`gridIndexToPosition` from `cityDistrictLayout.js`; top-N + overflow count.
- **New `client/src/components/city/CityDataHarbor.jsx`** — mirrors `CityMemoryDistrict.jsx`; `useCityPalette()` colors, `cityDayMix` legibility, one shared `useFrame` for ring rotation, `CityLabel` titles.

---

## Workstream 3 — Street fabric, props, rooftops

1. **Streets** — **New `CityStreets.jsx`** renders `CITY_PLAN.streets` as 2–3 merged `BufferGeometry` draw calls (`BufferGeometryUtils.mergeGeometries`): asphalt quads at y=0.02 (color lerped by `cityDayMix`), emissive accent edge strips (`toneMapped={false}`), crosswalks.
2. **Street props** — **New `CityStreetProps.jsx`** + helper `computeStreetProps` (in `cityPlan.js` or sibling): `InstancedMesh` ×4 — lamp poles, emissive lamp heads, additive ground glow discs (no real point lights), holo-trees on the plaza ring. Deterministic via `seededRand`. Quality-gated: `low` → none, `medium` 0.5×, `high` 1×, `ultra` 1.5× density.
3. **Rooftops** — **New `client/src/utils/cityRooftops.js` + test**: `computeRooftopKit(name, width, height)` → 0–3 fixtures (antenna/tank/AC/dish) seeded by app-name hash (same determinism as window textures). Rendered in `Building.jsx` with module-scope shared materials; off on `low`. If profiling shows pain on huge installs → instanced fallback as a PLAN.md deferred item.

---

## Workstream 4 — Third-person game character

### Player rig (`PlayerController.jsx` refactor)

- Extract per-frame state into a mutable **`rigRef`**: `{ position, yaw, pitch, speedSq, moving, sprinting, airborne, lastYaw }`. All existing behavior preserved (WASD/arrows, shift sprint, E/Q vertical, F interact, pointer-lock mouselook, building collision r=3.5, flyover above y=12, bounds ±180, spawn persistence). Add water as non-walkable below flyover height (clamp z at shoreline) using `CITY_PLAN.shoreline`.
- New `settings.cameraView` (`'third'` **default** | `'first'`), toggled with **V**; settings row in `CitySettingsPanel.jsx`; default in `useCitySettings.js`.
- First-person branch = existing camera math unchanged; third-person = new helper math.
- **Explicitly skip camera writes while `transitioning`** (prop from `CityScene`) so `CameraTransition` is the sole camera writer during toggle flights — today that works only by mount-order luck.

### New `client/src/utils/cityPlayerRig.js` + test (pure math, plain `{x,y,z}`)

- `thirdPersonCamera({ pos, yaw, pitch, boom 6.5, shoulder 0.6, height 2.4 })` → `{ camera, lookAt }`; asymmetric pitch clamp [-0.45, 1.15].
- `resolveBoom(...)` — shorten boom when the camera lands inside a building cylinder; floor `camY ≥ 0.6`.
- `dampFactor(rate, delta) = 1 - exp(-rate·delta)` (frame-rate independent; camera ≈8, lookAt ≈12), `dampAngle` (shortest-arc), `moveFacing(yaw, localMove)` (character faces movement direction; camera yaw stays mouse-driven), `avatarState()` → `idle|walk|run|hover`, `bankAngle` (±0.25 rad, damped).

### Rewrite `PlayerAvatar.jsx` (currently dead code — upgrade in place, mounted by `PlayerController` in third-person only)

- Reads `rigRef` each frame — no React state on the hot path.
- **Design**: ~1.7-unit stylized cyber-runner — angular flat-shaded helmet + wraparound emissive visor, chevron chest with emissive core, shoulder pauldrons, **two-segment arms/legs** (shoulder→elbow, hip→knee), boots with emissive sole strips, back jet vents, additive ground glow disc. Palette: body = theme-tinted dark, trim/visor = accent (`toneMapped={false}`), eyes semantic red. ~22 meshes, shared module-scope geometries.
- **Animations** via `avatarState()`: idle (bob, visor breathing, head scan), walk (opposing hip/shoulder swing, joint follow-through), run (faster phase, larger amplitude, torso pitched forward), **hover** (flyover: legs tuck, jet vents pulse — a flying runner instead of mid-air walking). Facing damped + banking into turns.
- Mode interactions verified: OrbitControls only mounts when `!explorationMode`; photo/playback force exploration off (`CyberCity.jsx:122–135`) so the avatar can't leak into postcards.

---

## Delivery: two PRs

**PR 1 — "city redesign: master town plan, waterfront Data Harbor, street fabric"** (commits kept individually green):
1. `feat(city): master town plan as single source of district layout` (cityPlan.js + tests, district helpers re-anchored, water + shoreline, ground zones)
2. `feat(server): city introspection service + GET /api/city/introspection` (+ tests, API.md)
3. `feat(city): waterfront Data Harbor district`
4. `feat(city): street network, instanced props, rooftop kits`

**PR 2 — "third-person cyber-runner exploration"**:
5. `refactor(city): player rig + third-person follow camera` (behavior-neutral on `cameraView='first'`)
6. `feat(city): cyber-runner avatar`

Each PR: `/simplify`, changelog entry in `.changelog/NEXT.md`, `/do:pr`, merge with `gh pr merge --merge --delete-branch`.

## Test plan

- **Pure helpers (vitest, node env)**: `cityPlan.test.js` (parcel non-overlap, world bounds, street reachability, plaza clearance, shoreline invariants), `cityDataHarbor.test.js` (null introspection → empty, dbDown shape, top-N+overflow, log-height monotonicity, pgvector flags), `cityRooftops.test.js` (deterministic, 0–3, in-bounds), `cityPlayerRig.test.js` (camera behind yaw, pitch clamp, boom shortening vs blocking cylinder, dampFactor monotonicity, shortest-arc ±π, moveFacing strafe/backpedal, avatarState transitions). Update any district tests that pinned old absolute positions.
- **Server (vitest)**: `cityIntrospection.test.js` — mock `lib/db.js` per SQL shape; rejection → `db: null`; `mkdtempSync` fixture tree for the fs walk; TTL cache hit; stale-while-revalidate. Route test mocks the service.
- **Visual (dev server, real GPU — headless renders blank)**: full-city day + night across both PortOS themes (the hard requirement); waterfront + harbor + holo-cards + DB-stopped state; streets/props/rooftops at all 4 quality presets with FPS sanity; transit loop; third-person walk/run/strafe/bank/collision/boom/hover; V toggle; exploration transition; F interact; photo mode (avatar absent); minimap + playback still coherent with the new layout.

## Risks

- **Re-anchoring ~15 district helpers** is wide but mechanical; the plan-invariant tests + per-district shape tests catch drift. Snapshot playback stores no coordinates (only statuses/counts) → unaffected by the new layout.
- **CameraTransition vs follow camera** → explicit `transitioning` gate.
- **`data/` walk cost** → stale-while-revalidate + concurrency-limited walk.
- **drei `<Line>` broken** → merged native geometry only; water has no reflection passes.
- **Client lib tests run in node env in CI** → all new utils three-free and window-free by construction.
