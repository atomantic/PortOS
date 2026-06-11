# Rigged 3D Avatar — Stage View & Header Slot

**Status**: design approved, awaiting implementation plan
**Date**: 2026-04-20
**Scope**: single feature, one implementation plan

## Goal

Add a rigged, animated 3D character as a new avatar style for the Chief of Staff. The same runtime feeds two views:

- a small header slot (alongside existing `cyber`/`sigil`/`esoteric`/`nexus` variants), and
- a full-page **Stage** route at `/cos/stage`.

The character's body animation, facial expression, and speaking behavior react to CoS agent state (`sleeping`, `thinking`, `coding`, `investigating`, `reviewing`, `planning`, `ideating`) and the existing `speaking` flag — the same props every other avatar variant already consumes.

## Non-goals

- ~~Shipping a bundled 3D model in the repo.~~ **(Superseded 2026-06-10.)** PortOS now bundles two CC0 Kenney Mini Character GLBs as ready-to-use animated avatar styles (`miniMaleC`, `miniFemaleD`), seeded from `data.reference/avatar/` into `data/avatar/` by `setup-data.js`. The `muse` style still loads a user-supplied `./data/avatar/model.glb`; the bundled mini-characters are served from the same route via a `?variant=<name>` selector. See `client/src/components/cos/MiniCharacterCoSAvatar.jsx` and `data.reference/avatar/README.md`.
- Teaching users to rig characters. `docs/avatar-pipeline.md` links to external tools (AccuRIG 2, Mesh2Motion, Rigify) for the rigging step.
- Per-agent personas, skins, or multiple simultaneous avatars.
- Phoneme-timed TTS lip-sync. Speaking is driven by audio amplitude or a sine fallback, not phoneme sequences. A viseme-per-phoneme engine is a later upgrade if desired.
- LOD swap, user-uploaded clip-remap UI, or runtime model format conversion.

## Architecture

```
client/src/components/cos/
  Rigged3DCoSAvatar.jsx       # header slot component (small canvas, fixed camera)
  Rigged3DStage.jsx           # 3D scene component (canvas + camera + lighting); used by the Stage page
  avatar3d/
    useAvatarModel.js         # GLB resolution + load (HEAD → GET or 404 fallback)
    useAvatarCapabilities.js  # scans loaded GLB, returns capability descriptor
    useStateAnimation.js      # body-clip layer: crossfades AnimationMixer clips
    useExpressionLayer.js     # blendshape layer: per-state facial expression targets
    useLifeLayer.js           # always-on: blink + saccades + breathing
    useSpeakingLayer.js       # viseme or head-bob, capability-gated
    stateClipMap.js           # canonical state → clip-name + expression targets
    emptyStateCopy.js         # strings for the "no model configured" UX

client/src/pages/
  CoSStagePage.jsx            # route container — switches between Rigged3DStage (model present) and EmptyStateCard (missing)

server/routes/
  avatar.js                   # GET /api/avatar/model.glb, HEAD /api/avatar/model.glb
```

No new npm dependencies — `@react-three/fiber`, `@react-three/drei`, and `three` are already installed (confirmed in `client/package.json`).

Avatar-style registry (`client/src/components/cos/constants.js`) gains one entry: `rigged3d: "Rigged Character (3D)"`. The option is always visible in the settings dropdown; selecting it when no model is configured shows the empty-state view and does not break existing behavior.

New sidebar nav item "Stage" under Chief of Staff, alphabetically ordered (after "Schedule"). Route `/cos/stage`.

## Model resolution

`useAvatarModel` runs once per mount:

1. `HEAD /api/avatar/model.glb`
2. 200 → `useGLTF('/api/avatar/model.glb')`
3. 404 or network error → returns `{ status: 'missing' }`. No bundled fallback is attempted.

Server route `GET /api/avatar/model.glb`:
- Streams `./data/avatar/model.glb` with `Content-Type: model/gltf-binary` if present.
- Returns 404 otherwise. The missing case is normal, not an error.
- `HEAD` supported for the probe without downloading the body.

## Capability detection

On successful load, `useAvatarCapabilities` scans the parsed glTF JSON once and produces:

