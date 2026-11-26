# Blender Models

A **Blender model** is a reusable 3D asset made from Python you (or a coding agent) write. PortOS runs the script
in Blender, measures what it built, exports a GLB, imports that GLB back into an empty scene and measures it again.
Every build is kept with a report; you publish the build you want, and its GLB is what other parts of PortOS use.

This page covers the engine (issue #17874), its page (issue #17875), references (issue #17876), comparison (issue #17877), moving parts (issue #17878)
and texture baking (issue #17879), part of the Blender Models epic #17869.

## On the 3D page

**3D** (`/3d`) lists Blender models beside image-to-3D renders with a "Blender" tag, and **New Blender model** creates one
(a name and an optional one-line description). When Blender cannot build yet, the form names the reason and links to
Code Animation › Blender execution. A model opens at `/3d/blender/:id/:tab?`:

- **Model**: the newest completed build (`?build=` picks another), its size and triangles against budget, its findings
  by severity, and the part list. Choosing a part (`?part=`) shows it alone in the viewer. **Pose** has a slider for each
  moving part, and an overlap finding has **Show pose** (below). Build, Publish, Copy agent brief, Open in Blender and the GLB / .blend downloads are here.
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
[Blender film](./music-video.md#blender-films). So:

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
    model.blend          the built scene (a baked build's holds the baked materials, not the bake-only objects)
    model.glb            the export
    report.json          checks and findings
    build.log            everything Blender and the script printed, bakes included
    bake/<setId>/        a full build's baked set: base_color.png, normal.png, orm.png, bake.json
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
        "controls": [],       # optional: what moves (below)
        "actions": [],        # optional: choreographed moves, posed by pose(ctx, action, t)
        "allowContact": [],   # optional: pairs of part ids meant to touch
        "bake": {             # optional: see "Baking textures"
            "size": 2048,
            "samples": 32,
            "sets": [{"id": "metal", "partIds": ["base", "stem"]}],
        },
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

## Moving parts

`describe().controls` (issue #17878) says what moves and on which axis; PortOS builds the bones.

```python
{"id": "lid", "label": "Lid", "type": "hinge",      # hinge | slide | wheel
 "partId": "lid",                                    # the part on the bone; parts declared under it ride along
 "origin": [0, 0.1, 0.15], "axis": [-1, 0, 0],       # world space, meters
 "min": 0, "max": 110, "default": 0,                 # degrees for hinge and wheel, meters for slide
 "dependsOn": [{"control": "clip", "atMost": 0}]}    # optional: where other controls must be (0-1) for this one to move
```

- **Every control is 0–1**, mapped linearly to `min`–`max`; a value outside clamps. `build(ctx)` makes the model at its
  defaults, so the default is the rest pose of the GLB.
- The driver adds one bone per control, parents its part rigidly (two controls on one part stack in declared order) and
  exports one linear one-second clip per control, `control:<id>`. Seeking it to `t = value` poses the GLB in any viewer,
  and the clips key separate nodes, so any mix of them plays together.
- `actions` is `[{ "id", "label"?, "seconds" }]`. `pose(ctx, action, t)` answers `{ controlId: 0-1 }` for `t` from 0 to 1;
  a control it leaves out stays at its default. Each exports as `action:<id>` at 24 frames a second.
- A model with controls runs at 24 fps. Ids are 1–48 characters; a hinge spans at most 360°, a wheel 720°.

**The sweep** runs in every build that has controls:

- each control in 0.05 steps with the others at default, or where its dependencies need them;
- a 0.1 grid for two controls that move a part in common or where a dependency joins them. Poses a dependency rules out
  are left out and counted as unreachable;
- every frame of every action;
- up to 120 seconds (draft) or 600 (full). What is left is reported as **unmeasured**, never as clean.

In each pose, triangles of parts on different bones are tested against each other (so a part wholly inside another is not
seen). Pairs that already overlap as built are listed and not checked. `allowContact` pairs are listed too, never
hidden. Each control's clip is also sought at -0.3, 0, 0.5, 1 and 1.3 and its part measured, and the re-imported GLB's
clip must take the part to the same end poses.

On the **Model** tab, **Pose** sliders seek the GLB's own clips in the browser. A control whose dependency is unmet is
disabled with the reason, and returns to its default when what it depends on moves away. **Show pose** on an overlap sets
the sliders to the first pose where it happens and tints the two parts. Nothing is saved.

## Showcase film

**Make showcase film** (model page header, once a build is published; `POST /api/code-animation/films/showcase` with `{ modelId, title? }`)
makes a Code Animation film project (`kind: 'film'`) from the published build and opens it at
`/code-animation/production/films/:filmId`. It starts no job: sync, stills and cuts are the usual explicit actions there.

The film is self-contained and editable. `src/models/model.glb` is the published GLB (a film-model copy of kind `blender-model`;
**Update copy** on the Files tab refreshes it), `src/showcase.json` holds the size, parts with their measured centers, controls,
choreographed actions and up to six saved compare cameras from the published build's report, and the approved overall sheet, when
there is one, is copied to `src/showcase/sheet.<ext>`. The `showcase` starter (`server/services/film/py/showcase/`) writes the shots:

1. **Turntable**: one full turn, framed from the model's size.
2. **Assembly**: each part moves in along its offset from the model center, in declared part order.
3. **Controls**: each control goes 0 to 1 to 0 in turn (a control's dependencies are held satisfied), then each choreographed action. The camera frames everything the parts reach, measured from the model in Blender when the shot is built. Skipped when there are none.
4. **Close-ups**: one per saved compare camera.
5. **Reference to model**: the approved sheet cross-dissolves to the render from the three-quarter view. Skipped without an approved sheet.

Every shot but Controls holds the model with each control at its default; the GLB's clips play only in Controls.

Film options: background, accent color, turn length, label parts. Every shot is a pure function of time (`kit/plan.py`, standard
library only, so describe needs no Blender). The timeline starts at the shots' natural length; a longer or shorter timeline scales
every shot in proportion, and with a soundtrack attached each inner boundary snaps to the nearest downbeat. A model with no controls
and no references still gives a valid film (turntable and assembly). Send to Music Video works as for any film.

## Baking textures

Blender procedural materials do not survive glTF export, and modeling every bolt head as exported geometry makes a
model too heavy for the viewers. `describe()["bake"]` asks PortOS to bake them into plain textures:

- `size` is 1024, 2048 or 4096, `samples` is Cycles' sample count (1–1024), and `sets` lists up to 16
  `{ id, partIds }`: the parts of a set share one material and one set of three images. A part belongs to at most one
  set; a part in no set keeps its own material.
- **Draft builds skip baking** (their report says so with `bake-skipped-draft`, and the GLB carries only what glTF can
  hold of the materials). A **Full** build bakes. The model page's header has **Build draft** and **Build full**, and
  the Builds tab shows each build's bake (sets, size, reuse).
- Mark detail geometry with `mark_bake_only(obj)` (below), or set the custom property `portos_bake_only` yourself.
  Those objects shape the normal map, are left out of the GLB and out of every count and check, and stay in the
  saved `model.blend` of a draft build. `portos_bake_sets` (`"metal,cloth"`) limits the sets one shapes; by default it
  shapes all of them.
- Parts without UVs are unwrapped (smart project) into one shared atlas per set. Parts that already have UVs keep
  their active UV map (the others are dropped); two parts in one set must not overlap in it. A set whose UV overlap is
  over 2% of its covered area is an error and is not baked.
- Per set, Cycles bakes **base color**, a tangent-space **normal** map (from the set's parts and every bake-only
  object that shapes it) and one packed **orm** image (R occlusion, G roughness, B metal). Base color, roughness and
  metal are read from the material's Principled BSDF (a linked node or its value). The GPU is used when Cycles finds
  one, otherwise the CPU; the first GPU bake on a machine compiles kernels, which can take several minutes. Set
  `PORTOS_BLENDER_BAKE_DEVICE=cpu` to keep bakes on the CPU.
- The export then gives each set's parts one plain glTF material built from its three images (the ORM image feeds
  roughness, metal and occlusion), exports the GLB and re-imports it. The report's `reimport.images` shows three
  images per set.

Each set is **its own background job** (kind `bake`, shown on the Builds tab with its progress and a Cancel), run one
after another inside the build's slot: it joins the build's limits (one Blender process per model at a time, the
build's wall-clock, memory and disk caps) and the build keeps the system busy for the unattended updater. A set is
written beside its folder and moved in whole, so a canceled or failed bake never leaves half a set. Canceling a bake
(`POST …/builds/:buildId/bakes/:setId/cancel`) ends that build as canceled; an earlier build's baked set and the
published build are untouched.

A set is **reused** when its content hash, size and samples match the same set in one of the model's earlier builds:
the hash covers its parts' geometry, UVs and materials (node settings and values) and the bake-only objects that
shape it. Changing one part rebakes only its set. A reused set is copied into the new build's folder, so every build
stays whole; the report marks it `reused` with `reusedFrom`.

| Finding | Meaning |
|---|---|
| `bake-image-missing`, `bake-all-black`, `bake-uv-overlap`, `bake-set-unprepared`, `bake-not-run` | errors: an image was not written, an image has no pixel above black, a set's UVs overlap over 2%, a set names a part that is not a mesh, nothing baked |
| `bake-invalid`, `bake-size-invalid`, `bake-samples-invalid`, `bake-sets-invalid`, `bake-set-invalid`, `bake-set-duplicate`, `bake-part-unknown`, `bake-part-shared` | errors in `describe()["bake"]` (nothing is baked; the GLB is still exported) |
| `bake-glb-images` | warning: the re-imported GLB has fewer images than the baked sets |
| `bake-sets`, `bake-skipped-draft` | notes: baked and reused counts with size and samples; a draft build did not bake |

`checks.bake` records `{ size, samples, skipped, sets: [{ id, partIds, hash, size, samples, reused, reusedFrom,
device, uvOverlap, unwrapped, skipped, images: [{ name, file, bytes, max }] }] }`; `max` is each image's brightest
byte.

### The `portos_model` kit

The driver puts a small PortOS-written kit (standard `bpy` only) on the import path, so `src/model.py` can
`from portos_model import …`:

- `mark_bake_only(obj, sets=None)`: mark detail geometry (above).
- `bolt_circle(name, radius, count, head_radius, head_height, location, sides=6)`, `hinge_barrel(name, length, radius,
  knuckles=3, gap, axis="Y", location)`, `pipe(name, points, radius, bend_radius=None, sides=16, location)` (a round
  pipe with rounded bends) and `lathe(name, profile, segments=32, location)` (a solid of revolution from
  `(radius, z)` points): each returns one mesh object.
- `edge_wear_group()`, `grime_group()`, `rust_group()`: shader node groups (Bevel and Ambient Occlusion based, so
  they need Cycles, which a bake uses), and `worn_metal_material(name, base_color, worn_color, edge_wear, grime,
  rust)`, a Principled material built from them. Use them only where they will be baked: a draft build exports a
  material with a linked procedural node as a flat one.

The starter (`py/starter/model.py`) shows the whole path: a bake-only bolt circle, a worn-metal set and a plain cloth
set. The kit lives in `server/services/blenderModels/py/portos_model/` (its package file is `package.py`: the worker
stages only file names that start with a letter or digit, so the driver registers it as `portos_model`).

## What a build checks

`report.json` holds the numbers and a list of findings. Each finding is `error`, `warning` or `note`; a build with any
error is kept and marked, and only a build without errors can be published.

| Check | Finding codes |
|---|---|
| describe() shape | `describe-missing`, `describe-size-invalid`, `describe-budget-invalid`, `parts-none`, `part-id-invalid`, `part-duplicate`, `part-parent-unknown` (errors); `parts-truncated` (warning) |
| Parts vs meshes | `part-missing`, `meshes-none` (errors); `mesh-undeclared`, `part-parent-mismatch`, `meshes-truncated` (warnings) |
| Size, per axis against `sizeMeters` | `bounds-oversized`, `bounds-undersized` (over 10%, errors); `bounds-drift` (2–10%), `review-out-of-frame` (warnings) |
| Triangles (modifiers applied) against `triangleBudget` | `triangles-over-budget` (error) |
| Transforms | `scale-negative` (error); `scale-unapplied` (warning) |
| Materials and images | `materials` (note with both counts) |
| Declared motion | `controls-invalid`, `actions-invalid`, `allow-contact-invalid`, `control-invalid`, `control-dependency-invalid`, `action-invalid`, `actions-without-controls` (errors); `allow-contact-unknown` (warning) |
| Each control and action | `control-not-rigged`, `control-clamp`, `control-mismatch`, `control-unreachable`, `action-failed`, `reimport-control` (errors); `action-dependency-unmet` (warning) |
| Sweep | `sweep-overlap` (error, one per pair of parts, with its `pose`), `sweep-overlap-more` (error); `sweep-unmeasured` (warning); `sweep-allowed-contact`, `sweep-rest-overlap` (notes) |
| Texture bake | see [Baking textures](#baking-textures) |
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
| `POST /api/blender-models/:id/builds/:buildId/bakes/:setId/cancel` | Cancel one set's bake (the build ends canceled) |
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
- `bakePlan.js` judges `describe()["bake"]` (pure), `bake.js` runs and reuses each set's bake job, and
  `py/portos_bake.py` (unwrap, overlap, hashing, Cycles bakes, the glTF materials) and `py/portos_model/` (the kit)
  run inside Blender.
- `references.js` holds the reference slots and review, `referenceImageHook.js` attaches finished renders, and
  `server/services/catalog/modelSheetPrompts.js` builds the prompts.
- `review.js` renders a build's review and reads its manifest, `reviewCameras.js` derives every camera (pure),
  `compare.js` holds cameras and differences, and `jobs.js` is the job list builds and reviews share.
- `py/portos_model_poses.py` plans the sweep (plain Python), `py/portos_model_motion.py` rigs, measures and re-checks in
  Blender, and `motion.js` turns their facts into `checks.motion` and findings. `client/src/lib/blenderModelPose.js` and
  `glbPose.js` pose the viewer. `__fixtures__/box_with_lid.py` is the fixture model; its events were recorded from
  Blender, and the GLB is `client/src/test/fixtures/box-with-lid.gltf.json`.
- `server/services/blenderWorkspace/` is shared with films: path containment, the `src/` tree, source hashing, the
  Trusted local gate and driver launch, the in-memory job registry and the per-job log.
