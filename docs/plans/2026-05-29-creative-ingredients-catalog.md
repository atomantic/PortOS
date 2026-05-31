# Creative Ingredients Catalog

## Context

Today, PortOS stores creative content in three siloed JSON shapes:

- **Universes** (`data/universes/{id}/index.json`) own their cast (characters), settings (places), and props (objects) as embedded arrays under `canon.*`.
- **Series + Issues** (`data/pipeline-series/`, `data/pipeline-issues/`) own a parallel embedded copy of those same shapes per series.
- **Writers Room works** (`data/writers-room/works/{id}/manifest.json`) own yet another parallel copy.

The story-bible sanitizer in `server/lib/storyBible.js` is shared, but the *records* are not — a character imagined for one universe cannot be reused in another without manual re-entry. Free-form creative material (one-line story sparks, scene snippets, rough drafts, lore notes) has no first-class home at all; it either gets pasted into a Writers Room draft (heavy), routed through the Importer (which expects screenplay shape), or lost.

This plan adds a **Creative Ingredients Catalog** — a single Postgres-backed store of typed, tagged, embeddable "ingredients" (Characters, Places, Objects, Ideas, Scenes, Concepts) that:

1. **Preserves raw input** — every paste is stored verbatim as a Scrap, never destructively edited by extraction.
2. **Extracts structured ingredients** from each Scrap via LLM, using the existing `storyBible.js` shapes for char/place/object so backfilled and freshly-ingested records are identical on the wire.
3. **Cross-references** with Universes / Series / Issues / Writers Room — both consumed (pick a character → attach to series) and produced (existing embedded canon is back-filled into the catalog, with bidirectional `ingredientId` linkage).
4. **Federates** between peer installs using the same `sync_sequence BIGSERIAL` + LWW pattern as `server/services/memorySync.js`.
5. **Searches** via Postgres tsvector FTS + pgvector cosine similarity (provider-agnostic embeddings via Ollama or LM Studio, configurable in PortOS settings).

Postgres + pgvector is already live (the memory system uses it). The catalog reuses every primitive — `query`, `withTransaction`, `arrayToPgvector`/`pgvectorToArray`, HNSW indexing, the `sync_sequence` federation pattern, and the `PORTOS_SCHEMA_VERSIONS` wire contract.

## Locked-in design decisions