```js
{
  hasSkins: boolean,
  availableClips: Set<string>,
  hasVisemes: boolean,           // any of V_Open / V_Tight / V_Explosive etc.
  hasBlinkShapes: boolean,       // Eye_Blink_L && Eye_Blink_R
  hasEyeLook: boolean,           // Eye_*_Look_* shapes present
  hasBrowShapes: boolean,        // Brow_* shapes present
  hasMouthShapes: boolean,       // Mouth_Smile_*, Mouth_Frown_*
  skeletonHint: 'cc3' | 'mixamo' | 'unknown',
}
```

Every runtime layer gates behavior on this object. Missing capabilities silently degrade — the canvas never crashes because a shape key or clip is absent.

## Runtime: three layers + speaking

All four layers compose on the same scene graph and are independent.

**Layer 1 — Body clip (`useStateAnimation`)**
`AnimationMixer` plays one body clip per CoS state. State transitions crossfade over 300 ms via `fadeOut(0.3)` + `fadeIn(0.3).play()`. All clips loop (`LoopRepeat`). If the configured state clip is missing, falls back to `base`. If `base` is missing, the mesh stands in T-pose (capability detector flags this as a config error surfaced in the empty-state panel).

**Layer 2 — Expression (`useExpressionLayer`)**
Per-state facial targets from `stateClipMap`. Eased to targets over 300 ms using a per-frame lerp. Skipped entirely if `hasBrowShapes && hasMouthShapes` is false. Target set intentionally small (brow raise/drop/compress, mouth smile/frown, eye squint/wide) — expressive but inside the common-denominator CC3+/ARKit shape vocabulary.

**Layer 3 — Life (`useLifeLayer`)**
Always-on ambient motion, independent of state:
- **Blink cycle**: `Eye_Blink_L` + `Eye_Blink_R` driven to 1.0 for ~120 ms every 3–5 s (randomized). Skipped if `!hasBlinkShapes`.
- **Saccades**: every 2–6 s pick a random `Eye_*_Look_*` pair at 0.3 amplitude for 200 ms. Skipped if `!hasEyeLook`.
- **Breathing**: small sine modulation on root scale Y (~0.5%) — works without shape keys, always on.

**Layer 4 — Speaking (`useSpeakingLayer`)**
Triggered by the existing `speaking` prop:
- If `hasVisemes`: drive `V_Open` + `V_Lip_Open` from an audio amplitude analyzer if a speaking audio stream is available; else drive from a 6 Hz sine while `speaking === true`.
- If `!hasVisemes`: small sinusoidal rotation on the head bone (≤5°) — works on any rigged mesh.

## State → clip + expression mapping

`stateClipMap.js` exports one object that's the single source of truth:

```js
export const stateClipMap = {
  base:          { clip: 'base',          expression: {} },                     // required fallback
  sleeping:      { clip: 'sleeping',      expression: { Eye_Blink_L: 1, Eye_Blink_R: 1 } },
  thinking:      { clip: 'thinking',      expression: { Brow_Compress_L: 0.5, Brow_Compress_R: 0.5 } },
  coding:        { clip: 'coding',        expression: { Mouth_Smile_L: 0.2, Mouth_Smile_R: 0.2 } },
  investigating: { clip: 'investigating', expression: { Brow_Raise_Outer_L: 0.6, Brow_Raise_Outer_R: 0.6, Eye_Wide_L: 0.4, Eye_Wide_R: 0.4 } },
  reviewing:     { clip: 'reviewing',     expression: { Brow_Compress_L: 0.3, Brow_Compress_R: 0.3 } },
  planning:      { clip: 'planning',      expression: {} },
  ideating:      { clip: 'ideating',      expression: { Brow_Raise_Inner_L: 0.6, Brow_Raise_Inner_R: 0.6, Mouth_Smile_L: 0.3, Mouth_Smile_R: 0.3 } },
};
```

Clip names are the **contract with the user-supplied GLB**: whichever model a user drops in, they rename their animation tracks to these keys during Blender export (documented in `docs/avatar-pipeline.md`).

## Empty-state UX

When `useAvatarModel` returns `{ status: 'missing' }`:

