# Stack Research

**Domain:** Personal OS -- JSON backup, Apple Health ingestion, unified search, cross-domain insights, route cleanup
**Researched:** 2026-02-26
**Confidence:** HIGH (versions verified via npm registry; patterns verified against existing codebase)

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Node.js `child_process.execFile` | built-in | Invoke `rsync` for incremental backup | rsync is the gold standard for incremental file sync. Using execFile (not exec) avoids shell injection. Already a pattern in PortOS (shell.js uses child_process). No npm wrapper needed -- the `rsync` npm package (0.6.1) is unmaintained since 2014 and just shells out anyway. |
| `fast-xml-parser` | ^5.4.1 | Parse Apple Health XML exports | Zero-dependency, fastest pure-JS XML parser. Handles 500MB+ Apple Health exports via streaming mode (v5 added SAX-like event API). xml2js is slower, heavier, and hasn't had a major release since 2023. sax/saxes are lower-level and require manual tree building. |
| `cmdk` | ^1.1.1 | Cmd+K command palette overlay | Purpose-built for exactly this pattern. Built on Radix primitives (Dialog, Compose Refs). 4 deps, 82KB unpacked. React 18 compatible. Used by Vercel, Linear, Raycast web. The alternative (building from scratch with @radix-ui/react-dialog + custom input) takes 3x longer for the same result. |
| `fuse.js` | ^7.1.0 | Client-side fuzzy search for Cmd+K | Zero-dependency, 456KB unpacked, works in browser. Handles typo-tolerant matching across heterogeneous data (app names, brain items, health metrics). Already proven in the fuzzy-search category -- most downloaded client-side search library on npm. |
| `tinykeys` | ^3.0.0 | Global keyboard shortcut binding | 650 bytes, zero dependencies. Binds Cmd+K globally without conflicting with input fields. The alternative (hotkeys-js at 4.0.2) is 10x larger and has a jQuery-era API. mousetrap (1.6.5) is unmaintained since 2020. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `chokidar` | ^5.0.0 | Watch `data/` directory for changes to trigger backup | Only needed if implementing "backup on change" mode. For scheduled-only backup, use the existing eventScheduler.js. v5 is a complete rewrite -- ESM-native, no binary deps. |
| `fflate` | ^0.8.2 | Compress backup snapshots | **Already in the project.** Use for optional gzip of JSON snapshots before rsync. Faster than Node's built-in zlib for single-file operations. |
| `saxes` | ^6.0.0 | Streaming XML parser (fallback) | Only if fast-xml-parser v5 SAX mode proves insufficient for edge cases. saxes is a maintained fork of sax with better spec compliance. Not needed unless fast-xml-parser fails on malformed Apple Health XML. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| Sample Apple Health XML | Test data for M44 P7 | Generate a minimal `export.xml` with `<HealthData>`, `<Record>`, `<Workout>`, `<ActivitySummary>` elements. Real exports are 200MB-2GB; test with 1000 records. |
| `vitest` (existing) | Test backup/restore, XML parsing, search index | Already in project at ^4.0.16. Add test cases for each new service. |

## Feature-Specific Stack Decisions

### M45: Data Backup & Recovery

**Strategy:** `rsync` via `child_process.execFile` with the existing `eventScheduler.js` for scheduling.

**Why rsync:**
- Incremental by default (only copies changed bytes via delta algorithm)
- Handles the `data/` directory tree (nested JSON, screenshots, uploads) without custom logic
- Already installed on macOS (ships with the OS)
- `--link-dest` flag enables space-efficient historical snapshots (hardlinks to unchanged files)
- `--exclude` patterns for temp files, locks, etc.

**Why NOT a JS backup library:**
- No maintained Node.js backup library exists that rivals rsync's capabilities
- `archiver` (npm) creates full archives, not incremental
- Custom JS file-diff would be slower and buggier than rsync's battle-tested C implementation
- `node-rsync` npm package is abandoned; just call rsync directly

**Scheduling:** Use the existing `eventScheduler.js` cron system (already handles cron expressions and timeout-safe timers). No need for `node-cron` or `node-schedule` -- PortOS already has this solved.

**Backup manifest:** Write a `backup-manifest.json` alongside each backup with timestamp, file count, byte count, and duration for the restore UI to read.

### M44 P7: Apple Health Data Ingestion

**Two ingest paths:**

1. **Health Auto Export app (JSON)** -- The app POSTs JSON via webhook or the user uploads exported JSON files. Structure:
   ```json
   {
     "data": {
       "metrics": [{ "name": "...", "units": "...", "data": [{ "date": "...", "qty": ... }] }],
       "workouts": [{ "name": "...", "duration": ..., "energyBurned": ... }],
       "stateOfMind": [...],
       "medications": [...],
       "symptoms": [...]
     }
   }
   ```
   Parse with plain `JSON.parse()` -- no library needed. Validate with Zod schemas.