1. **Backfill existing embedded characters** into the catalog (migration writes new rows + stamps `ingredientId` back onto the embedded records).
2. **Six ingredient types at launch**: `character`, `place`, `object` (reuse `storyBible.js` shapes verbatim) plus `idea`, `scene`, `concept` (new lightweight shapes).
3. **New dedicated Catalog page** under Create section — not an extension of Brain inbox or Importer.
4. **Provider-agnostic embeddings** auto-applied at ingest when configured. New `settings.embeddings = { provider: 'ollama' | 'lmstudio' | 'none', model }` in `data/settings.json`. Ollama is the user's default; `server/services/ollamaManager.js` needs a new `getEmbeddings()` mirroring the one already in `server/services/lmStudioManager.js:377`.
5. **Vector dim pinned to 768** for v1 (matches the existing `memories.embedding vector(768)` column and Ollama's `nomic-embed-text`). The embedding service validates output dim and surfaces a clear error on mismatch.

## Implementation phases

Each phase is shippable as one or more PRs. Phases 1–3 are backend-only (no user-visible change). Phase 6 lights the feature up for the user. Phase 7 rolls picker integration into existing pages one at a time.

### Phase 1 — Postgres schema + db.js helpers

**Files**
- `server/scripts/init-db.sql` — append catalog DDL (idempotent `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`). Reuses the existing pgvector + pgcrypto extensions already loaded for `memories`.
- `server/lib/db.js` — extend `ensureSchema()` with the same DDL so runtime upgrades work; extend `checkHealth()` to probe `catalog_ingredients`.

**Tables**

```sql
CREATE TABLE IF NOT EXISTS catalog_scraps (
  id TEXT PRIMARY KEY,                         -- 'cat-scrap-<uuid>'
  title TEXT,
  raw_text TEXT NOT NULL,
  source_kind VARCHAR(32) DEFAULT 'paste',     -- paste|brain-bridge|importer-handoff
  metadata JSONB DEFAULT '{}'::jsonb,
  embedding vector(768),
  embedding_model VARCHAR(100),
  origin_instance_id VARCHAR(36),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  sync_sequence BIGSERIAL
);
CREATE INDEX IF NOT EXISTS idx_catalog_scraps_embedding
  ON catalog_scraps USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64);
CREATE INDEX IF NOT EXISTS idx_catalog_scraps_fts
  ON catalog_scraps USING gin (to_tsvector('english', coalesce(title,'')||' '||raw_text));
CREATE INDEX IF NOT EXISTS idx_catalog_scraps_sync_seq ON catalog_scraps (sync_sequence);

CREATE TABLE IF NOT EXISTS catalog_ingredients (
  id TEXT PRIMARY KEY,                         -- 'cat-chr-<uuid>', 'cat-plc-<uuid>', etc.
  type VARCHAR(20) NOT NULL
    CHECK (type IN ('character','place','object','idea','scene','concept')),
  name TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,  -- storyBible shape for chr/plc/obj; lighter shape for idea/scene/concept
  tags TEXT[] DEFAULT '{}',
  embedding vector(768),
  embedding_model VARCHAR(100),
  search_tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name,'')), 'A') ||
    setweight(to_tsvector('english',
      coalesce(payload->>'description','') || ' ' ||
      coalesce(payload->>'notes','') || ' ' ||
      coalesce(payload->>'background','')
    ), 'B')
  ) STORED,
  origin_instance_id VARCHAR(36),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  sync_sequence BIGSERIAL
);
CREATE INDEX IF NOT EXISTS idx_catalog_ing_embedding
  ON catalog_ingredients USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64);
CREATE INDEX IF NOT EXISTS idx_catalog_ing_fts ON catalog_ingredients USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_catalog_ing_type ON catalog_ingredients (type);
CREATE INDEX IF NOT EXISTS idx_catalog_ing_tags ON catalog_ingredients USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_catalog_ing_sync_seq ON catalog_ingredients (sync_sequence);

CREATE TABLE IF NOT EXISTS catalog_ingredient_sources (
  ingredient_id TEXT NOT NULL REFERENCES catalog_ingredients(id) ON DELETE CASCADE,
  scrap_id TEXT NOT NULL REFERENCES catalog_scraps(id) ON DELETE CASCADE,
  span JSONB,                                  -- optional { start, end } in raw_text
  extracted_at TIMESTAMPTZ DEFAULT NOW(),
  sync_sequence BIGSERIAL,
  PRIMARY KEY (ingredient_id, scrap_id)
);

CREATE TABLE IF NOT EXISTS catalog_ingredient_refs (
  ingredient_id TEXT NOT NULL REFERENCES catalog_ingredients(id) ON DELETE CASCADE,
  ref_kind VARCHAR(32) NOT NULL,               -- 'universe'|'series'|'issue'|'work'|'creative-director'
  ref_id TEXT NOT NULL,
  role VARCHAR(64) NOT NULL,                   -- 'canon-character'|'canon-place'|'canon-object'|'cast'|'mentioned'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  sync_sequence BIGSERIAL,
  PRIMARY KEY (ingredient_id, ref_kind, ref_id, role)
);
CREATE INDEX IF NOT EXISTS idx_catalog_ing_refs_target ON catalog_ingredient_refs (ref_kind, ref_id);
```

A trigger function `update_catalog_ingredient_timestamp()` mirrors the existing `update_memory_timestamp()` in `init-db.sql:74` — skips the bump on no-content-change to keep sync quiet, respects explicit `updated_at` from the sync apply path.

### Phase 2 — Embedding service (provider-agnostic)

**Files**
- `server/services/ollamaManager.js` — add `getEmbeddings(text, options = {})` that POSTs `{ model, input: text }` to `/api/embed` (Ollama 0.2+) with a fallback to `/api/embeddings` for older versions. Return `{ success, embedding, model, dimensions }` matching the `lmStudioManager.getEmbeddings` contract at line 377.
- `server/services/embeddings.js` **NEW** — provider router:
  - `getEmbeddingsConfig()` — reads `data/settings.json` `embeddings` slice
  - `embedText(text)` — routes to `ollamaManager.getEmbeddings` / `lmStudioManager.getEmbeddings` / returns `{ skipped: true }` when provider is `'none'`. Validates dim === 768, errors on mismatch.
  - `embedBatch(texts, { concurrency = 4 })` — used for backfill + admin re-embed.
- `server/lib/validation.js` — add `settingsEmbeddingsSchema = z.object({ provider: z.enum(['ollama','lmstudio','none']), model: z.string().optional() })`. Wire into `PUT /api/settings` polymorphic-partial path in `server/routes/settings.js` per the convention.
- `client/src/pages/Settings.jsx` — new "Embeddings" section. Provider radio/dropdown, model dropdown populated from `/api/ollama/models` or `/api/lm-studio/models` on provider selection. Persist via existing `PUT /api/settings`.

### Phase 3 — Catalog DB + sync + routes (no UI)

**Files**
- `server/services/catalogDB.js` **NEW** — mirrors `server/services/memoryDB.js`. ID generation: `cat-${prefix}-${randomUUID()}` where prefix is `chr|plc|obj|idea|scn|cnc`.

  Signatures:
  ```
  createScrap({ title, rawText, sourceKind?, metadata?, embedding? }): Promise<Scrap>
  getScrap(id): Promise<Scrap | null>
  listScraps({ since?, limit = 50 }): Promise<{ items, nextOffset }>
  deleteScrap(id): Promise<void>

  createIngredient({ type, name, payload, tags?, embedding?, embeddingModel? }): Promise<Ingredient>
  updateIngredient(id, patch): Promise<Ingredient>
  listIngredients({ type?, tag?, query?, limit = 50, offset = 0, since? }): Promise<{ items, nextOffset }>
  searchIngredientsByEmbedding(vector, { type?, limit = 20, threshold = 0.5 }): Promise<Array<{ ingredient, score }>>
  searchIngredientsByText(query, { type?, limit = 20 }): Promise<Array<{ ingredient, rank }>>
  searchHybrid(query, opts): Promise<...>   // blends cosine + ts_rank_cd 60/40 when embedding available

  linkIngredientToSource(ingredientId, scrapId, span?): Promise<void>
  linkIngredientToRef(ingredientId, refKind, refId, role): Promise<void>
  unlinkIngredientFromRef(ingredientId, refKind, refId, role): Promise<void>
  listRefsForIngredient(ingredientId): Promise<Array<Ref>>
  listIngredientsForRef(refKind, refId): Promise<Array<{ ingredient, role }>>

  getNextSyncSequence(): Promise<string>
  getChangesSince(seq, limit = 100): Promise<{ scraps, ingredients, sources, refs, maxSequence, hasMore }>
  applyRemoteChanges(envelope): Promise<{ applied, skipped }>
  ```

- `server/services/catalogSync.js` **NEW** — mirrors `server/services/memorySync.js`. LWW on `updated_at`. Reads `portosMeta.schemaVersions.catalog` from incoming envelope and rejects ahead-mismatches via `compareSchemaVersions` from `server/lib/schemaVersions.js`.

- `server/lib/schemaVersions.js` — add `catalog: 1` to `PORTOS_SCHEMA_VERSIONS` (line 35). Add `'cat-ingredient': ['catalog']` and `'cat-scrap': ['catalog']` to `RECORD_KIND_SCHEMA_CATEGORIES` (line 81).

- `server/routes/catalog.js` **NEW** — routes per spec:
  ```
  POST   /api/catalog/scraps                       create + kick off extraction
  GET    /api/catalog/scraps
  GET    /api/catalog/scraps/:id
  POST   /api/catalog/scraps/:id/extract           re-run
  POST   /api/catalog/scraps/:id/commit            commit reviewed drafts
  DELETE /api/catalog/scraps/:id
  GET    /api/catalog/ingredients                  ?type=&tag=&q=&limit=
  GET    /api/catalog/ingredients/:id
  PATCH  /api/catalog/ingredients/:id
  DELETE /api/catalog/ingredients/:id
  POST   /api/catalog/ingredients/:id/link         { refKind, refId, role }
  DELETE /api/catalog/ingredients/:id/link
  GET    /api/catalog/sync?since=<seq>&limit=100
  POST   /api/catalog/sync/apply
  POST   /api/catalog/embeddings/backfill          admin: re-embed rows where embedding IS NULL
  ```

- `server/lib/catalogValidation.js` **NEW** — Zod schemas: `catalogScrapCreateSchema`, `catalogIngredientCreateSchema`, `catalogIngredientPatchSchema`, `catalogIngredientLinkSchema`, `catalogIngredientQuerySchema`, `catalogSyncEnvelopeSchema`. Char/place/object payload schemas import limits from `storyBible.BIBLE_LIMITS`.

- `server/lib/index.js` — barrel-export `catalogValidation` (the project's `server/lib/index.test.js` fails on missing barrel exports).

- `server/index.js` — wire `app.use('/api/catalog', catalogRoutes)` near the existing `/api/memory` route registration.

### Phase 4 — Backfill migration

**Files**
- `server/scripts/migrateBibleToCatalog.js` **NEW** — idempotent default export `migrateBibleToCatalog()`:
  - Walk every universe via `universeBuilder.listUniverses()` → for each entry in `universe.canon.characters[] / places[] / objects[]`: if `entry.ingredientId` already set, skip; else create catalog ingredient with `payload = entry` (full storyBible shape), `tags = ['canon','from-universe', universe.id]`, link via `linkIngredientToRef(ingId, 'universe', universe.id, 'canon-<type>')`, then mutate `entry.ingredientId = ingId` and write the universe back through `universeBuilder.saveUniverse` with a new `{ silent: true }` flag so peer-sync fan-out doesn't fire one record per ingredient during the migration window.
  - Same walk for `series.characters[] / places[] / objects[]` and Writers Room work bibles.
  - Records stats in `data/migrations.applied.json` under `bibleToCatalog: { version: 1, completedAt, stats: { ... } }`.
- `server/lib/storyBible.js` — extend the sanitizer to preserve `ingredientId: string | null` (max 64 chars) through round-trips on character/place/object entries. Add `INGREDIENT_ID_MAX: 64` to `BIBLE_LIMITS`.
- `server/services/universeBuilder.js` / `server/services/pipeline/series.js` / `server/services/writersRoom/local.js` — accept `{ silent: true }` save option that skips the post-save peer-sync trigger. Migration uses it; normal user edits leave it off.
- `server/index.js` — after `ensureSchema()`, invoke `migrateBibleToCatalog()` once. Wrap in try/catch with single-line `console.error('🪄 bible→catalog migration failed: ${err.message}')` per project convention; never crash boot.

### Phase 5 — Extraction service + ingest path

**Files**
- `server/services/catalogExtraction.js` **NEW** — `extractIngredients(rawText, { socketId?, hints?, signal? })`. Uses the AI toolkit LLM in JSON mode with a prompt that produces:
  ```
  { characters: [<storyBible shape>], places: [...], objects: [...],
    ideas: [{ name, summary, tags? }],
    scenes: [{ name, summary, povCharacter?, location?, fullText }],
    concepts: [{ name, summary, kind?: 'lore'|'magic'|'tech'|'faction'|'rule', tags? }] }
  ```
  Streams `catalog:extract:progress` socket frames matching the `importer:progress` shape from `server/services/importer.js`. Output is a **draft**, not committed — the route returns it for user review.
- `server/routes/catalog.js` (extension of phase 3) — `POST /api/catalog/scraps` persists the scrap immediately, returns `{ scrapId, draft }`. Extraction runs in the background and streams progress; the response payload includes the final draft once extraction is done (or the route returns immediately and the client polls/receives via socket — match `importer.js`'s pattern). `POST /api/catalog/scraps/:id/commit` accepts `{ accepted: [...drafts] }` and persists ingredients + calls `linkIngredientToSource(ingId, scrapId, span?)`.
- `server/services/embeddings.js` (from phase 2) — invoked synchronously inside `createIngredient` and `createScrap` when provider is configured, batched when none-configured-but-later-backfilled.

### Phase 6 — Catalog UI (feature goes live)

**Files**
- `client/src/pages/Catalog.jsx` **NEW** (`/catalog`) — list page modeled on `client/src/pages/Universes.jsx`:
  - Header + "Ingest" button (links to `/catalog/ingest`)
  - Type chip filter row (Character / Place / Object / Idea / Scene / Concept / All)
  - Debounced search bar (calls `/api/catalog/ingredients?q=`)
  - Card grid: name, type badge, tags, snippet, "appears in N records" back-reference count
  - Scrolling layout (NOT in `isFullWidth` — it's a list page per CLAUDE.md convention)
- `client/src/pages/CatalogIngest.jsx` **NEW** (`/catalog/ingest`) — modeled on `client/src/pages/Importer.jsx`:
  - Large textarea + optional title field
  - "Ingest" button → POST `/api/catalog/scraps`
  - Subscribe to `catalog:extract:progress` socket frames during extraction
  - Review screen: checkbox per drafted ingredient, inline-editable fields, "Commit Selected" button → POST `/api/catalog/scraps/:id/commit`
  - Full-width route (goes in `isFullWidth` list in `Layout.jsx`)
- `client/src/pages/CatalogIngredient.jsx` **NEW** (`/catalog/:type/:id`) — detail with:
  - Type-specific edit form (character form reuses field shape from `client/src/pages/UniverseBuilder.jsx`'s character editor)
  - Source scrap(s) panel — links back to the originating scraps
  - "Appears in" panel — chips linking to universes/series/issues/works that reference this ingredient (driven by `catalog_ingredient_refs`)
  - Full-width route
- `client/src/components/IngredientPicker.jsx` **NEW** — reusable modal/popover. Props: `{ open, onClose, onSelect, type?, multi, excludeIds, refKind?, refId? }`. Calls `/api/catalog/ingredients?type=&q=`. Used by phase 7 picker integrations.
- `server/lib/navManifest.js` — two new `NAV_COMMANDS` entries: `nav.create.catalog` (path `/catalog`, label "Catalog") and `nav.create.catalog-ingest` (path `/catalog/ingest`, label "Catalog Ingest"). Section `'Create'`. Aliases include `'catalog'`, `'ingredients'`, `'cast'`, `'ideas'`.
- `client/src/components/Layout.jsx` — sidebar Create section: add "Catalog" entry, alphabetically first under Create (before Importer).
- `client/src/App.jsx` — three new `<Route>`s. Add `/catalog/ingest` and `/catalog/:type/:id` to the `isFullWidth` list; `/catalog` stays scrolling.

### Phase 7 — Picker integration into existing pages

Each ships as its own PR.

- `client/src/pages/UniverseBuilder.jsx` — in the Characters / Places / Objects panels, add "Pick from Catalog" button next to "Add new". On selection: PATCH the universe with the embedded entry copied from the ingredient's `payload` (carries `ingredientId`), AND POST `/api/catalog/ingredients/:id/link` with `{ refKind: 'universe', refId, role: 'canon-character'|'canon-place'|'canon-object' }`.
- `client/src/pages/PipelineSeries.jsx` — same pattern, `refKind: 'series'`.
- `client/src/pages/WritersRoom.jsx` — work bible panel, `refKind: 'work'`.

The PATCH path on those three pages must also pass `ingredientId` through their respective sanitizers; this is already covered by the `storyBible.js` change in phase 4.

### Phase 8 — Federation wire-up

**Files**
- `server/services/syncOrchestrator.js` (or `server/services/sharing/peerSync.js` — verify which orchestrates memory sync) — register catalog as a new sync category alongside memory. Pull via `catalogSync.getChangesSince`, apply via `catalogSync.applyRemoteChanges`.
- Outbound envelopes include `portosMeta.schemaVersions.catalog = 1`.
- `client/src/pages/SyncView.jsx` (if it exists, else the relevant sharing/sync UI) — surface a catalog row with last-sync timestamp + delta count.

### Phase 9 — Story versioning around catalog refs (hybrid auto-scan + confirm)

**Files**
- `server/services/writersRoom/local.js` (or wherever draft versions are persisted) — when saving a draft version, accept `referencedIngredientIds: string[]`. Persist on the version record in the work manifest.
- `server/services/catalogExtraction.js` (extend) — `scanProseForIngredientRefs(text, { universeId?, seriesId?, workId? })`: substring-match catalog ingredient names scoped to refs linked to the given universe/series/work for speed. Returns suggested ingredient ids; caller (UI) confirms before persisting.
- `client/src/pages/WritersRoom.jsx` — on draft save, run scan + show suggestions; user confirms/adds/removes; persisted with the version.
- Per-version display: a chip list of referenced ingredients on the version history panel.

Defer to phase 9 explicitly — scope-out of v1 if extraction work runs long.

### Phase 10 — Tests

- `server/services/catalogDB.test.js` — CRUD + search round-trip. Bootstrap a test Postgres via the same pattern as `server/services/memoryDB.test.js` (verify the existing test setup at start of phase 10).
- `server/services/catalogExtraction.test.js` — mock `aiToolkit` LLM call, assert extraction output conforms to `catalogIngredientCreateSchema`.
- `server/lib/catalogValidation.test.js` — Zod boundary tests on each schema (max lengths, required fields, enum values).
- `server/services/catalogSync.test.js` — envelope round-trip, LWW on `updated_at`, schema-version gate rejection.
- `server/scripts/migrateBibleToCatalog.test.js` — idempotency (run twice → second is no-op), backfill correctness against fixture universes/series/works.
- `server/services/embeddings.test.js` — provider routing, 768-dim validation, `'none'` skip path.
- `client/src/pages/Catalog.test.jsx` — render + filter chips.
- `client/src/components/IngredientPicker.test.jsx` — single + multi select behavior.

## Critical files (reference map)

**Reused as-is:**
- `server/lib/db.js` — `query`, `withTransaction`, `arrayToPgvector`, `pgvectorToArray`
- `server/lib/storyBible.js` — payload shape for char/place/object; backfill source
- `server/services/memoryDB.js` — template for `catalogDB.js`
- `server/services/memorySync.js` — template for `catalogSync.js`
- `server/services/lmStudioManager.js:377` — template for `ollamaManager.getEmbeddings`
- `server/services/importer.js` + `client/src/pages/Importer.jsx` — UX template for streaming paste-and-extract
- `client/src/pages/Universes.jsx` + `client/src/pages/Pipeline.jsx` — list-page templates

**New files:**
- `server/services/catalogDB.js`
- `server/services/catalogSync.js`
- `server/services/catalogExtraction.js`
- `server/services/embeddings.js`
- `server/routes/catalog.js`
- `server/lib/catalogValidation.js`
- `server/scripts/migrateBibleToCatalog.js`
- `client/src/pages/Catalog.jsx`
- `client/src/pages/CatalogIngest.jsx`
- `client/src/pages/CatalogIngredient.jsx`
- `client/src/components/IngredientPicker.jsx`

**Modified:**
- `server/scripts/init-db.sql` (append DDL)
- `server/lib/db.js` (extend `ensureSchema`, `checkHealth`)
- `server/lib/schemaVersions.js` (add `catalog: 1`, `cat-ingredient` and `cat-scrap` record kinds)
- `server/lib/storyBible.js` (preserve `ingredientId` through sanitizer)
- `server/lib/validation.js` (`settingsEmbeddingsSchema`)
- `server/lib/index.js` (barrel-export `catalogValidation`)
- `server/services/ollamaManager.js` (add `getEmbeddings`)
- `server/services/universeBuilder.js`, `server/services/pipeline/series.js`, `server/services/writersRoom/local.js` (accept `{ silent }` save flag)
- `server/routes/settings.js` (accept embeddings slice)
- `server/index.js` (wire `/api/catalog` route + boot-time `migrateBibleToCatalog`)
- `server/lib/navManifest.js` (`nav.create.catalog`, `nav.create.catalog-ingest`)
- `client/src/components/Layout.jsx` (sidebar entry)
- `client/src/App.jsx` (routes + `isFullWidth` membership)
- `client/src/pages/Settings.jsx` (Embeddings section)
- `client/src/pages/UniverseBuilder.jsx`, `client/src/pages/PipelineSeries.jsx`, `client/src/pages/WritersRoom.jsx` (Pick from Catalog buttons — phase 7)

## Open decisions to confirm during implementation

1. **Backfill peer-sync behavior** — silent (bulk-mutate without per-record fan-out, sync flows on next normal cycle) vs. eager. **Recommend silent.** Implemented via the `{ silent: true }` save flag in phase 4.
2. **Cross-instance ingredient ID collisions** — text-PK UUIDs make true collisions vanishingly rare, but two peers ingesting the same source text simultaneously create distinct ingredient rows. **Recommend** a post-sync dedupe pass that finds rows with embedding cosine ≥ 0.95 + same `type` + same `name` and surfaces a merge suggestion in the catalog UI. Not automatic. Out of v1 scope, list as deferred work in `PLAN.md`.
3. **Scrap retention** — keep scraps forever as raw archive; user-initiated delete only. Documented in the Catalog page UI.

## Verification

1. **Boot smoke** — `npm start`. Watch logs for `✅ Database schema ensured`, `🪄 bible→catalog migration: <N> ingredients created (<M> skipped)`, no boot crash.
2. **DB shape** — `psql -h localhost -p 5561 -U portos -d portos -c '\dt catalog*'` — expect 4 tables. `\d catalog_ingredients` — confirm `embedding vector(768)`, `search_tsv` generated column, HNSW + GIN indexes present.
3. **Embeddings settings round-trip** — Settings → Embeddings → pick Ollama + `nomic-embed-text` → save → reload → values persist.
4. **Ingest happy path** — `/catalog/ingest` → paste a paragraph naming a character + a place → "Ingest" → progress streams → review shows extracted character + place → commit → both visible at `/catalog` filtered by type.
5. **Cross-reference** — open `/universes/<id>` → Characters panel → "Pick from Catalog" → select the catalog character → save → ingredient's "Appears in" panel now lists the universe.
6. **Backfill correctness** — `psql ... -c "SELECT type, COUNT(*) FROM catalog_ingredients GROUP BY type"` — counts should roughly match sum of embedded chars/places/objects across the 15 existing universes + series + works.
7. **Federation** — on a second instance, `GET /api/catalog/sync?since=0&limit=100` returns the envelope; `POST /api/catalog/sync/apply` on it inserts rows. Run twice — second is idempotent (LWW on `updated_at`).
8. **Semantic search** — `/catalog?q=brooding%20detective` — returns characters whose descriptions match semantically even if "detective" isn't in the name.
9. **Tests** — `cd server && npm test` (passes new catalog suites). `cd client && npm test` (passes new Catalog UI suites).
10. **Mobile responsive** — verify `/catalog` list + ingest textarea + detail page all render usable on a 375px-wide viewport (per CLAUDE.md convention).

## Approved-plan archival

When this plan is approved (per CLAUDE.md), copy this file to `docs/plans/2026-05-29-creative-ingredients-catalog.md` as a design record before implementation begins.
