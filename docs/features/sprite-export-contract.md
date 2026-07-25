# Sprite Export Contract

What actually crosses the boundary when PortOS publishes a compiled sprite atlas into a managed app's repository — and, just as importantly, what does not.

Publishing is the only sprite path that writes outside `data/`. Everything else (walk runs, trims, the compile manifest, previews) stays inside PortOS. So the contract below is the *entire* surface a consuming app can depend on.

## The atlas grid

The compiler (`server/services/sprites/atlas.js`) produces one PNG: a fixed-cell grid of `idle` plus one named span for every approved animation track, across 8 direction rows.

| Property | Value |
|---|---|
| Cell size | 96 × 96 px (overridable per compile; the published geometry is whatever was compiled) |
| Pivot | `(48, 88)` — silhouette centered on x, feet on the y ground line |
| Rows | 8, in `directionOrder`: `south`, `south-east`, `east`, `north-east`, `north`, `north-west`, `west`, `south-west` |
| Columns | `idle` at 0, then one contiguous span per approved animation track in registration order — walk begins at 1, scanner follows it when approved, and an ambient-only record has `idle` + its ambient span |
| N (walk frame count) | authorable, 6–16 (`animationTracks.js`); historically always 8 |

`N` is read from the approved run manifests — every direction of a track must share it — so the atlas width tracks the authored count. **That makes the column layout a moving target for anything that hardcodes it.**

Frame-count and fps uniformity is a **within-track** rule, never a between-track one: every facing of a given track shares a column span because the atlas is a rectangular grid, but two different tracks may legally differ in both length and speed. The shipped directional `scanner` action is four frames at 6fps by default beside the 6–16-frame walk; its source video is generated only by an explicit scanner action, then packed and approved through its own evidence chain. Each track's authoring range comes from its own row in `server/services/sprites/animationTracks.js`, and its column span is recorded in `geometry.tracks` and republished in the sidecar.

**Not every track has eight rows.** A track is *directional* (one row per facing — a character walk) or *non-directional* (one row, period — a tree moving in the wind, water, a flickering lamp, which have no facing at all). A non-directional track occupies **row 0** across its whole column span and leaves the remaining rows transparent. Its span says so: `rows: 1`. There is still exactly **one atlas per record** — a second image would double the publish and binding surface for no gain, and the transparent cells cost only file size, which PNG compresses to near nothing.

Non-walk tracks namespace their column labels with the track id (`scanner-00`, `scanner-01`, …). Walk keeps its historical labels — the named gait phases at 8 frames, positional `frame-NN` at any other length — so existing and imported atlases round-trip unchanged.

### Ambient worked example

A `place`, `object`, or legacy `props` record can carry the `ambient` track: 2–6 coherent frames from one explicitly requested image-to-video clip, defaulting to 3 at 4fps for PortOS preview. Its locked main reference supplies the `idle` cell; the approved loop occupies row 0 and leaves rows 1–7 transparent:

```json
{
  "columns": ["idle", "ambient-00", "ambient-01", "ambient-02"],
  "tracks": {
    "idle": { "start": 0, "count": 1, "rows": 1 },
    "ambient": { "start": 1, "count": 3, "rows": 1 }
  },
  "ambientFrameCount": 3
}
```

`previewFps` remains authoring metadata. A consuming app picks the ambient playback rate and always samples row 0; it must not infer a facing from the unused transparent rows.

> **Atlases compiled before #2986 carry one extra trailing `scanner` column** — a verbatim copy of the idle cell, from an early render, that no consumer ever sampled. The compiler no longer emits it (an action animation is its own named track, not a column appended to the walk cycle), so an 8-frame grid is 9 columns wide rather than 10. Reading side is unchanged: an imported or previously published atlas that still has the column keeps loading, and its sidecar still describes the `scanner` span it really has. Recompiling a set drops the column and produces a new atlas version; existing published atlases are untouched until republished.

## What crosses the publish boundary

Exactly two files land in the app repo:

1. **The atlas PNG**, atomically replaced at `publishBinding.atlasDestPath`. Refused when the destination diverged from the previous publish, or when it holds bytes PortOS never published and the overwrite wasn't acknowledged.
2. **A `<atlas-stem>.layout.json` sidecar** beside it, describing the grid that PNG actually is.

