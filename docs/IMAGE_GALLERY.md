# Image gallery reads

Legacy `GET /api/image-gen/gallery` returns the complete disk-derived array.
New consumers should request a page:

- Recent images: `GET /api/image-gen/gallery?limit=5`
- Search and paging: `GET /api/image-gen/gallery?limit=60&offset=60&q=fox`
- Exclude hidden images: add `hidden=false`.

Supplying a paging or filtering key selects the envelope
`{ items, total, limit, offset }`. The default limit is 60; allowed limits are
1–200. Offset is a nonnegative integer. Total counts all matching rows, including
when the requested offset is beyond the end. Items preserve their gallery metadata.

Production pages read the derived PostgreSQL `media_assets` index with SQL LIMIT
and OFFSET. Ordering is newest first with a stable media-key tie break. Search
matches all whitespace-separated tokens, case-insensitively, anywhere in the
metadata JSON (including prompt and filename); percent and underscore are literal.
This deliberately broadens the old curated-field search: metadata keys, timestamps,
and other stored fields can match too. Search scans metadata inside PostgreSQL;
paging bounds transfer and browser state, not the search scan itself.
No request scans sidecars to recover from a database error.

Sidecars remain authoritative. Boot reconcile scans disk and repairs index drift.
The file/test escape hatch filters and slices its small disk gallery. Generation
uses the existing completed-event upsert; uploads, variants, prompt and visibility
edits refresh that same index hook. Confirmed image deletion still unindexes.

The LoRA import dialog and Image Gen use this page contract. Image Gen requests
`limit=5&hidden=false&summary=true`; `summary=true` adds `hiddenTotal`, counting
hidden matches of the same search/favorite scope independently of the page's
`hidden` filter. Expanding hidden images loads 60 at a time. `starred=true`
filters against the local author's stars before LIMIT (a peer's star alone does
not qualify). `rating=good|bad` filters the same way against the local
author's good/bad rating (Media History's Good and Bad chips). Favorites and ratings consult the authoritative annotation map; that metadata
read remains proportional to the number of annotations, while image rows and
payloads stay bounded. Background render completions refresh only the recent
window and totals, preserving loaded hidden pages. Explicit gallery mutations
and retries restart hidden paging because they can shift offsets.
`filename=<exact filename>&limit=1` resolves an older deep-linked
preview without fetching intervening pages.

Media History and collection detail use the same endpoint with `media=true`
and `kind=all|image|video`. Items in this opt-in form are `{ kind, data }`,
where `data` remains the original gallery/history record. Images come from the
index; videos come from one authoritative video-history snapshot joined in SQL,
because video prompt/visibility edits and uploads do not all refresh that index.
Sorting and LIMIT happen after merging the two kinds. With `summary=true`,
`counts: { all, image, video }` counts the searched scope before kind/favorite
filters. A bare `filename` or video id resolves older previews outside the page.
Search additionally preserves dimension (`1024x768`), media-kind, and lineage
(`extracted frame`, `upscaled 2x`) tokens from the prior client-side search.

`collectionId` scopes membership before paging; `collectionId=unsorted` excludes
all filed media. Named collections retain newest-added ordering. `universeId`,
`entryCategory`, and `entryKind` are exact filters. The picker gets global options
from `GET /api/image-gen/gallery/facets`, so options never depend on the current
page or search. Collection-grid covers and full counts come from
`GET /api/image-gen/gallery/collections`; these reads share collection/video
snapshots and use at most four concurrent collection queries.

`POST /api/image-gen/gallery/lookup` accepts `{ filenames: [...] }` (up to 200)
and returns only those image records. Universe previews, pipeline license export,
bound Game artwork, and timeline source validation use this exact-reference
lookup. Game's Browse gallery control and the timeline/Catalog pickers page and
search instead of loading every image. Only the explicit legacy array API still
scans the whole gallery for backward compatibility.

Show more loads the next 60 rows. Search and scope changes reset the page;
failed next pages preserve the loaded cards and offer Retry. Explicit mutations
restart the first window to account for shifted offsets; collection bulk selection
says Select loaded while more pages remain. Deep-linked previews resolve directly.
Sidecar enrichment, recovered prompts, imported images, and peer asset arrivals
refresh the existing image-index hook after their authoritative writes.

## File sizes and recoverable deletion

Image and video gallery rows include `fileSizeBytes` when the original file can
be measured. Compact pages keep it, and the shared `MediaCard` displays it next
to resolution/FPS using `formatBytes`; the lightbox uses the same formatter.
The server measures only the selected page with bounded concurrency, so older
records need no backfill. Missing or unreadable files omit the field rather
than reporting a false zero. A measured empty file reports zero bytes.

Deleting gallery images or video-history entries moves their originals,
sidecars, thumbnails and video audio masters to the operating system's Trash
or Recycle Bin on the **PortOS server machine**. Video deletion also recycles
a `<filename>.metadata.json` snapshot of that video's history record, preserving
its prompt/settings without moving the shared history store. Temporary render
cleanup still permanently removes temporary files.

Recycling uses facilities the operating system already ships, with no
third-party package or bundled binary: on macOS each file is trashed in its
own `osascript` process so Finder keeps a *Put Back* record for every one; on
Linux files land in the freedesktop trash (`~/.local/share/Trash` or the
volume's `.Trash-<uid>`) under their original names, where `gio`, `trash-cli`
and desktop file managers can list and restore them; on Windows the Recycle
Bin is used through the shell, and a file the shell could not recycle — one
on a volume without a Recycle Bin (a network share or removable media), one
larger than that volume's Recycle Bin capacity, or any file when the Recycle
Bin is disabled for the volume — is refused and left in place rather than
permanently deleted.

Recycling errors fail the request; there is no permanent-delete fallback.
History and derived index rows are retired only after the file operation
confirms the files are gone. Native recycling can partially succeed, so after
a failure some files may already be in Trash; a retry processes remaining
files. Restore files using the host OS. Restoring a video file does not
automatically recreate its PortOS history entry or collection membership.
