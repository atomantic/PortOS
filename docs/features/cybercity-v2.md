# CyberCity v2

## Intent

CyberCity should be a **read-only interpretive layer** over PortOS state.

It is not a control plane and should not mutate canonical user data. Its job is to:

- spatialize important system state
- make operational pressure legible at a glance
- provide a memorable aesthetic layer for PortOS
- route the user into deeper app surfaces when they want detail

## Current State

The current implementation already has a strong rendering shell:

- 3D city scene with buildings, districts, weather, traffic, particles, signs, billboards, and HUD
- app-driven building placement
- archived apps separated into an archive district
- CoS activity shown in HUD and event logs
- exploration mode / avatar controls

What it lacks is a stronger semantic model. Right now it is more of a stylish city visualization than a true systems map.

## Core Design Rule

CyberCity is a **read layer**.

Allowed:
- query state from PortOS APIs
- reflect state visually
- link/navigate to app pages and dashboards
- render symbolic or atmospheric interpretations

Not allowed:
- mutate user goals, tasks, notes, or memory directly
- trigger automations implicitly
- act as a hidden write surface

## V2 Design Goal

Turn CyberCity from a decorative scene into a **living systems dashboard**.

The city should answer questions like:
- Where is activity happening?
- Which systems are healthy vs degraded?
- Where is review pressure building?
- Which machine or domain is producing noise?
- What deserves attention first?

## Proposed Semantic Layers

### 1. Infrastructure Layer
Maps operational system state into broad city behavior.

Examples:
- app health -> district brightness / outages / skyline quality
- active agents -> drones, traffic density, lit windows, moving signals
- alerts / review pressure -> warning beacons, weather severity, red pulses
- archived apps -> warehouse / cold-storage district
- remote instances / machines -> distinct boroughs or utility grids

### 2. Domain Layer
Maps major PortOS domains into recognizable urban geography.

Initial candidate districts:
- Apps / operations district
- CoS / agents district
- Review / alerts district
- Memory / archive district
- Machine / instance district
- Void machine district (remote primary node)

### 3. Interface Layer
Lets CyberCity route the user into the real app.

Examples:
- click building -> app detail
- click review beacon -> Review Hub
- click agent district -> CoS / agent page
- click void-machine infrastructure -> instance/machine details

### 4. Atmosphere Layer
Adds meaning and personality without changing truth.

Examples:
- ambient city mood tied to system conditions
- earned monuments or holograms from milestones
- subtle machine-familiar tone in signage / overlays
- temporal events (night mode, storms, calm periods)

## Roadmap

### Phase 1 — Legibility
Goal: make the city communicate real system state clearly.

Planned work:
- define district model beyond active vs archive
- add explicit status-to-visual mappings
- introduce review/alert pressure indicators
- make remote instance presence visible through data-driven landmarks and signals
- refine HUD so it reflects domain health, not just generic counts

### Phase 2 — Navigation
Goal: make CyberCity a spatial front-end to PortOS.

Planned work:
- district click targets
- landmark summaries
- richer hover/interact states
- direct routing into app areas from meaningful city objects

### Phase 3 — Atmosphere
Goal: make CyberCity feel alive and distinctive.

Planned work:
- domain-specific ambient effects
- earned artifacts / monuments
- ghost-console / familiar flavor in selected UI surfaces
- stronger day/night and signal-noise mood shifts

## Related Future Ideas
Track for later work:

- Sandbox district (safe experiments, simulated artifacts, non-canonical play)
- Memory museum / mausoleum layer
- Ambient ritual layer
- Ghost console / machine familiar mode

These should remain separate from canonical write paths.

## First Implementation Slice

The first useful slice should be:

1. inspect and formalize current city data inputs
2. introduce a district/state model that goes beyond `active apps vs archive`
3. surface review/alert pressure in the scene, not just the Review Hub
4. reserve a visible zone for the void machine / remote primary instance

That creates a meaningful systems-map foundation before adding more spectacle.

---

# CyberCity Improvement Plan

Concrete ideas for making CyberCity more **useful** (a real systems dashboard) and more **interesting** (atmospheric, delightful, memorable). Organized by effort tier.

## Tier 1 — Quick Wins (single-file or small changes, high impact)

### 1.1 System Health as City Atmosphere
**Data source:** `/api/system/health/details` (CPU, memory, disk, process stats)
**Concept:** Map real system metrics to existing atmospheric effects:
- **CPU load** → heat shimmer / haze intensity on buildings (reuse CityParticles or add a distortion shader)
- **Memory pressure** → fog density (scale existing cloud/particle opacity)
- **Disk usage** → ground texture degradation (swap ground material roughness/color at thresholds: green <70%, amber 70-90%, red >90%)
- **Process error count** → ember/spark intensity (already have CityEmbers)