Optionally, a **code binding** verifies (or occurrence-count-guarded rewrites) a resource-path string in one game source file. Engine sidecars (e.g. Godot's `.png.import`) are the game repo's concern and are never touched.

Nothing else crosses. The compile manifest, the run provenance, the trims, and the record itself never leave `data/`.

### The layout sidecar

```json
{
  "schemaVersion": 1,
  "kind": "portos-sprite-atlas-layout",
  "characterId": "example-character",
  "atlasFile": "example-atlas.png",
  "atlasVersion": 4,
  "sourceAtlasSha256": "…",
  "cellSize": 96,
  "rows": 8,
  "rowOrder": ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"],
  "columns": ["idle", "left-contact", "…", "right-up", "scanner-00", "…", "scanner-03"],
  "columnCount": 13,
  "tracks": {
    "idle": { "start": 0, "count": 1, "rows": 8 },
    "walk": { "start": 1, "count": 8, "rows": 8 },
    "scanner": { "start": 9, "count": 4, "rows": 8 }
  },
  "walkFrameCount": 8,
  "scannerFrameCount": 4,
  "previewFps": 12,
  "previewFpsNote": "Authoring metadata only — …"
}
```

Consumer guidance:

- **Resolve columns by name, not by constant.** `tracks` gives each animation track a column span, so a walk of any length — and any additional track (a four-frame scanner action, a three-frame ambient loop) — is additive rather than a breaking re-read. A track that isn't in the grid simply isn't in `tracks`; don't assume one is present. `columns` is the flat list for anything that wants raw names.
- **`tracks` tiles `columns` exactly.** The spans are contiguous, non-overlapping, and sum to `columnCount` — so `cellSize × columnCount` is the PNG width and a span always addresses real pixels. A sidecar whose spans disagreed with its own column list is refused at publish rather than shipped.
- **Read `rows` before you index by facing.** A span's `rows` is how many of the atlas's rows that track actually occupies. `rows === rowCount` is the familiar case (one row per facing, indexed through `rowOrder`); **`rows: 1` means the track lives on row 0 only** and you should sample row 0 no matter which way anything is facing — the other rows of those columns are transparent. Every span carries the field; a sidecar written before it existed describes only directional tracks, so treating a missing `rows` as full height is correct.
- **Verify before you trust.** `sourceAtlasSha256` identifies the atlas the layout describes. The sidecar is written *before* the PNG on each publish, so a partially-completed publish is detectable (hash mismatch) rather than silent.
- **The sidecar carries no timestamp** — identical geometry produces byte-identical content, so an unchanged republish rewrites nothing.
- The sidecar shares the PNG's per-repo write serialization and its occupied-destination guard: an atlas whose sidecar was deleted gets it back on the next publish, and a file at that path PortOS didn't write (no `kind: portos-sprite-atlas-layout`, or not valid JSON at all) is never replaced without an explicit overwrite acknowledgment. It has no *divergence* guard — unlike the PNG, a PortOS-written sidecar someone hand-edited is simply regenerated, since it is derived data.

## Playback speed belongs to the consuming app

PortOS's walk **fps is preview-only.** It is real provenance for the trim GIFs and the in-PortOS preview, and it rides along in the sidecar as `previewFps` — explicitly labeled authoring metadata. It is not an instruction.

The reference consumer advances its walk cycle **per unit of distance travelled**, not per unit of time: frame index derives from movement distance over a cycle distance, scaled by move speed and terrain. Its effective playback rate is therefore continuous and emergent (roughly `speed ÷ distance-per-frame`), never a number PortOS chose. A 6 fps preview and a 24 fps preview produce **byte-identical exports**.

If your app *is* time-driven, pick its own frame rate. Do not read `previewFps` as one.

## Frame count is a coordinated cross-repo change

Column layout is the one thing an app genuinely has to agree with PortOS about. Changing `N` shifts every column after `idle` — a game that reads walk columns 1–8 out of a 13-column atlas renders the wrong phases. And an app built against the pre-#2986 10-column grid that still reads column 9 as `scanner` now samples off the right edge of a recompiled 9-column atlas. No crash, no log.

Two mechanisms guard that:

- **`publishBinding.runtimeContract`** (optional): `{ walkFrameCount?, scannerFrameCount?, ambientFrameCount?, cellSize?, columnCount? }` — the grid the app was built against. A contract names either `walkFrameCount` or `ambientFrameCount` (and may include the other spans); set it from the **Runtime contract** group in the publish binding form or via `PUT /api/sprites/:id/publish-binding` directly. Publishing an atlas whose compiled geometry disagrees fails with a **409** naming both the actual and expected numbers and both resolutions (change the app's constant, or reprocess the relevant set). A binding with no contract publishes unchecked, exactly as before the field existed.
- **The sidecar**, so an app that reads it can fail loudly on its own terms instead of relying on PortOS to have been asked.

`runtimeContract` follows absent-vs-null semantics: a saved binding that omits the key inherits the stored contract (saving the form with the contract group untouched omits it, so the stored contract survives an unrelated edit), while an explicit `null` — what the form's "Clear" sends — clears it. The inheritance is scoped to the same `appId` — re-pointing a character at a different app drops the old app's contract rather than holding the new one to it.

**A frame-count change is therefore a two-repo change.** Reprocess the walk set to the new count, update the app's frame-count constant *and* the distance/timing math derived from it, and update the contract — in whichever order, but neither half ships alone.

## Related code

| Path | Role |
|---|---|
| `server/services/sprites/atlas.js` | Compiles the atlas; owns the geometry block and the pre-pixel up-to-date check |
| `server/services/sprites/atlasGrid.js` | The grid itself: column spans and row spans per track, within-track uniformity, reading a persisted (or legacy) grid back |
| `server/services/sprites/animationTracks.js` | One row per animation track — its bounds, defaults, directionality, and which record kinds may carry it |
| `server/services/sprites/reference.js` | The two animation gates: `requireCharacter` (walk workflow) and `requireAnimatable` (compile/publish) |
| `server/services/sprites/atlasLayout.js` | Builds the sidecar payload; compares geometry against a runtime contract |
| `server/services/sprites/publish.js` | Binding validation, the publish-time guard, the atomic PNG + sidecar write |
| `server/services/sprites/walkBounds.js` | The authorable frame-count / fps ranges |
