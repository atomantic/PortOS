---
name: portos-blender-model
description: Author a PortOS Blender model — one Blender Python script that builds a reusable 3D model PortOS builds, checks, exports to GLB, re-imports and publishes. Invoke when writing or revising a model's src/model.py, reading a build report, or driving builds and publishing through the API.
---

# Authoring a Blender model in PortOS

A Blender model is Python you write in `src/model.py`. PortOS runs it in Blender, measures it, exports `model.glb`,
imports that GLB into an empty scene and measures it again. Full reference:
[docs/features/blender-models.md](../../../docs/features/blender-models.md).

**The script runs as the operator, with full access to this machine.** Write only what the model needs. Never run
source you did not write or review, and never fetch code at build time. Builds need Blender in Trusted local mode;
never change the execution mode yourself.

## Where things are

Call the API with `node scripts/portos-api.js` (see the `portos-api` skill). `GET /api/blender-models/:id` returns
the state; `workspace.path` is the folder on this machine:

```
<workspace>/src/model.py              entry point (plus any modules and assets you add)
<workspace>/builds/<buildId>/         model.blend, model.glb, report.json, build.log (never rewritten)
<workspace>/renders/reviews/<buildId>/ <view>-textured.png, <view>-clay.png, sheet-*.jpg (regenerable)
```

No model yet: `POST /api/blender-models` `{ "name": "..." }`. No source yet: `POST /api/blender-models/:id/workspace`
copies a working three-part starter (a desk lamp). Read it before writing your own. Edit files in `src/` directly, or
with `PUT /api/blender-models/:id/file` `{ path, content }`.

Before modeling, look at every approved image in `src/refs/` and read `src/PARTS.md` when they exist. The overall sheet
decides proportions; a close-up plate decides its own mechanism. `GET /api/blender-models/:id` lists them under
`references` (review an image only after looking at it; `outOfDate` plates came from an earlier overall sheet).

## The contract

```python
def describe(ctx) -> dict:   # {"title", "sizeMeters": {"x", "y", "z"}, "triangleBudget", "parts": [{"id", "label", "parent"?}], "controls"?: [], "actions"?: [], "allowContact"?: []}
def build(ctx) -> None:      # one mesh object per declared part, named exactly by its id
def pose(ctx, action, t) -> dict:   # only with actions: {controlId: 0-1} at t (0 to 1)
```

