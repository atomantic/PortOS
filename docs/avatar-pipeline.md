# Rigged 3D Avatar — Setup Guide

PortOS's **Chief of Staff → Stage** view (and the `Rigged Character (3D)` avatar style in the CoS header) renders a user-supplied rigged-and-animated GLB file. PortOS does not ship a default model — you provide one.

## TL;DR

1. Put a rigged `.glb` with the required animation clips at `./data/avatar/model.glb` on the server.
2. Restart PortOS (or just reload the browser — the server picks up new files without restart).
3. Choose **Rigged Character (3D)** in CoS → Config → Avatar Style, and/or visit **Chief of Staff → Stage**.

If `./data/avatar/model.glb` is missing, the Stage view shows a help panel and the header avatar falls back to whichever style was previously selected.

---

## The clip-name contract

PortOS switches body animations based on the Chief-of-Staff agent state. Your GLB must include animation tracks with these exact names:

| Clip name       | Plays when the CoS agent is…                     | Required |
|-----------------|--------------------------------------------------|----------|
| `base`          | default / fallback idle                          | **yes**  |
| `sleeping`      | idle, no active tasks                            | optional |
| `thinking`      | evaluating or reasoning                          | optional |
| `coding`        | actively running an agent / writing code         | optional |
| `investigating` | running diagnostics, looking at logs             | optional |
| `reviewing`     | reading or reviewing output                      | optional |
| `planning`      | planning next steps                              | optional |
| `ideating`      | brainstorming / option analysis                  | optional |

Only `base` is strictly required. Any missing clip falls back to `base`.

---

## Optional shape keys (unlock richer behavior)

If your GLB is a CC3+/ARKit-style character with blendshapes, PortOS's runtime detects these automatically and layers extra behavior on top of the body animation:

- **Visemes** — `V_Open`, `V_Lip_Open`, `V_Explosive`, `V_Dental_Lip`, `V_Tight_O`, `V_Tight`, `V_Wide`, `V_Affricate` → real mouth movement when the CoS is speaking.
- **Blinks** — `Eye_Blink_L`, `Eye_Blink_R` → periodic blinks.
- **Eye look** — `Eye_L_Look_L/R/Up/Down`, `Eye_R_Look_L/R/Up/Down` → subtle saccades.
- **Brows** — `Brow_Raise_Inner_L/R`, `Brow_Raise_Outer_L/R`, `Brow_Compress_L/R`, `Brow_Drop_L/R` → per-state expressions.
- **Mouth** — `Mouth_Smile_L/R`, `Mouth_Frown_L/R` → per-state expressions.

None of these are required. A rig-only model still works — it just won't blink or change expression.

---

## Where to get a model

You supply your own. Examples of sources:

- **Reallusion ActorCore** (https://actorcore.reallusion.com) — characters + motion library. Full CC3+ facial rig included on most characters.
- **CGTrader / Sketchfab** — search for "rigged" + "animated". Many static meshes are mis-tagged as rigged, so verify before buying.
- **Your own Character Creator export** if you're already in the Reallusion ecosystem.

**Worked example**: The free [Amber](https://www.cgtrader.com/free-3d-models/character/woman/amber-free-high-poly-3d-model) model on CGTrader is a full CC3+ character with a rigged skeleton and facial blendshapes. Download, follow the reduction steps below, and drop the resulting GLB into `./data/avatar/model.glb`.

> **License disclaimer**: You are responsible for the license of any model you ship or use with PortOS. "Free to download" is not the same as "free to redistribute". PortOS never ships, commits, or redistributes any user-supplied model — your copy stays local.

---

## If your mesh is unrigged

Start with an auto-rigger:

- **AccuRIG 2** (free, desktop, Reallusion) — https://actorcore.reallusion.com/auto-rig. Produces CC3+-compatible rigs. Recommended if you plan to use CC3+ animations or already have ActorCore characters.
- **Mesh2Motion** (free, open source, web-based) — https://mesh2motion.org/. Closest substitute for the defunct Mixamo workflow.
- **Blender Rigify** (free, built into Blender) — most manual work but entirely offline.

---

## Blender reduction + export pipeline

Once you have a rigged FBX/GLB with named animation tracks:

1. **Open in Blender** — File → Import → FBX, or File → Open if it's a `.blend`.
2. **Rename actions to match the clip-name contract** — Open the Action Editor (top-left dropdown in the Dope Sheet). Rename each action to `base`, `sleeping`, `thinking`, etc. Exact names, case-sensitive.
3. **Reduce textures** (optional but recommended for web):
   - Select every image texture → in the Image Properties, use Blender's built-in resize (N panel → Image → Resize) to drop 4k textures to 1k.
   - For PBR-heavy characters, aim to keep the total texture budget under ~20 MB.
4. **Export GLB**:
   - File → Export → **glTF 2.0 (.glb/.gltf)**
   - Format: **glTF Binary (.glb)**
   - Include: **Animations ✓**, **Shape Keys ✓** (if the model has blendshapes)
   - Compression: enable **Draco** for smaller mesh data
   - Target ≤ 30 MB total. Larger files will load but delay first render.
5. **Copy the result** to the PortOS server at `./data/avatar/model.glb`.

---

## Verifying

After dropping the GLB in place:

- Hit `HEAD /api/avatar/model.glb` — should return 200 with `Content-Type: model/gltf-binary`. Returns 404 if the file isn't present.
- Visit `/cos/stage` — the Stage view loads the model, and a small badge in the bottom-left lists the detected capabilities (`rigged · N clips · visemes · blinks · eye-tracking · expressions · cc3`).
- Set CoS → Config → Avatar Style to **Rigged Character (3D)** to use the rigged avatar in the header too.
