# Blender Models

Open **Create → 3D**, then **New Blender model**. A model is a local Python workspace that Blender builds into a reusable GLB. Builds need the operator-checked Blender in **Trusted local** mode under **Code Animation → Production → Blender execution**. The script runs with host privileges. Use source you trust. PortOS requires operator authority for writes and keeps model records and assets local.

## Prepare a model

1. In **References**, start with a Casting object, gallery images, uploads or mood-board pins. Set the real size and choose the renderer.
2. Render or upload an overall sheet and approve it. Approved sheets enable mechanism close-ups. Replacing the approved sheet marks dependent plates out of date. Review the exact prompt and attached references before rendering.
3. Create the parts brief and use **Copy agent brief** to hand off the approved images and any open differences. For the source workflow, use the [Blender Model authoring skill](../../.claude/skills/portos-blender-model/SKILL.md).

## Build and compare

Use **Files** to edit and save `src/model.py` and supporting text. Put binary assets into the workspace on disk. Start with the provided workspace starter to see the expected `describe(ctx)` and `build(ctx)` functions. Declare size in meters, triangle budget and stable part IDs. Build Z-up, front facing −Y, centered on X/Y and resting at Z = 0. Match object names and parenting to the part declaration.

In **Model**, run a build and check its findings and part list. PortOS exports and re-imports the GLB to verify it. Use **Pose** to try declared controls and **Show pose** to inspect an overlap. In **Compare**, choose a reference, saved camera, textured or clay view and optional second build. Saved cameras frame the declared bounds. Re-render when a comparison is stale. Record differences and resolve them against a specific build. An accepted departure records the reason.

## Publish and reuse

Only a build without errors can be published. Building, canceling or failing a job leaves the published GLB in place. PortOS retains the published build, a running build and the newest five. **Builds** shows logs and review for kept builds. **Model** offers GLB and Blender downloads and **Open in Blender**.

**Make showcase film** opens an editable Code Animation project from the published build. It copies the GLB and available reference material. Start stills and cuts from the film when ready. See [Blender films](./music-video.md#blender-films) for the film workflow.

To export procedural surface detail, use the starter and authoring skill's bake contract. Bakes feed baked material maps into the GLB. Check the rendered comparison and build report before publishing.

The workspace is under `data/blender-models/<id>/`. Backups include `src/` and `builds/`. Comparison renders are regenerable. Deleting a model keeps its source directory and removes build and render outputs.
