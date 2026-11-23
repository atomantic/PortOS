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
<workspace>/renders/                  regenerable previews
```

No model yet: `POST /api/blender-models` `{ "name": "..." }`. No source yet: `POST /api/blender-models/:id/workspace`
copies a working three-part starter (a desk lamp). Read it before writing your own. Edit files in `src/` directly, or
with `PUT /api/blender-models/:id/file` `{ path, content }`.

## The contract

```python
def describe(ctx) -> dict:   # {"title", "sizeMeters": {"x", "y", "z"}, "triangleBudget", "parts": [{"id", "label", "parent"?}], "controls"?: []}
def build(ctx) -> None:      # one mesh object per declared part, named exactly by its id
```

- Meters, Z up, front facing -Y. `sizeMeters` is the bounding box you intend; the build is held to it.
- Every real part is its own mesh object, named by its part id, parented as `describe` says (keep the world placement:
  set `matrix_parent_inverse` to the parent's inverted world matrix).
- Apply scale (or build at size); never mirror with a negative scale.
- The scene starts empty for every build. `ctx`: `workspace`, `src`, `out_dir`, `quality` (`draft` or `full`: use it to
  trade segment counts for speed), `log(message)`.
- `controls` is stored but has no behavior yet.

## The loop

1. `POST /api/blender-models/:id/builds` `{ "quality": "draft" }` answers `202 { job, build }`. Wait for the
   `blender-model:changed` event or read the state until that build's `status` leaves `running`.
2. Read `GET /api/blender-models/:id/builds/:buildId/files/report.json`. A failed build has `error` in the record and the
   traceback in `build.log`. Fix every `error` finding (`part-missing`, `bounds-oversized`, `triangles-over-budget`,
   `scale-negative`, `reimport-*` …), then the warnings, and build again. The numbers in `checks` say by how much.
3. When a build has no errors and the director (or the task) wants it, `POST /api/blender-models/:id/publish`
   `{ "buildId": "..." }`. The published GLB is `GET /api/blender-models/:id/asset`.
4. To inspect a build by eye, `POST /api/blender-models/:id/builds/:buildId/open` opens its `.blend` in Blender.

PortOS keeps the published build and the newest five; older builds are removed.