- **Header slot** (`Rigged3DCoSAvatar`): renders nothing itself and lets the existing fallback chain pick the previously-selected style (or `cyber` default). Header never shows a broken canvas.
- **Stage route** (`Rigged3DStage`): renders `EmptyStateCard` — full-page panel with the feature name, a short description, the `./data/avatar/model.glb` target path, required clip-name contract, and a link to `docs/avatar-pipeline.md`. Sidebar nav entry stays visible so the feature remains discoverable.

## Settings integration

Avatar style dropdown (existing UI) gains `rigged3d`. When selected:

- If model is present: `Rigged3DCoSAvatar` renders in the header slot.
- If model is missing: style is accepted but the header slot falls back to the prior style. A small "⚠ no model configured — see setup guide" hint appears under the dropdown.

No change to `AVATAR_STYLE_LABELS` consumers elsewhere.

## Assets & docs

`docs/avatar-pipeline.md` is authored as part of this feature and covers:

- Where to drop the GLB (`./data/avatar/model.glb`).
- The required clip-name contract (`base`, `sleeping`, `thinking`, `coding`, `investigating`, `reviewing`, `planning`, `ideating`).
- Optional shape keys that unlock richer behavior (CC3+ `V_*` visemes, `Eye_Blink_*`, `Brow_*`, `Mouth_Smile_*`).
- Worked example: using the freely-downloadable Amber CC3 character from https://www.cgtrader.com/free-3d-models/character/woman/amber-free-high-poly-3d-model, reduced via a documented Blender texture-downsample + Draco export.
- Pointers for users starting from an unrigged mesh (AccuRIG 2, Mesh2Motion, Rigify) — not step-by-step, just links.
- Explicit note: license compliance for the dropped-in model is the user's responsibility.

## Error handling

No `try`/`catch` — the codebase convention is to let errors bubble to centralized middleware. Capability-gated fallbacks replace defensive exception handling:

- Missing GLB → 404 → empty-state view.
- GLB load failure (corrupt file, network error) → error bubbles, `useGLTF` Suspense boundary shows the empty state with a distinct "model failed to load" message instead of the generic "no model configured" message.
- Missing clip → fall back to `base` clip.
- Missing shape keys → that layer is a no-op.
- Missing `base` clip → capability detector sets a warning that surfaces in the empty-state panel.

## Testing

Server:
- `avatar.js` route: 404 when file absent, 200 with `model/gltf-binary` when present, HEAD returns correct status without body. Uses a small fixture GLB in `server/test/fixtures/`.

Client — pure-logic units (preferred pattern per `CLAUDE.md`):
- `useAvatarCapabilities` classifier: given a parsed glTF JSON, returns the expected capability descriptor. Multiple fixtures: no-skin, Mixamo-rigged, CC3-full.
- `stateClipMap` integrity: every state has a clip + expression; `base` exists; no typos in shape key names against the CC3+ reference.

Client — integration:
- `useStateAnimation` clip lookup falls back to `base` when the requested clip is missing.
- Empty-state renders when the API returns 404, without mounting an R3F canvas.

Visual behavior (blink timing, crossfade, saccade randomness) is not unit-tested — validated by manual Stage-view check during implementation.

## Out of scope (explicitly deferred)

- Per-phoneme TTS viseme timing.
- Per-agent avatar customization.
- User-uploaded clip-name remap UI in settings.
- LOD swap between header and stage.
- Inline model upload via the web UI (users drop files directly into `./data/avatar/`).
- Shipping a default model.

## Files touched

Created:
- `client/src/components/cos/Rigged3DCoSAvatar.jsx`
- `client/src/components/cos/Rigged3DStage.jsx`
- `client/src/components/cos/avatar3d/` (6 files listed above)
- `client/src/pages/CoSStagePage.jsx`
- `server/routes/avatar.js`
- `server/test/fixtures/cos-avatar.glb` (tiny test fixture, NOT a user-facing model)
- `server/test/avatar.test.js`
- `client/src/components/cos/avatar3d/__tests__/*.test.js`
- `docs/avatar-pipeline.md`

Modified:
- `client/src/components/cos/constants.js` — add `rigged3d` to `AVATAR_STYLE_LABELS`
- `client/src/components/cos/index.js` — export new components
- `client/src/App.jsx` — register `/cos/stage` route
- `client/src/components/Layout.jsx` — add "Stage" sidebar entry
- `server/server.js` — mount `avatar.js` router
