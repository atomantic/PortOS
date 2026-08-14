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

MuseCoSAvatar drives these clips from the CoS runtime via an `AnimationMixer`.
One map — `MUSE_STATE_MOTIONS` in `client/src/components/cos/constants.js` —
gives each agent state an ordered list of steps, `{ clip, timeScale, loop }`,
where `loop` is `'infinite'`, `'once'` (clamped on the final frame), or
`{ reps: N }` (a finite repeat that advances to the next step). A single-step
list is a plain base loop; a longer one is a montage. `Walking` / `Running` /
`WalkJump` carry root translation, so a step naming one is auto-routed to a
synthesized **in-place** variant and the fixed-frame avatar can't drift out of
view. The `speaking` flag fires a one-shot `Wave` overlay that returns to the
step it interrupted.

The model is rendered with its **own textures and full color** — the per-state
hue lives in the surrounding lights, halo, ground glow, and sparkles, not as a
tint painted onto the mesh.

| CoS state | Clip | Read |
|-----------|------|------|
| sleeping | `Sitting` | seated rest (clamped on final frame) |
| thinking | `Idle` | calm contemplation |
| coding | _montage_ | varied working sequence (see below) |
| investigating | `No` | slow side-to-side scan |
| reviewing | `Yes` | approving nod |
| planning | `ThumbsUp` | confident "locked in" |
| ideating | `Dance` | creative celebration |
| _speaking_ | `Wave` | one-shot gesture, then back to the interrupted step |

### `coding` montage

Rather than looping a single clip, the `coding` state's step list cycles an
ordered montage so a working agent reads as dynamic and varied:
**Punch → Running → Jump → ThumbsUp → Walking → Dance**, then repeats. Each step
plays for a set number of repetitions before the mixer's `finished` event
advances to the next.

The montage names real GLB clips. `Running` / `Walking` carry root translation,
so the avatar auto-routes them to synthesized **"in place"** variants — cloned
clips with their root-translation (`.position`) tracks stripped (the treadmill
technique, in `client/src/utils/animationClips.js`) — so the gait animates
without drifting the fixed frame. A GLB missing the montage clips degrades to
the list's **first** step (`Punch`), looped — the fallback is structural, so
every state (montage or not) resolves the same way.

A GLB with none of these clips (or no clips at all) falls back to the
procedural float treatment, so static models still render.

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