- Meters, Z up, front facing -Y, standing on Z = 0 and centered on X = Y = 0 (review cameras frame that box). `sizeMeters` is the bounding box you intend; the build is held to it.
- Every real part is its own mesh object, named by its part id, parented as `describe` says (keep the world placement:
  set `matrix_parent_inverse` to the parent's inverted world matrix).
- Apply scale (or build at size); never mirror with a negative scale.
- The scene starts empty for every build. `ctx`: `workspace`, `src`, `out_dir`, `quality` (`draft` or `full`: use it to
  trade segment counts for speed), `log(message)`.

### Moving parts

Declare a control for every part that moves; never animate or add bones yourself.

```python
"controls": [
    {"id": "lid", "label": "Lid", "type": "hinge", "partId": "lid",          # hinge | slide | wheel
     "origin": [0, 0.1, 0.15], "axis": [-1, 0, 0],                           # world, meters, where the real pin is
     "min": 0, "max": 110, "default": 0},                                    # degrees (hinge, wheel) or meters (slide)
    {"id": "clip", "label": "Clip", "type": "slide", "partId": "clip", "origin": [0, -0.1, 0.05], "axis": [1, 0, 0],
     "min": 0, "max": 0.1, "default": 0, "dependsOn": [{"control": "lid", "atMost": 0.02}]},   # only moves on a shut lid
],
"actions": [{"id": "open", "label": "Open", "seconds": 1}],   # needs pose(ctx, action, t)
"allowContact": [["pin", "hinge_plate"]],                     # parts meant to touch; listed in the report
```

- Every control is 0–1 over `min`–`max`. Build the model **at its defaults**: that is the pose the checks call rest.
- A part takes the parts declared under it along. Two controls on one part stack in declared order.
- Ids are 1–48 letters, digits, `.`, `_` or `-`. A hinge spans at most 360°, a wheel 720°. `dependsOn` limits are 0–1.
- PortOS builds one bone and one linear one-second `control:<id>` clip per control (`action:<id>` per action), then
  sweeps: every control in 0.05 steps, related pairs in a 0.1 grid, every action frame. Parts that pass through each
  other are `sweep-overlap` errors with the pose that shows it. Fix the axis, clearance or range; use `allowContact`
  only for real contact. Leave a hair of clearance between parts as built: a pair that touches as built is not checked
  (`sweep-rest-overlap`).

- Optional `bake`: `{"size": 1024|2048|4096, "samples": N, "sets": [{"id", "partIds": [...]}]}` (see Baking below).

## Baking worn materials and fine detail

Blender procedural materials do not survive glTF export, and modeling every bolt head as exported geometry makes a model
too heavy for the viewers. Ask for a bake in `describe()` and let the textures carry the detail:

- A **full** build bakes each set (parts sharing one material and three images) with Cycles: base color, a tangent
  normal map and a packed `orm` image (R occlusion, G roughness, B metal). A **draft** build skips it (the report says
  `bake-skipped-draft`), so use procedural wear only when `ctx.quality == "full"`.
- `from portos_model import mark_bake_only, bolt_circle, hinge_barrel, pipe, lathe, worn_metal_material`. Model the
  fine detail (bolt heads, rivets, seams) as extra objects and call `mark_bake_only(obj)`: it shapes the normal map
  and stays out of the GLB and the triangle count. `worn_metal_material(...)` (edge wear, grime, rust) is a Principled
  material that bakes well; read base color, roughness and metal from a Principled BSDF in your own materials.
- Parts with no UVs are unwrapped into one atlas per set. Primitives from `bpy.ops` come with overlapping UVs, so
  remove their UV layers (the starter does) unless you laid them out yourself; more than 2% overlap in a set is an
  error. Read `report.json` `checks.bake` and the `bake-*` findings (`bake-image-missing`, `bake-all-black`,
  `bake-uv-overlap`, …).
- Each set bakes as its own job; an unchanged set (same geometry, UVs, materials, size and samples) is reused from an
  earlier build, so change one part and only its set rebakes. `POST …/builds/:buildId/bakes/:setId/cancel` cancels one.

## The loop

1. `POST /api/blender-models/:id/builds` `{ "quality": "draft" }` answers `202 { job, build }` (use `"full"` to bake). Wait for the
   `blender-model:changed` event or read the state until that build's `status` leaves `running`.
2. Read `GET /api/blender-models/:id/builds/:buildId/files/report.json`. A failed build has `error` in the record and the
   traceback in `build.log`. Fix every `error` finding (`part-missing`, `bounds-oversized`, `triangles-over-budget`,
   `scale-negative`, `sweep-overlap`, `control-*`, `reimport-*` …), then the warnings, and build again. The numbers in `checks` say by how much.
3. Compare. Each completed build is rendered from fixed views (`GET …/:id` lists `reviews`; wait for the `review` job).
   Look at `sheet-textured.jpg` and `sheet-clay.jpg` beside every image in `src/refs/`, then plan a second pass:
   `POST /api/blender-models/:id/differences` `{ "text", "partId"?, "referenceId"? }` for each thing missing or wrong.
   Save a close-up with `POST …/:id/cameras` `{ "label", "referenceId", "crop"?, "view" | "orbit" }`, then
   `POST …/builds/:buildId/review`. After rebuilding and looking again, close each with
   `PATCH …/differences/:id` `{ "status": "fixed" }`; `accepted` needs a `reason` and is for deliberate departures.
4. When a build has no errors and the director (or the task) wants it, `POST /api/blender-models/:id/publish`
   `{ "buildId": "..." }`. The published GLB is `GET /api/blender-models/:id/asset`.
5. To inspect a build by eye, `POST /api/blender-models/:id/builds/:buildId/open` opens its `.blend` in Blender.

PortOS keeps the published build and the newest five; older builds are removed.