2. **Apple Health XML export** -- User exports from iPhone Health app, produces `export.xml` (200MB-2GB). Structure:
   ```xml
   <HealthData locale="en_US">
     <ExportDate value="2026-01-01"/>
     <Me HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexMale" .../>
     <Record type="HKQuantityTypeIdentifierStepCount" value="1234" startDate="..." endDate="..." sourceName="iPhone"/>
     <Record type="HKQuantityTypeIdentifierHeartRate" value="72" .../>
     <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30.5" .../>
     <ActivitySummary dateComponents="2026-01-01" activeEnergyBurned="500" .../>
   </HealthData>
   ```
   **Must use streaming** -- loading 2GB into memory will crash. `fast-xml-parser` v5 supports SAX-style event parsing. Process `<Record>` elements one at a time, aggregate by type, write to `data/meatspace/apple-health/` as categorized JSON files.

**Why fast-xml-parser over alternatives:**
- `xml2js`: DOM-based, loads entire file into memory. Will OOM on 2GB Apple Health exports.
- `sax`: Works but unmaintained (last release 2024, no ESM support). Lower-level API requires manual tree construction.
- `saxes`: Good alternative but fast-xml-parser v5 covers both DOM and SAX modes in one package.
- `htmlparser2`: Designed for HTML, not strict XML. Overkill and wrong tool.

### M46: Unified Search (Cmd+K)

**Architecture:** Client-side search overlay backed by a server search API.

**Client-side:**
- `cmdk` for the overlay UI (dialog, input, result list, keyboard navigation)
- `tinykeys` to bind Cmd+K globally (register in Layout.jsx, unregister on unmount)
- `fuse.js` for instant client-side fuzzy matching of recently fetched results + static items (page navigation, quick actions)

**Server-side:**
- New `GET /api/search?q=...&sources=...` endpoint
- Fans out to existing services in parallel:
  - Brain: query `brainStorage.js` (ideas, projects, people, admin)
  - Memory: use existing `searchBM25()` from `memoryBM25.js`
  - Apps: filter `apps.json` by name/description
  - History: filter `history.json` by command
  - Health: search meatspace data by metric name/date
  - Agents: filter agent configs by name/description
  - Digital Twin: search document titles/content
- Each source returns `{ id, title, subtitle, type, url }` for uniform rendering
- Response within 200ms target (all sources searched in parallel via `Promise.all`)

**Why cmdk over building from scratch:**
- Keyboard navigation (up/down/enter/escape) is non-trivial to get right for a11y
- cmdk handles focus management, scroll-into-view, empty states, loading states
- Radix Dialog underneath provides proper portal, focus trap, scroll lock
- 82KB unpacked is negligible for the functionality delivered

**Why NOT MiniSearch on the server:**
- PortOS already has BM25 search (`lib/bm25.js`) and vector search (`memoryEmbeddings.js`). Adding MiniSearch would create a third search engine for no benefit.
- The server search API should delegate to existing search implementations per source, not build a new unified index.

**Why fuse.js on the client (not server):**
- Client-side fuzzy matching provides instant results for navigation items and recently viewed data while server search is in-flight
- Fuse.js handles heterogeneous result types (different field structures) with configurable keys
- Zero latency for "go to page" type searches

### M42 P5: Cross-Insights Engine

**No new libraries needed.** This is a data correlation service that reads from existing JSON stores and produces derived insights.

**Pattern:** A new `server/services/crossInsights.js` that:
1. Reads genome markers from `data/digital-twin/genome.json` (savedMarkers)
2. Reads health data from meatspace (blood, body, epigenetic, lifestyle)
3. Reads taste profile from digital-twin
4. Reads personality data from digital-twin
5. Applies rule-based correlations (e.g., MTHFR genotype + folate blood levels)
6. Caches results in `data/digital-twin/cross-insights.json`
7. Refreshes when source data changes (listen to file writes or service events)

**Why rule-based over ML:**
- The correlations are well-documented in medical literature (e.g., APOE4 + cholesterol, MTHFR + homocysteine)
- The user has a single genome -- not a dataset to train on
- Rules are transparent, auditable, and explainable
- Can extend to LLM-generated narrative summaries later using existing portos-ai-toolkit

### M44 P6: Route/Reference Cleanup

**No new libraries needed.** This is a code cleanup task:
- Remove stale route comments referencing old digital-twin genome paths
- Fix IdentityTab Genome card to point to MeatSpace genome
- Grep for old `/api/digital-twin/genome` references and update to `/api/meatspace/genome` or `/api/genome`

## Installation

