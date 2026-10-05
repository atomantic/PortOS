# Music Video making-of export

Music Video → Review & Export → Making-of export compiles a local planning ZIP
from up to eight projects. This supports combining a blueprint with its video
variant and reusing the workflow for later productions. It does not create a
GitHub repository, push, publish, acquire credentials, render media or edit projects.

Choose projects, select exact development-artifact versions and generated image
slots, enter rights/attribution declarations, then **Preview inventory**. No asset
bytes are selected by default. **Download planning ZIP** becomes available after
the preview. Changing selection or credits invalidates it. The server binds the
download to a digest of the preview's content and inventory; changed project data,
file bytes or availability returns `409 MAKING_OF_CHANGED` and requires a new preview.

## Package contract

The ZIP uses stable project/artifact/scene IDs and relative paths:

```text
README.md
manifest.json
SHA256SUMS
projects/<project-id>/
  planning.json
  shots.json
  shots.csv
  cast-set-sheet.md
  storyboard.md
  artifacts/<artifact-id>/v<version>.md|json|png|jpg|webp
  artifacts/<artifact-id>/v<version>-storyboard.csv|md
  artifacts/<artifact-id>/v<version>-visuals/visual-<ordinal>-<source-hash>.png
  images/cast-<slot>.png|jpg|webp
  images/frame-<scene-id>.png|jpg|webp
```

Planning preserves the current scene board separately from the editable timed
storyboard, project lineage, cue IDs and word timing, full cast/set direction,
prompts, selected settings, recorded generation settings, alignment basis,
readiness and revision-bound approval truth. A missing recorded master content hash
is reported as `not-recorded`; an alignment checksum is not claimed to be a hash
of the audio bytes. This exporter does not read audio to invent a content hash.

Select the **Original planning import** artifact when richer authored planning
exists. Its JSON structure is preserved with privacy redactions instead of being
projected down to the editable importer's fields. Its authored storyboard also
gets a CSV with all original columns and a Markdown companion. This retains
purpose, holds, treatments, cast/set IDs, overlays, word anchors, prompt negatives,
provider constraints and benchmark notes when present in that source. Original
planning is unverified evidence and never supplies live approval authority.

The inventory records every candidate as included, partial, missing, excluded or
not selected, with per-item reasons, transformations, selected versions, rights,
attribution, provenance and checksums. Selected HTML sheets retain source-ordered
graphics and captions in Markdown with relative PNG links. This preserves their
visual content without reproducing the complete HTML layout pixel for pixel.
Validated static SVG previews are rasterized; embedded raster plates require the
explicit **I own this file and its embedded raster graphics** declaration with
rights set to Owned. Unsafe or unavailable graphics stay visibly omitted, with
individual inventory entries; the sheet is marked partial.

Visual-spec references start unselected. Shared generated images are admitted
when their owning project is explicitly selected and retained job evidence matches.
Shared artifact versions require an exact immutable version in the selected
owner's record. Imported user-owned artifacts/gallery images can be admitted with
the explicit Owned declaration; this is operator evidence, not independent
verification or publication clearance. Unknown ownership remains excluded as
`ownership-unverified`. Original-planning asset records remain metadata only.
Selectable historical versions are artifact versions; a selected project's
planning is its current snapshot.

Identical inputs on the same image-library runtime produce identical archive
bytes: entry order is sorted, ZIP timestamps fixed, and no export-time clock is
inserted. `SHA256SUMS` covers every file except itself. After unpacking, verify with
`shasum -a 256 -c SHA256SUMS` (or another SHA-256 checker).

## Boundaries

- Metadata uses bounded projections; raw project records, logs, provider config,
  credentials and execution settings are not copied. URLs, recognizable credentials,
  private hosts and absolute paths in creative prose are redacted. Original JSON
  drops secret/private transport and embedded binary fields. Review content before
  sharing; a local export is not a public-content clearance decision.
- Artifact reads must match a selected project's exact immutable file path.
  Shared gallery images require a retained image job with the matching project,
  slot/scene and output filename. Cloned pointers without a selected verified
  owner remain excluded. Declarations cannot bypass path/type boundaries.
- Allowed file types are PNG/JPEG/WebP and safe conversions of Markdown/HTML.
  Raster output is decoded/re-encoded with EXIF orientation applied to pixels
  before metadata is stripped. Inline SVG uses a strict static geometry/text/gradient
  allowlist and bounded viewBox; rejected SVG never
  reaches the rasterizer. Scripts, remote resources, canvas, entities, links and
  active SVG features are omitted without execution or network access. Raw SVG,
  executable source, audio/video, arbitrary paths, symlinks, hard links and special
  files are excluded.
- CSS graphics and external stylesheet dependencies are recorded as visible
  omissions with partial sheet status; CSS resources are never loaded. Image
  captions are normalized to one line and escaped before Markdown insertion.
- Each file is bounded to 20 MiB, the package to 100 MiB, each project to 300
  candidates and each request to eight projects. A sheet allows 80 graphic/resource
  elements, 5 MiB per decoded image, 512 KiB per SVG, and 20 MiB each for cumulative
  decoded inputs and PNG outputs. SVG outputs are at most 1,600 pixels per side;
  raster input is limited to 40 million pixels. Reads use checked file handles.
- Rights start as unknown; an owned/licensed declaration is recorded as a
  declaration, not independently verified. No license is inferred. A public repo
  requires separate explicit content, owner, name and visibility approval.

API: `GET /api/music-video/:id/making-of/catalog`,
`POST /api/music-video/making-of/preview`, and
`POST /api/music-video/making-of/export`. POST bodies use the strict
`musicVideoMakingOfSelectionSchema`; export additionally requires the returned
`previewDigest`. No API accepts a filesystem path or shell command.

## Follow-up boundaries

An eventual GitHub publishing feature needs a supported authenticated integration,
an explicit destination/content review and truthful publication status. None is
implemented here. Layout-faithful full-page rendering, video/audio packaging,
external-resource fetching and historical whole-project snapshots are also
outside this initial exporter.

The current production-planning importer projects rich shot objects down to
action/staging/camera/transition. Binding an editable action into a Board scene
also crosses a 4,000-character action limit into a 2,000-character visual-intent
limit. A focused validation/field-contract follow-up should address that boundary;
this change preserves selected source planning rather than altering authoring.

Validation: synthetic Express-route tests cover determinism/checksums, exact
versions, richer source retention, two variants, missing planning, ownership,
private-content redaction, symlinks, size bounds, stale previews, a native
photographic cast sheet, a native SVG character sheet, 26 ordered storyboard
graphics, partial unsafe-resource exclusions and selected shared owners. Component
tests cover explicit selection, rights/credits, inventory-before-download and
superseded project responses. No live project data is used.
