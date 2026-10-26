# Place greybox: a 3D layout reference on Environments

## Context

Music-video sets are described by text and conditioned on generated reference
images. That does not hold a *layout* steady: across shots the rink's boards,
DJ booth, and skater positions drift, because every image is an independent
sample. A greybox is a coarse, untextured 3D layout of the place from which we
can pick camera angles and render depth/silhouette-style reference frames, then
feed those frames to image and video shot generation as reference points.

The greybox belongs to the **Place** primitive (catalog type `place`, shown as
Environments), so any consumer of a place (universe canon, series, Creative
Director, music video) can use it, not just one video.

## Decisions

1. **A facet of the Place, not a new store.** `payload.greybox` on the place
   ingredient. Additive optional payload field: no `payloadSchemaVersion` bump,
   per the established additive-field convention. Revisions, federation, merge
   and fork already carry payload, so history and cross-machine sync come free.
   Forks reset nothing here (a layout is creative description, not an approval).
2. **Two sources, one contract.**
   - `source: 'spec'` — a validated declarative scene (`server/lib/greyboxScene.js`):
     boxes, cylinders, extrudes of a floor outline, planes, labeled zones,
     placement anchors, saved camera shots. Authorable by hand in the browser
     editor, by an LLM, or by an agent. Rendered with the existing Three.js
     stack; never evaluates provider-written JavaScript (same trust boundary as
     `docs/THREEJS_MODELS.md`).
   - `source: 'glb'` — a Blender export attached as catalog media. Blender stays
     an authoring tool, not a runtime dependency: the user exports a `.glb`,
     attaches it with a new `model` media kind (`model/gltf-binary`, `.glb`),
     and the same viewer, shot picker and capture path apply. Shots/anchors are
     stored in `payload.greybox` either way, so a GLB place has the same
     camera and placement data as a spec place.
3. **Shots and anchors are the product.** Greybox data is mostly:
   - `landmarks[]` — named, positioned things worth referring to in prompts
     ("DJ booth", "north rail", "skate-rental counter").
   - `anchors[]` — named floor positions with a facing, for people and props
     (`kind: 'figure' | 'prop'`, height, optional catalog ingredient id). These
     are what keep "who stands where" consistent.
   - `shots[]` — named cameras: position, target, lens (mm) or fov, aspect,
     optional per-shot figure placements (anchor id + pose label). A shot is
     what a music-video shot later points at.
4. **Captures are ordinary reference images.** A shot renders in the browser to
   a PNG (flat grey shading with zone tint and anchor proxies, optional depth
   pass), is saved through the normal gallery path, and attaches to the place as
   a `reference` media row tagged `greybox-shot:<shotId>`. Re-capturing replaces
   by tag. This reuses the existing reference-library UI, conditioning and
   backup with no new image store. A server-side capture (headless browser) is a
   later phase so autopilot can capture without an open tab.
5. **Music-video wiring is opt-in per shot and visible.** The set subject keeps
   its catalog link. A video shot may name a `greyboxShotId` on its place; the
   capture is added to that shot's reference images with role `set`. Per the
   "never modify a model's input out of the user's sight" policy, the capture
   appears as a labeled chip on the shot's compose screen, its prompt additions
   (landmark names, figure placements) are listed as chips, and "Show full
   prompt" shows the exact final text. Autopilot records the sent additions.
   Nothing here triggers a provider call by itself.
6. **Federation.** Payload sync is version-gated already. GLB bytes ride the
   existing media-key sync. The `model` media kind is additive; an older peer
   that does not know the kind must ignore it rather than reject the row
   (verified in phase 2 against `catalogSync.js`).

## Scene contract (phase 1, `server/lib/greyboxScene.js`)

Units are meters, Y up, floor at y=0. Bounded counts (parts, anchors, shots,
landmarks) and bounded coordinates, matching `threejsModel.js` conventions.

- `parts[]`: `{ id, type: 'box'|'cylinder'|'plane'|'extrude', size/outline, position, rotationDegrees, zone?, label? }`
- `zones[]`: `{ id, label, color }` — tints, referenced by parts.
- `landmarks[]`, `anchors[]`, `shots[]` as above; every cross-reference
  (part zone, shot figure anchor) must resolve, ids unique per collection.
- `bounds` is derived, never stored, so a stored spec cannot lie about it.

## Phases

1. **Contract** — `greyboxScene.js` schema, `resolveGreybox(payload)` (absent =
   no greybox), derived bounds, place-payload field accepted by
   `catalogValidation` without a version bump. Pure, unit-tested.
2. **Viewer + shot capture** — Environments detail gets a Greybox panel: orbit
   viewer, anchor/landmark/shot list, "Save shot", PNG capture attached as a
   tagged reference. GLB attach with the `model` media kind. `⌘K`/URL: the
   selected shot is a route param (`/catalog/place/:id/greybox/:shotId`).
3. **Authoring** — "Draft greybox from description + references" via the
   shared provider runner (user-triggered, provider/model shown, never at
   boot), plus a Roller-rink starter template so the first greybox needs no
   LLM. Blender how-to doc for the GLB route.
4. **Music-video wiring** — shot-level `greyboxShotId`, chips in the compose
   screen, conditioning, orchestrator awareness (a shot with a greybox
   reference is checked against its landmarks/anchors in review).
5. **Headless capture** — server-side render so autopilot and background
   regeneration do not need a browser tab.

## Open questions deferred to implementation

- Depth/normal capture passes versus flat shading only: prototype in phase 2
  and keep whichever the image models condition on better.
- Whether figure proxies should be stylized capsules or a posable mannequin.
  Start with capsules sized by `heightMeters`.

## Verification

Phase 1: schema accepts a minimal rink, rejects dangling zone/anchor refs,
duplicate ids, out-of-range coordinates, and unknown part types; absent field
reads as "no greybox". Later phases: viewer renders the starter rink, a saved
shot's capture round-trips through the reference library, and a music-video shot
with a `greyboxShotId` lists the capture and its additions in "Show full prompt".