This turns the existing weather system from random decoration into a meaningful system health indicator. One glance at the sky tells you if the server is struggling.

### 1.2 Notification Beacons
**Data source:** `/api/notifications/counts` (breakdown by type)
**Concept:** Extend the existing CitySignalBeacons to pulse based on notification backlog. Unread notification count drives beacon brightness and pulse rate. Different notification types get different beacon colors. Clicking a beacon navigates to the relevant PortOS page.

### 1.3 Brain Inbox Pulse
**Data source:** `/api/brain/inbox` (count of unprocessed thoughts)
**Concept:** Add a central spire/antenna whose glow intensity reflects brain inbox depth. Each new thought capture triggers a brief light pulse visible from anywhere in the city. Zero inbox = calm blue glow. Growing inbox = increasingly urgent amber→red pulse.

### 1.4 Richer Billboards with Real Content
**Data source:** `/api/cos/briefings/latest`, `/api/cos/productivity/summary`
**Concept:** The existing CityBillboards already show some data. Enhance them to rotate through:
- Today's briefing headline
- Productivity streak count ("7-day streak")
- Top actionable insight from `/api/cos/actionable-insights`
- Recent agent completion summary
- Goal progress percentage for active goals

### 1.5 Building Pulse Animation for Active Agents
**Concept:** When a CoS agent is actively working on an app, the building's windows should animate (scrolling light pattern, like code being written). Currently agents are octahedra floating above — add a visual link between agent and building (a light beam or tether).

## Tier 2 — Medium Effort (new components, new data hooks)

### 2.1 Productivity District
**Data sources:** `/api/cos/productivity/trends`, `/api/cos/productivity/calendar`
**Concept:** A dedicated district (offset from downtown) containing:
- **Streak monument** — a tower whose height equals current task completion streak (days). Glows brighter at longer streaks. Crumbles/darkens when streak breaks.
- **Activity heatmap ground** — ground tiles colored by the GitHub-style activity calendar data. Recent high-activity days glow; idle days are dark.
- **Task flow river** — an animated stream running through the district whose width/speed reflects daily task throughput.

### 2.2 Goal Monuments
**Data source:** `/api/digital-twin/identity/goals`
**Concept:** Each active goal becomes a landmark structure in the city:
- **In-progress goals** → buildings under construction with scaffolding, cranes, and sparks
- **Completed goals** → polished monuments with celebratory lighting
- **Stalled goals** → dimmed, cobwebbed structures
- Goal progress percentage maps to construction completion (25% = foundation only, 75% = mostly built, facade incomplete)
- Milestone completions trigger a brief city-wide firework effect

### 2.3 Chronotype Energy Overlay
**Data source:** `/api/digital-twin/identity/chronotype/energy-schedule`
**Concept:** The city's ambient energy level follows the user's chronotype profile:
- During peak focus hours → brighter neon, faster traffic, more particle activity, upbeat synth music key
- During recovery/wind-down hours → dimmer lights, slower traffic, calmer particles, mellow music
- This makes the city feel like it "breathes" with the user's natural rhythm rather than running at constant intensity
- Could be a toggle ("Chronotype mode") that overrides static time-of-day setting

### 2.4 Character Level & XP HUD
**Data source:** `/api/character/` (XP, level, events)
**Concept:** Display character level as a floating holographic badge near the HUD. XP gains trigger a brief golden particle burst from the relevant building. Level-ups trigger a city-wide celebration (fireworks + music sting + temporary golden sky tint). This ties the gamification system directly into the spatial experience.

### 2.5 Data Flow Streams Between Buildings
**Concept:** Animate visible light streams between buildings that communicate (e.g., API calls between apps, agent messages). Stream thickness = traffic volume. Stream color = data type (blue = API, green = socket, orange = file I/O). This visualizes the actual interconnection topology of managed apps.

### 2.6 Mini-Map Overlay
**Concept:** A small top-down map in the HUD corner showing:
- Building positions colored by status
- Current camera position/orientation
- Hot spots (buildings with active agents or alerts glow)
- Click-to-teleport navigation
This is especially useful as the city grows beyond a few buildings and districts spread out.

### 2.7 Health Vitals Tower (Meatspace Integration)
**Data source:** `/api/meatspace/apple-health/metrics/latest`
**Concept:** A biometric tower in a "wellness district" that visualizes:
- Heart rate → pulsing ring animation speed
- Steps today → tower height growth throughout the day
- Sleep quality last night → tower color (green=good, amber=fair, red=poor)
- Active calories → glowing particle emission rate
Makes physical health data part of the ambient awareness layer.

## Tier 3 — Ambitious Features (new systems, significant effort)

