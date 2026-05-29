# Brain Links Redesign — Link Buckets (Bookmark Groups)

## Context

Today the Brain → Links tab (`client/src/components/brain/tabs/LinksTab.jsx`) is a single flat,
searchable/filterable list of link records. The user wants to use the desktop-mode space to organize
links into **arbitrary buckets** (bookmark groups) rendered as boards of clickable button-chips — e.g. a
"Reading list" bucket with quick-launch buttons for all your reading resources.

**Decided approach (from clarifying questions):**
1. **Data model** — reuse the existing brain `links` store; add optional `bucketId` + `bucketOrder` to link
   records. Buckets are a new lightweight collection (`{ id, name, color, icon, order }`). Single source of
   truth; any link (including GitHub repos) can be filed into a bucket.
2. **Layout** — bucket boards on top, the classic searchable/filterable list below.
3. **Button style** — each bucketed link renders as a compact **favicon + title chip** that opens in a new tab.

No new page/route (stays at `/brain/links`), so no `NAV_COMMANDS` change is needed.

## Data model changes

Add to the link record (additive, optional — no migration required, old records are simply "ungrouped"):
- `bucketId: string|null` (uuid of owning bucket; absent/null = ungrouped)
- `bucketOrder: number` (position within the bucket)

New `buckets` JSON entity store record:
```
bucket { id, name, color, icon, order, originInstanceId, createdAt, updatedAt }
```
- `color` — one of the port design tokens / a small preset palette
- `icon` — optional emoji or lucide icon name (default a generic folder)
- `order` — board position

## Server changes

### `server/services/brainStorage.js`
- Add `buckets: join(DATA_DIR, 'buckets.json')` to `FILES` and `buckets: { data: null, timestamp: 0 }` to `caches`.
- Add convenience exports mirroring links: `getBuckets / getBucketById / createBucket / updateBucket / deleteBucket`
  (delegating to the generic `create/update/remove/getAll/getById` helpers — these already emit events + append to the sync log).
- Add `'buckets'` to the `entityTypes` array in `backfillOriginInstanceId`.
- Add `buckets` count to `getSummary()` (optional, low priority).

### `server/services/brainSync.js`
- Add `'buckets'` to `ENTITY_TYPES` (line 16) so buckets federate across sync peers (per the distribution model in CLAUDE.md).

### `server/services/brain.js`
- Add delegation exports for the five bucket CRUD functions (mirrors existing `getLinks`/`createLink`/… block).

### `server/lib/brainValidation.js`
- Extend `linkRecordSchema`, `linkInputSchema`, and `linkUpdateInputSchema` with:
  `bucketId: z.string().uuid().nullable().optional()` and `bucketOrder: z.number().int().optional()`.
  (POST accepting `bucketId` lets "quick-add inside a bucket" be a single call.)
- Add new schemas: `bucketRecordSchema`, `bucketInputSchema` (`{ name, color?, icon? }`),
  `bucketUpdateInputSchema` (partial), and `bucketReorderSchema` (`{ ids: z.array(z.string().uuid()) }`).
- (File is already in the `server/lib` barrel/README — no barrel maintenance needed since no new file.)

### `server/routes/brain.js`
- New bucket routes (mirror the links CRUD block, all inputs validated):
  - `GET /api/brain/buckets` → buckets sorted by `order`.
  - `POST /api/brain/buckets` (`bucketInputSchema`) → assigns next `order`.
  - `PUT /api/brain/buckets/:id` (`bucketUpdateInputSchema`).
  - `DELETE /api/brain/buckets/:id` → also **unassign** its links (set `bucketId: null` on links where `bucketId === :id`) so links survive bucket deletion as ungrouped.
  - `POST /api/brain/buckets/reorder` (`bucketReorderSchema`) → persist new `order` per id in one call (avoids N races).
- Link assignment reuses existing `PUT /api/brain/links/:id` with `{ bucketId, bucketOrder }` (now schema-allowed).
- Minor enhancement to `POST /api/brain/links`: when not a GitHub repo and no title supplied, derive title from the URL hostname (strip `www.`) so quick-added chips read nicely instead of showing the full URL.

## Client changes

### API wrapper — `client/src/services/apiBrain.js`
Add (functions only; file already wired into the `api.js` barrel):
`getBrainBuckets`, `createBrainBucket`, `updateBrainBucket`, `deleteBrainBucket`, `reorderBrainBuckets`.
Add a `bucketId`/`bucketOrder` pass-through where links are created/updated.

### New components (one concern per file) under `client/src/components/brain/links/`
- `LinkChip.jsx` — favicon + title button. Favicon via `https://www.google.com/s2/favicons?domain=<hostname>&sz=64`
  with `onError` fallback to the lucide `Link2` icon. Click opens `url` in a new tab (`target="_blank" rel="noopener"`).
- `BucketCard.jsx` — one bucket: colored header (name + edit/delete menu), chip grid body, inline "+ add link"
  (paste URL → `createBrainLink({ url, bucketId })`), and inline edit (name/color/icon). Supports removing a chip
  from the bucket (set `bucketId: null`).
- `BucketBoard.jsx` — responsive grid of `BucketCard`s (multi-column desktop, single-column stack on mobile per
  the mobile-responsive convention) + a "+ New Bucket" affordance. Owns bucket list state with reactive updates
  (`setState(prev => …)` after mutations, no full refetch). Drag-to-reorder chips within/between buckets and
  buckets themselves via HTML5 DnD, persisting through `updateBrainLink`/`reorderBrainBuckets`.

### `client/src/components/brain/tabs/LinksTab.jsx`
- Render `<BucketBoard>` at the top, a divider, then the **existing** searchable/filterable list below (kept intact).
- Each list row gains a small "bucket" control: a badge if assigned + an "Add to bucket ▾" menu that calls
  `updateBrainLink(id, { bucketId })`. Add an optional **"Ungrouped"** entry alongside the existing
  All / GitHub / Other filter tabs.
- Keep the existing GitHub clone/scan/pull controls untouched on list rows.

## Persistence / compatibility

- `buckets.json` auto-creates lazily (`readJSONFile(..., { records: {} })`); the new link fields are additive and
  optional → **no migration script required**. Federation is covered by adding `buckets` to `ENTITY_TYPES`.
- Cross-machine sync payloads remain version-gated by the existing generic per-type sync path; buckets flow through
  the same `appendChange`/`applyRemoteRecord` machinery as other entities.

## Tests

- `server/lib/brainValidation.test.js` — bucket schema valid/invalid cases; link schema accepts `bucketId`/`bucketOrder`.
- `server/routes/brain.test.js` — bucket CRUD + reorder; deleting a bucket unassigns its links; hostname title derivation on plain-URL POST.
- `client` (vitest/jsdom) — `LinkChip` renders title + favicon with fallback; `BucketBoard` renders buckets and adds a link.
- Run `cd server && npm test` and `cd client && npm test`.

## Verification (end-to-end)

1. `npm run dev`, open `/brain/links`.
2. Create a "Reading list" bucket; quick-add several URLs → confirm favicon+title chips render and open in new tabs.
3. From the list below, file an existing link into a bucket via "Add to bucket"; confirm it appears as a chip and the list badge updates (no full reload fl/flicker).
4. Drag to reorder chips and buckets; reload to confirm persistence.
5. Delete a bucket; confirm its links survive as ungrouped in the list.
6. Use Playwright MCP (persistent `~/.browser` profile) to screenshot the board in desktop and mobile widths to confirm responsive stacking.
