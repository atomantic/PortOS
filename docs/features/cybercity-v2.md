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
