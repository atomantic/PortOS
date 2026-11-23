# Blender Models

A **Blender model** is a reusable 3D asset made from Python you (or a coding agent) write. PortOS runs the script
in Blender, measures what it built, exports a GLB, imports that GLB back into an empty scene and measures it again.
Every build is kept with a report; you publish the build you want, and its GLB is what other parts of PortOS use.

This page covers the engine (issue #17874), its page (issue #17875), references (issue #17876) and comparison (issue #17877), part of the Blender Models epic #17869.
Joints and texture baking arrive in later phases.

## On the 3D page

**3D** (`/3d`) lists Blender models beside image-to-3D renders with a "Blender" tag, and **New Blender model** creates one
(a name and an optional one-line description). When Blender cannot build yet, the form names the reason and links to
Code Animation › Blender execution. A model opens at `/3d/blender/:id/:tab?`:

- **Model**: the newest completed build (`?build=` picks another), its size and triangles against budget, its findings
  by severity, and the part list. Choosing a part (`?part=`) shows it alone in the viewer. Build, Publish, Copy agent
  brief, Open in Blender and the GLB / .blend downloads are here.
- **References**: sheets and the parts brief made before modeling (below).
- **Compare**: a build beside its references, with the differences still open (below).
- **Files**: the `src/` editor films use. Unsaved edits hold builds back until saved or discarded.
- **Builds**: running and recent jobs with their logs, then every kept build with its log, review and Publish.
- **Settings**: Blender readiness, the workspace path, the name and description, and Delete.

## References

The **References** tab (issue #17876) draws what the model is built from, in order:

1. **Source**: a Casting object (its canonical image, product sheet and size come in), gallery images, uploads or
   mood-board pins, the real size, and the renderer.
2. **Overall sheet**: six directions at one scale with the real size stated. Render it, or use an existing image.
3. **Close-up plates**: one per mechanism you name, square-on and from the side, conditioned on the approved overall
   sheet and the source images. Locked until an overall sheet is approved.
4. **Review**: Approve, or Redo with an optional note that joins your words for the next render. A new image never
   replaces an approved one until you approve it; the old one is then superseded. A plate made from an earlier
   overall sheet is marked **Out of date**.
5. **Parts brief**: `src/PARTS.md`, created from a template and edited under Files.

Your words are sent exactly as typed; everything PortOS adds is a labeled chip, and **Show full prompt** comes from
the code that sends it. More reference images than the renderer takes is refused, never cut. An image queues only when
you press Render, and it attaches even if PortOS restarts meanwhile. Approved images are copied into `src/refs/`, so
approving one counts as a source change, and the agent brief lists them.

## Compare

After each completed build PortOS opens its saved `model.blend` and renders six orthographic directions and a
three-quarter view, each **textured** and **clay**, under flat light and at one scale. A failed or canceled review
never changes the build; **Render again** repeats it. The **Compare** tab (issue #17877) shows:

- **Reference beside render**, from the chosen camera (`?cam=`), textured or clay (`?look=`), against a reference
  (`?ref=`), and a second build (`?vs=`) from the same camera.
- **Cameras**: one per panel of a reference. A camera is a fixed direction, or an orbit (azimuth, elevation, distance,
  lens, the part it aims at) for close-ups, plus the panel of the reference it matches. An aim point is fixed when
  the camera is saved, so a part that moves does not move the frame.
- **Staleness**: renders belong to one build and say when a newer one exists, or when the camera changed since.
- **Differences**: `{ text, partId?, referenceId?, status }`, written by you or an agent. Closing one records the
  build it was judged on. `accepted` is a deliberate departure and takes a reason. Open ones go into the agent
  brief as the second pass. They belong to the model, so they survive rebuilds.

Cameras frame the **declared** box (`describe().sizeMeters`), standing on Z = 0 and centered on X = Y = 0, never the
mesh, so two builds of one declared size frame identically. A model built outside that frame gets the
`review-out-of-frame` warning. A reference has no measured scale, so there is no similarity score.

## Trust and requirements

A model script is the operator's own code and runs with this machine's privileges, exactly like a
[Blender film](./music-video-blender.md). So:

- Builds need the operator-checked Blender in **Trusted local** mode (Code Animation > Production > Blender execution).
  In contained mode a build is refused with `409 MUSIC_VIDEO_BLENDER_NEEDS_TRUSTED_LOCAL`, the same answer films give.
  PortOS never changes the execution mode.
- Every write (source files, the starter, builds, publish, open in Blender) needs operator authority: a local
  connection on a password-free install, or a signed-in session or `PORTOS_API_TOKEN` agent when a password is set.
  A LAN/tailnet peer is refused.
- Nothing runs at boot. A build left running when PortOS stopped is marked failed on the next start, never restarted.
- Records and files are machine-local; they do not federate.

## Workspace

```
data/blender-models/<id>/
  src/                 your code; entry point src/model.py (plus any modules and assets you add) — backed up
  builds/<buildId>/    one build, never rewritten — backed up
    model.blend          the built scene
    model.glb            the export
    report.json          checks and findings
    build.log            everything Blender and the script printed
  renders/             regenerable — excluded from backups
    reviews/<buildId>/   <view>-textured.png, <view>-clay.png, sheet-textured.jpg, sheet-clay.jpg, review.json
```

`src/` follows the same file rules as a film workspace: text sources (`.py`, `.js`, `.mjs`, `.json`, `.txt`, `.md`)
are read and written through the API; binary assets (images, HDRIs, fonts, `.glb`, `.obj`, `.blend`) are placed on
disk and listed but never sent through the API. Symlinks, dotfiles and paths deeper than six folders are ignored.

## The model contract

```python
def describe(ctx) -> dict:
    return {
        "title": "Desk lamp",
        "sizeMeters": {"x": 0.22, "y": 0.22, "z": 0.52},   # the intended bounding box
        "triangleBudget": 2000,
        "parts": [
            {"id": "base", "label": "Weighted base"},
            {"id": "stem", "label": "Stem", "parent": "base"},
        ],
        "controls": [],   # optional; stored now, given behavior by the joints phase (#17878)
    }

def build(ctx) -> None:
    ...  # one mesh object per declared part, named by its id
```

- Build in **meters**, **Z up**, with the model's **front facing -Y**, standing on Z = 0 and centered on X = Y = 0.
- A part id is 1–64 letters, digits, `.`, `_` or `-`, starting with a letter or digit. `parent` names another part;
  set the Blender object's parent to match.
- `ctx` carries `workspace`, `src`, `out_dir` (this build's folder), `quality` (`draft` or `full`) and `log(message)`.
- Each build starts from an empty factory scene, so `build` creates everything it needs.

`POST /api/blender-models/:id/workspace` copies a working starter (`src/model.py`, a three-part desk lamp). Read it
before writing your own.

## What a build checks

`report.json` holds the numbers and a list of findings. Each finding is `error`, `warning` or `note`; a build with any
error is kept and marked, and only a build without errors can be published.

| Check | Finding codes |
|---|---|
| describe() shape | `describe-missing`, `describe-size-invalid`, `describe-budget-invalid`, `parts-none`, `part-id-invalid`, `part-duplicate`, `part-parent-unknown` (errors); `controls-invalid`, `parts-truncated` (warnings) |
| Parts vs meshes | `part-missing`, `meshes-none` (errors); `mesh-undeclared`, `part-parent-mismatch`, `meshes-truncated` (warnings) |
| Size, per axis against `sizeMeters` | `bounds-oversized`, `bounds-undersized` (over 10%, errors); `bounds-drift` (2–10%), `review-out-of-frame` (warnings) |
| Triangles (modifiers applied) against `triangleBudget` | `triangles-over-budget` (error) |
| Transforms | `scale-negative` (error); `scale-unapplied` (warning) |
| Materials and images | `materials` (note with both counts) |
| Export | `export-missing` (error) |
| GLB re-imported into an empty scene | `reimport-missing`, `reimport-mesh-count`, `reimport-triangles`, `reimport-bounds` (errors); `reimport-materials`, `reimport-actions` (warnings) |

`checks` records the counts behind each: declared and built parts with the missing and undeclared names, declared
and actual size with the error per axis, triangles against the budget, the meshes with unapplied or negative scale,
material, image and action counts, the GLB size, and the re-import's object, mesh, triangle, material, image and
action counts and bounds.

## Builds, publishing and retention

- One build runs per model. A build never changes the published build: a canceled, crashed or flagged build is
  recorded and kept, and the published GLB stays what it was.
- Publishing sets `publishedBuildId`. The published GLB is served by `GET /api/blender-models/:id/asset` as
  `model/gltf-binary`.
- PortOS keeps the published build, any running build and the newest five; the rest are removed after each build and
  each publish.
- Deleting a model soft-deletes the record and removes `builds/` and `renders/`; your `src/` stays on disk.

## API

| Method and path | What it does |
|---|---|
| `GET /api/blender-models` | `{ models, tool }`: live models, and whether Blender can build here |
| `POST /api/blender-models` `{ name, description? }` | Create a model (201, its state) |
| `GET /api/blender-models/:id` | The record plus `workspace` (path, `hasModel`, file count, `srcHash`, `srcChanged`), `tool` readiness and `jobs` |
| `PATCH /api/blender-models/:id` `{ name?, description? }` | Rename or describe |
| `DELETE /api/blender-models/:id` | Soft-delete (cancels a running build first) |
| `POST /api/blender-models/:id/workspace` | Copy the starter `src/model.py` (409 once it exists) |
| `GET /api/blender-models/:id/files` | List `src/` |
| `GET` / `PUT` / `DELETE /api/blender-models/:id/file?path=` | Read, write (`{ path, content }`) or delete one source file |
| `POST /api/blender-models/:id/builds` `{ quality? }` | Start a build (202, `{ job, build }`) |
| `POST /api/blender-models/:id/builds/:buildId/cancel` | Cancel a running build |
| `GET /api/blender-models/:id/builds/:buildId/files/:name` | `model.glb`, `model.blend`, `report.json` or `build.log` |
| `POST /api/blender-models/:id/builds/:buildId/open` | Open the build's `.blend` in Blender (embedded scripts stay off) |
| `POST /api/blender-models/:id/builds/:buildId/review`, `…/review/cancel` | Render a completed build's review again (202, `{ job }`), or cancel it |
| `GET /api/blender-models/:id/builds/:buildId/review/:name` | `<view>-<look>.png`, `sheet-<look>.jpg`, `review.json` or `review.log` |
| `POST …/:id/cameras` `{ label, referenceId, crop?, view \| orbit }`, `PATCH` / `DELETE …/cameras/:cameraId` | Compare cameras; `crop` is 0–1 fractions, `orbit` is `{ azimuth, elevation, distance, lens, partId? }` |
| `POST …/:id/differences` `{ text, partId?, referenceId? }`, `PATCH` / `DELETE …/differences/:differenceId` | Differences; `PATCH` takes `status` (`open`, `fixed`, `accepted`), `reason` and `buildId` |
| `POST /api/blender-models/:id/publish` `{ buildId }` | Publish a completed build without errors |
| `PATCH /api/blender-models/:id/reference-source` `{ ingredientId?, images?, size?, imageMode?, imageModelId? }` | What the reference images start from |
| `POST /api/blender-models/:id/references` `{ mechanism }`, `DELETE …/references/:refId` | Add or remove a close-up plate (the overall sheet is `overall`) |
| `POST …/references/:refId/preview` `{ words? }` | Exactly what a render would send; queues nothing |
| `POST …/references/:refId/render` `{ words? }` | Queue one image (202, `{ jobId, imageId }`) |
| `POST …/references/:refId/images` `{ filename }` | Put a library image up for review |
| `POST …/references/:refId/images/:imageId/review` `{ decision, note? }` | `approve` or `redo` |
| `POST /api/blender-models/:id/parts-brief` | Create `src/PARTS.md` (409 once it exists) |
| `GET /api/blender-models/:id/asset` | The published GLB |

Every change announces `blender-model:changed` `{ id }` over Socket.IO (record writes, source writes, build job
start and finish); the client re-reads the model. Nothing polls.

## Internals

- `server/services/blenderModels/`: `store.js` (PostgreSQL `blender_models`), `workspace.js` (paths and
  containment), `driver.js` + `py/portos_model_driver.py`, `protocol.js` (the driver's `PORTOS_MODEL ` stdout
  events), `report.js` (checks), `build.js` (the job, pruning, boot recovery) and `models.js` (records, source,
  publish, asset, open).
- `references.js` holds the reference slots and review, `referenceImageHook.js` attaches finished renders, and
  `server/services/catalog/modelSheetPrompts.js` builds the prompts.
- `review.js` renders a build's review and reads its manifest, `reviewCameras.js` derives every camera (pure),
  `compare.js` holds cameras and differences, and `jobs.js` is the job list builds and reviews share.
- `server/services/blenderWorkspace/` is shared with films: path containment, the `src/` tree, source hashing, the
  Trusted local gate and driver launch, the in-memory job registry and the per-job log.
