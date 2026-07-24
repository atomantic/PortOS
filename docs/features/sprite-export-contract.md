# Sprite Export Contract

What actually crosses the boundary when PortOS publishes a compiled sprite atlas into a managed app's repository — and, just as importantly, what does not.

Publishing is the only sprite path that writes outside `data/`. Everything else (walk runs, trims, the compile manifest, previews) stays inside PortOS. So the contract below is the *entire* surface a consuming app can depend on.

## The atlas grid

The compiler (`server/services/sprites/atlas.js`) produces one PNG: a fixed-cell grid of `idle + N walk phases + scanner` columns × 8 direction rows.

| Property | Value |
|---|---|
| Cell size | 96 × 96 px (overridable per compile; the published geometry is whatever was compiled) |
| Pivot | `(48, 88)` — silhouette centered on x, feet on the y ground line |
| Rows | 8, in `directionOrder`: S, SE, E, NE, N, NW, W, SW |
| Columns | `idle` at 0, the N walk phases from 1, `scanner` last |
| N (walk frame count) | authorable, 6–16 (`walkBounds.js`); historically always 8 |

`N` is read from the approved run manifests — every direction in one atlas must share it — so the atlas width tracks the authored count. **That makes the column layout a moving target for anything that hardcodes it.**

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
  "rowOrder": ["S", "SE", "E", "NE", "N", "NW", "W", "SW"],
  "columns": ["idle", "left-contact", "…", "right-up", "scanner"],
  "columnCount": 10,
  "tracks": {
    "idle": { "start": 0, "count": 1 },
    "walk": { "start": 1, "count": 8 },
    "scanner": { "start": 9, "count": 1 }
  },
  "walkFrameCount": 8,
  "previewFps": 12,
  "previewFpsNote": "Authoring metadata only — …"
}
```

Consumer guidance:

- **Resolve columns by name, not by constant.** `tracks` gives each animation track a column span, so a walk of any length — and any future track (a four-frame scanner action, a three-frame ambient loop) — is additive rather than a breaking re-read. `columns` is the flat list for anything that wants raw names.
- **Verify before you trust.** `sourceAtlasSha256` identifies the atlas the layout describes. The sidecar is written *before* the PNG on each publish, so a partially-completed publish is detectable (hash mismatch) rather than silent.
- **The sidecar carries no timestamp** — identical geometry produces byte-identical content, so an unchanged republish rewrites nothing.
- The sidecar shares the PNG's per-repo write serialization and destination guards; an atlas whose sidecar was deleted gets it back on the next publish, and a file at that path PortOS didn't write (no `kind: portos-sprite-atlas-layout`) is never replaced without an explicit overwrite acknowledgment.

## Playback speed belongs to the consuming app

PortOS's walk **fps is preview-only.** It is real provenance for the trim GIFs and the in-PortOS preview, and it rides along in the sidecar as `previewFps` — explicitly labeled authoring metadata. It is not an instruction.

The reference consumer advances its walk cycle **per unit of distance travelled**, not per unit of time: frame index derives from movement distance over a cycle distance, scaled by move speed and terrain. Its effective playback rate is therefore continuous and emergent (roughly `speed ÷ distance-per-frame`), never a number PortOS chose. A 6 fps preview and a 24 fps preview produce **byte-identical exports**.

If your app *is* time-driven, pick its own frame rate. Do not read `previewFps` as one.

## Frame count is a coordinated cross-repo change

Column layout is the one thing an app genuinely has to agree with PortOS about. Changing `N` shifts every column after `idle` — a game that reads walk columns 1–8 out of a 14-column atlas renders the wrong phases *and* draws a walk frame where the scanner belongs. No crash, no log.

Two mechanisms guard that:

- **`publishBinding.runtimeContract`** (optional): `{ walkFrameCount, cellSize?, columnCount? }` — the grid the app was built against. Set it via `PUT /api/sprites/:id/publish-binding`. Publishing an atlas whose compiled geometry disagrees fails with a **409** naming both the actual and expected numbers and both resolutions (change the app's constant, or reprocess the walk set). A binding with no contract publishes unchecked, exactly as before the field existed.
- **The sidecar**, so an app that reads it can fail loudly on its own terms instead of relying on PortOS to have been asked.

`runtimeContract` follows absent-vs-null semantics: a saved binding that omits the key inherits the stored contract (the publish form doesn't edit it), while an explicit `null` clears it.

**A frame-count change is therefore a two-repo change.** Reprocess the walk set to the new count, update the app's frame-count constant *and* the distance/timing math derived from it, and update the contract — in whichever order, but neither half ships alone.

## Related code

| Path | Role |
|---|---|
| `server/services/sprites/atlas.js` | Compiles the atlas; owns `atlasColumns()` and the geometry block |
| `server/services/sprites/atlasLayout.js` | Builds the sidecar payload; compares geometry against a runtime contract |
| `server/services/sprites/publish.js` | Binding validation, the publish-time guard, the atomic PNG + sidecar write |
| `server/services/sprites/walkBounds.js` | The authorable frame-count / fps ranges |