### 3.1 Memory/Knowledge District
**Data sources:** `/api/memory/graph`, `/api/memory/stats`, `/api/brain/`
**Concept:** A visually distinct district representing the knowledge base:
- **Memory nodes as crystalline structures** — each memory category is a crystal cluster. Size = number of memories. Brightness = recency of access.
- **Connection bridges** — graph edges from the memory graph rendered as light bridges between crystals
- **Brain inbox as a glowing well** — new thoughts drop in as light orbs, processed thoughts flow out as connections
- **Knowledge fog** — areas with sparse connections are foggy; dense knowledge areas are clear and well-lit
- Clicking a crystal navigates to the Memory page filtered by that category

### 3.2 Historical Timeline Scrubber
**Data sources:** `/api/cos/productivity/trends`, `/api/history/stats`
**Concept:** A timeline slider (in HUD or settings) that lets you see the city at previous points in time:
- Scrub back to see which apps existed, which were online, what the system health was
- Buildings appear/disappear, construction animations play for new apps
- Useful for understanding system evolution and identifying when problems started
- Data sourced from historical snapshots or reconstructed from event history

### 3.3 JIRA/Sprint District
**Data source:** `/api/jira/instances/:id/my-sprint-tickets`
**Concept:** A "work board" district where current sprint tickets are visualized as:
- **Todo tickets** → stacked crates in a warehouse
- **In-progress tickets** → buildings under active construction with worker drones
- **Done tickets** → completed structures that join the skyline
- Sprint progress shown as a road being built across the district (0% = bare ground, 100% = complete highway)

### 3.4 Federation/Network Visualization
**Data source:** `/api/instances` (self + peers + sync status)
**Concept:** When PortOS has federated peers, each remote instance appears as a distant city on the horizon:
- Sync health shown as a bridge/highway between cities (broken bridge = sync failure)
- Remote instance load shown as that city's skyline brightness
- Click distant city → navigate to instance management page
- Data streams flowing between cities show active sync traffic

### 3.5 Photo Mode / Cinematic Camera
**Concept:** A dedicated "photo mode" that:
- Pauses animations at current state
- Provides cinematic camera presets (aerial flyover, street level, dramatic angle)
- Adds depth-of-field, vignette, and color grading controls
- Captures high-res screenshots
- Could auto-generate a "city postcard" with key stats overlaid
- Sharable output for showing off your personal OS

### 3.6 Ambient Soundscape Tied to Data
**Concept:** Extend the existing synth music system so the soundscape reflects system state:
- Base key/tempo shifts with overall system health (healthy = major key, degraded = minor key)
- Agent activity adds rhythmic elements (each active agent = an additional synth voice)
- High notification count adds tension (dissonant undertones)
- Completed tasks trigger brief melodic chimes
- This makes the city audible as well as visual — you could hear a problem before you see it

### 3.7 Earned Artifacts & Achievement Layer
**Concept:** Permanent visual rewards that accumulate over time:
- **Milestone statues** — completing a major goal places a permanent statue in the city
- **Streak trophies** — longest task streak, most productive week, etc. displayed in a "hall of fame" area
- **Seasonal decorations** — city changes with real-world seasons (cherry blossoms in spring, snow in winter, etc.)
- **Easter eggs** — hidden visual rewards for specific achievements (e.g., 1000th commit → neon dragon flyover)
- These give the city a sense of personal history and make it feel earned, not just generated

## Implementation Priority

Recommended order based on impact-to-effort ratio:

| Priority | Item | Why |
|----------|------|-----|
| 1 | 1.1 System Health Atmosphere | Highest ROI — existing effects just need real data piped in |
| 2 | 1.4 Richer Billboards | Existing component, just needs more data sources |
| 3 | 1.3 Brain Inbox Pulse | Simple visual, high daily utility |
| 4 | 1.5 Building Pulse for Agents | Makes agent activity viscerally visible |
| 5 | 2.4 Character XP HUD | Ties gamification to spatial experience |
| 6 | 2.3 Chronotype Energy Overlay | Unique differentiator, makes city feel alive |
| 7 | 2.1 Productivity District | New district with strong daily relevance |
| 8 | 2.2 Goal Monuments | Visual goal tracking is motivating |
| 9 | 2.6 Mini-Map | Navigation aid as city grows |
| 10 | 1.2 Notification Beacons | Extends existing beacon system |
| 11 | 2.7 Health Vitals Tower | Unique biometric integration |
| 12 | 2.5 Data Flow Streams | Visually impressive, shows system topology |
| 13 | 3.6 Ambient Soundscape | Audio feedback layer |
| 14 | 3.7 Earned Artifacts | Long-term delight and personalization |
| 15 | 3.1 Memory/Knowledge District | Ambitious but visually stunning |
| 16 | 3.5 Photo Mode | Fun, shareable |
| 17 | 3.4 Federation Visualization | Only relevant with multiple instances |
| 18 | 3.3 JIRA Sprint District | Only relevant with JIRA integration active |
| 19 | 3.2 Historical Timeline | Requires historical data infrastructure |
