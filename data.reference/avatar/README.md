# Bundled CoS Avatar Models

These GLB models are shipped as selectable Chief-of-Staff avatar styles and
seeded into `data/avatar/` by `scripts/setup-data.js` (`npm run setup:data`).

## Default model — `model.glb`

`model.glb` is the default served at `/api/avatar/model.glb` and rendered by the
**Cyber Muse (3D)** avatar style (`client/src/components/cos/MuseCoSAvatar.jsx`).

**three.js — RobotExpressive** — https://github.com/mrdoob/three.js (`examples/models/gltf/RobotExpressive/`)
License: **Creative Commons Zero (CC0)** — public domain, free for personal,
educational, and commercial use.

It ships 14 animation clips — `Idle`, `Walking`, `Running`, `Dance`, `Death`,
`Sitting`, `Standing`, `Jump`, `Yes`, `No`, `Wave`, `Punch`, `ThumbsUp`,
`WalkJump` — plus 3 face morph targets (`Angry`, `Surprised`, `Sad`).

MuseCoSAvatar drives these clips from the CoS runtime via an `AnimationMixer`,
mapping each agent state to an **in-place** clip (see `MUSE_STATE_ANIMATIONS` in
`client/src/components/cos/constants.js`). `Walking` / `Running` / `WalkJump`
carry root translation and are intentionally left unmapped so the fixed-frame
avatar can't drift out of view. The `speaking` flag fires a one-shot `Wave`
overlay that returns to the base state loop.

| CoS state | Clip | Read |
|-----------|------|------|
| sleeping | `Sitting` | seated rest (clamped on final frame) |
| thinking | `Idle` | calm contemplation |
| coding | `Punch` | jabbing away at the work |
| investigating | `No` | slow side-to-side scan |
| reviewing | `Yes` | approving nod |
| planning | `ThumbsUp` | confident "locked in" |
| ideating | `Dance` | creative celebration |
| _speaking_ | `Wave` | one-shot gesture, then back to base loop |

A GLB with none of these clips (or no clips at all) falls back to the
procedural rotation/glow treatment, so static models still render.

## Selectable variants

**Kenney Mini Characters** — https://kenney.nl/assets/mini-characters
License: **Creative Commons Zero (CC0)** — public domain, free for personal,
educational, and commercial use. Attribution appreciated but not required.

The models were re-exported from Kenney's source GLBs with the embedded
texture packed in and Draco compression intentionally disabled (PortOS must
render them offline / over Tailscale without fetching an external Draco
decoder from a CDN).

| File | Character |
|------|-----------|
| `mini-male-c.glb`   | Mini Character — Male C (uniformed) |
| `mini-female-d.glb` | Mini Character — Female D (jacket, bun) |

Each ships 32 named animation clips (`idle`, `walk`, `sprint`, `sit`,
`emote-yes`, `interact-right`, etc.) that the avatar maps onto CoS agent states.

## Adding more

Drop any rigged GLB at `data/avatar/<name>.glb` and reference it via
`/api/avatar/model.glb?variant=<name>`. Clip names that match the
`STATE_CLIP_MAP` in `client/src/components/cos/MiniCharacterCoSAvatar.jsx`
will animate per-state; others fall back to `idle`.
