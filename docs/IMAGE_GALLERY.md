# Image gallery reads

Legacy `GET /api/image-gen/gallery` returns the complete disk-derived array.
New consumers should request a page:

- Recent images: `GET /api/image-gen/gallery?limit=5`
- Search and paging: `GET /api/image-gen/gallery?limit=60&offset=60&q=fox`
- Exclude hidden images: add `hidden=false`.

Supplying any of `limit`, `offset`, `q`, `hidden`, `starred`, `summary`, or `filename` selects the envelope
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
not qualify). `filename=<exact filename>&limit=1` resolves an older deep-linked
preview without fetching intervening pages.

Media History and the other legacy consumers have not yet migrated. Their global scopes, favorites,
counts, collection membership, and deep-linked previews must remain correct when
they migrate; limiting their old arrays without moving filters to the server is
not sufficient.