```bash
# Server dependencies (M44 P7 + M45)
cd server && npm install fast-xml-parser@^5.4.1

# Client dependencies (M46)
cd client && npm install cmdk@^1.1.1 fuse.js@^7.1.0 tinykeys@^3.0.0

# Optional: only if implementing watch-based backup triggers
cd server && npm install chokidar@^5.0.0
```

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| `rsync` via execFile | `archiver` npm package | If target is cloud storage (S3/GCS) instead of mounted drive -- archiver creates zip/tar for upload. Not needed for local drive backup. |
| `fast-xml-parser` v5 SAX mode | `saxes` ^6.0.0 | If fast-xml-parser chokes on malformed Apple Health XML (some exports have encoding issues). saxes is more lenient with bad XML. |
| `cmdk` | Custom Radix Dialog + input | If cmdk's opinionated styling clashes with PortOS design tokens. But cmdk is unstyled by default -- it's just behavior. |
| `fuse.js` client-side | Server-side unified search only | If data volume exceeds browser memory (~10K+ items). For PortOS single-user with ~hundreds of items per source, client-side is fine. |
| `tinykeys` | `hotkeys-js` | If you need key sequence combos (e.g., `g then i` for "go to inbox"). tinykeys supports this too, so no reason to switch. |
| `eventScheduler.js` (existing) | `node-cron` or `node-schedule` | Never for this project. PortOS already has a robust scheduler. Adding another creates confusion over which scheduler to use. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `xml2js` | DOM-based parser that loads entire XML into memory. Apple Health exports are 200MB-2GB. Will OOM. | `fast-xml-parser` v5 with SAX/streaming mode |
| `node-rsync` (npm) | Last published 2014, unmaintained, just a wrapper around exec anyway | Direct `child_process.execFile('rsync', [...args])` |
| `node-cron` / `node-schedule` | PortOS already has `eventScheduler.js` with cron support. Adding a second scheduler creates maintenance burden and confusion. | Existing `eventScheduler.js` |
| `MiniSearch` server-side | Would be a third search engine alongside BM25 and vector search. Unnecessary complexity. | Existing `memoryBM25.js` for text search; per-source filtering for other data |
| `mousetrap` | Unmaintained since 2020. No ESM support. 10KB vs tinykeys' 650 bytes. | `tinykeys` ^3.0.0 |
| `@headlessui/react` | 2.2.9 is Tailwind Labs' component library, but cmdk already bundles Radix Dialog. Adding both creates two dialog systems. | `cmdk` (includes Radix Dialog) |
| `electron-store` / `conf` | Designed for Electron config, not web app data backup | `rsync` + JSON file operations |
| SQLite / LevelDB | Adds database dependency to a JSON-file architecture. Violates project constraint. | Keep JSON files; use BM25 index for search |

## Stack Patterns by Feature

**If adding more health data sources later (e.g., Oura, Whoop, Garmin):**
- Use the same ingest pattern: Zod schema per source, normalize to internal format, write to `data/meatspace/{source}/`
- fast-xml-parser handles any XML-based exports; JSON.parse for JSON APIs
- The cross-insights engine reads from normalized meatspace data regardless of source

**If search needs semantic/vector capability later:**
- The existing `memoryEmbeddings.js` + `memoryRetriever.js` already implements hybrid BM25+vector search
- Extend the search API to use embeddings for brain/memory sources
- Keep fuse.js on client for instant navigation; server handles semantic search

**If backup target changes from local drive to NAS/cloud:**
- rsync works over SSH (NAS: `rsync -az data/ user@nas:/backups/portos/`)
- For S3/GCS, switch to `archiver` to create tar.gz, then upload via AWS SDK or `gsutil`
- The backup service abstraction (schedule, manifest, status) stays the same

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| cmdk@^1.1.1 | React ^18, ^19 | Peer dependency explicitly supports React 18 (PortOS uses 18.3.1) |
| fuse.js@^7.1.0 | Any (no framework dependency) | Zero dependencies, works anywhere |
| tinykeys@^3.0.0 | Any (vanilla JS) | Framework-agnostic; use in useEffect cleanup |
| fast-xml-parser@^5.4.1 | Node.js 14+ | v5 is ESM-native, matches PortOS's ES module setup |
| chokidar@^5.0.0 | Node.js 16+ | v5 is a full rewrite, ESM-native, drops fsevents binary |

## Sources

- npm registry (verified 2026-02-26) -- all version numbers confirmed via `npm view [package] version`
- cmdk peer dependencies: `react ^18 || ^19` (confirmed via `npm view cmdk peerDependencies`)
- fast-xml-parser v5 SAX mode: confirmed in package description and v5 changelog
- Health Auto Export JSON format: GitHub wiki at github.com/Lybron/health-auto-export/wiki/API-Export---JSON-Format
- Apple Health XML structure: confirmed via community documentation and existing parser projects
- Existing PortOS codebase: `memoryBM25.js`, `eventScheduler.js`, `bm25.js`, `genome.js` -- confirmed patterns already in use
- rsync availability on macOS: ships with Darwin (PortOS runs on Darwin 23.5.0)

---
*Stack research for: PortOS next actions batch (M44 P6-P7, M42 P5, M45, M46)*
*Researched: 2026-02-26*
