# Pitfalls Research

**Domain:** Personal OS monorepo — JSON file persistence, health data ingestion, cross-domain intelligence, global search
**Researched:** 2026-02-26
**Confidence:** HIGH (based on codebase analysis and established patterns in similar systems)

## Critical Pitfalls

### Pitfall 1: Backup Copies Corrupt Mid-Write JSON Files

**What goes wrong:**
Incremental backup copies a JSON file while the server is writing to it. The backup contains a truncated or half-written file. On restore, that file fails to parse and the service crashes or loses data. This is already a known concern — CONCERNS.md documents that `cos.js` does write-via-temp-file but catch handlers swallow errors, and multiple services write without coordinated locking.

**Why it happens:**
Node.js `writeFile` is not atomic. The backup scheduler reads file modification timestamps to decide what to copy, but the file could be mid-write at the exact moment of copy. With 7+ top-level JSON files and nested directories (`cos/`, `brain/`, `digital-twin/`), the window for collision is non-trivial — especially during CoS daemon cycles that write `state.json` on every tick.

**How to avoid:**
1. Snapshot-then-copy: Before copying, create hard links (macOS/Linux) or use `fs.copyFile` with `COPYFILE_EXCL` to a staging directory, then move the staging directory to the backup target. Hard links are instant and capture a point-in-time view.
2. Coordinate with write locks: Emit a Socket.IO event (`backup:starting`) so services can flush pending writes and hold new writes until `backup:complete`. Use the existing mutex pattern from `memory.js`.
3. Validate after copy: Read every `.json` file in the backup and attempt `JSON.parse`. If any file fails validation, re-copy it. Log validation results to the backup manifest.

**Warning signs:**
- Backup manifest shows files copied in under 1ms (may indicate zero-byte copies)
- Restored files that `JSON.parse` rejects
- Backup size varies wildly between runs (indicates partial copies)

**Phase to address:**
M45 (Data Backup & Recovery) — implement as core backup correctness guarantee before adding scheduling or retention.

---

### Pitfall 2: Apple Health XML Parsing Blows Up Memory on 500MB+ Files

**What goes wrong:**
The naive approach to parsing Apple Health XML exports is `fs.readFile` + DOM parser, which loads the entire 500MB-1GB file into memory as a string, then doubles or triples it during DOM construction. Node.js process exceeds `max_memory_restart` (500M for portos-server) and PM2 kills it mid-parse, leaving partial data written to `data/health/`.

**Why it happens:**
Apple Health XML exports contain millions of `<Record>` elements. A typical 2-3 year export is 500MB-1.5GB of XML. DOM-based parsing requires the entire document in memory. Even SAX/stream parsers must be configured carefully — if you accumulate parsed records in an array before writing, you recreate the same memory problem.

**How to avoid:**
1. Use `xml-stream` or `sax` in true streaming mode: parse record-by-record, writing each day's batch to `data/health/YYYY-MM-DD.json` as you encounter it. Never accumulate more than one day's records in memory.
2. Process in a separate worker or PM2 process (not the main API server) so memory spikes don't affect other routes.
3. Set a dedicated `max_memory_restart` higher for the import worker, or use `--max-old-space-size=2048` for the import subprocess.
4. Report progress via WebSocket as planned — but use record count, not byte offset, since XML parsing position doesn't map linearly to progress.

**Warning signs:**
- Node.js process memory exceeding 400MB during import
- PM2 restart logs during XML processing
- Partial `data/health/` files (some days present, later days missing)

**Phase to address:**
M44 P7 (Apple Health Integration) — streaming parser is the foundational architecture choice, not an optimization to add later.

---

### Pitfall 3: Cross-Insights Engine Produces Spurious Correlations

**What goes wrong:**
Genome-to-health and taste-to-identity correlations sound compelling but without proper methodology, the engine generates confident-sounding but meaningless insights. Example: "Your MTHFR C677T variant correlates with your preference for dark chocolate" — a coincidence dressed up as an insight. Users lose trust in the entire system.

**Why it happens:**
With enough data dimensions (genome markers, taste preferences, personality traits, health metrics), any two variables will appear correlated by chance. LLMs are particularly prone to generating plausible-sounding causal narratives from coincidental associations. The genome service already has curated markers with known clinical significance, but crossing domains (genome x taste x personality) invites fabrication.

**How to avoid:**
1. Ground insights in established science: Only generate genome-to-health correlations for markers with ClinVar clinical significance or well-documented SNPedia associations. The existing `curatedGenomeMarkers.js` and ClinVar sync already provide this foundation.
2. Use the LLM to synthesize, not discover: Feed the LLM pre-validated correlations (e.g., "APOE e4 + family history + high LDL = elevated Alzheimer's risk") rather than asking it to find patterns.
3. Label confidence tiers explicitly in the UI: "Established" (peer-reviewed), "Suggested" (multiple genome markers align), "Speculative" (pattern-matched, not validated).
4. Taste-to-identity: These are legitimate personality psychology connections (Big Five traits predict aesthetic preferences). Use established mappings, not LLM inference.

**Warning signs:**
- Insights reference genome markers not in the curated set
- The same insight appears for different genotypes (templated, not data-driven)
- Users report insights that contradict known medical information

**Phase to address:**
M42 P5 (Cross-Insights Engine) — the insight taxonomy and confidence labeling must be designed before any correlation logic runs.

---

### Pitfall 4: Cmd+K Search Fan-Out Creates Cascading Latency

**What goes wrong:**
The search endpoint fans out to 7+ data sources (brain, memory, history, agents, apps, digital-twin, meatspace). Each source has different search characteristics — memory uses vector+BM25, brain does text matching, history scans a JSON array. One slow source (e.g., memory with embedding provider offline) blocks the entire response. The 200ms debounce feels snappy until the server takes 3 seconds to respond.

**Why it happens:**
`Promise.all` with heterogeneous data sources means the slowest source determines total latency. Memory search with BM25 fallback already has known latency issues (CONCERNS.md). History file grows unbounded (CONCERNS.md). Agent data requires reading date-bucketed directories.

**How to avoid:**
1. `Promise.allSettled` with per-source timeouts (300ms per source). Return whatever results arrive in time; show a "still searching..." indicator for slow sources.
2. Priority ordering: Search apps and brain first (fast, in-memory or small files). Memory and history last (potentially slow). Return results progressively via WebSocket if HTTP streaming isn't viable.
3. Pre-index searchable fields on startup: Build in-memory keyword indexes for brain captures, apps, agent names/descriptions. Only hit disk for full-text or embedding search.
4. Cap history search to recent N entries (last 30 days or 1000 entries) for Cmd+K — full history search can be a dedicated DevTools feature.

**Warning signs:**
- Search response time exceeds 500ms for simple keywords
- Results from one source consistently missing (timeout, not empty)
- Memory usage spikes on search queries (loading full history into memory)

**Phase to address:**
M46 (Unified Search) — per-source timeouts and progressive results must be in the initial architecture, not patched on after.

---

### Pitfall 5: Backup to External Drive Fails Silently When Drive Unmounted

**What goes wrong:**
The backup target path (e.g., `/Volumes/Backup/portos/`) exists when configured but the external drive disconnects or unmounts between backups. The next scheduled backup writes to a local path that macOS auto-creates under `/Volumes/` (or fails with ENOENT), and the user believes backups are running successfully. Weeks later when they need to restore, the "backup" is either missing or on the boot disk consuming space.

**Why it happens:**
macOS doesn't error when writing to `/Volumes/ExternalDrive/` if the mount point directory still exists after unmount — it just writes to local disk. Or the directory doesn't exist and the backup fails silently because error handling only logs, doesn't alert.

**How to avoid:**
1. Before each backup run, verify the target is an actual mounted volume: check `os.platform() === 'darwin'` and validate with `diskutil info <path>` or verify the volume appears in `fs.statfs()` with a different device ID than the root filesystem.
2. Write a `.portos-backup-probe` sentinel file with a timestamp after each backup. On the next run, read it back and verify the timestamp matches. If it doesn't match (or file is missing), the drive was likely remounted fresh or replaced.
3. Surface backup failures prominently: Dashboard widget should show red status, not just log. Emit a notification event for M47 integration later.
4. Never `mkdir -p` the backup target — if the directory doesn't exist, that's a signal the drive isn't mounted.

**Warning signs:**
- Backup target path exists but `df <path>` shows the root filesystem
- Backup completes in milliseconds (writing to fast local SSD instead of external drive)
- Backup size on target doesn't grow over time

**Phase to address:**
M45 (Data Backup & Recovery) — mount verification is day-one logic, not a nice-to-have.

---

### Pitfall 6: Genome Data Still Lives in `data/digital-twin/` After Route Migration

**What goes wrong:**
Routes were moved from `/api/digital-twin/genome/` to `/api/meatspace/genome/` (M44 P5), and the client `api.js` calls the new endpoints. But the genome service (`server/services/genome.js` line 7) still reads/writes to `PATHS.digitalTwin` (`data/digital-twin/`). The genome data physically lives in the digital-twin directory while being served under meatspace routes. If a future cleanup moves or deletes `data/digital-twin/`, genome data is lost. The IdentityTab also still navigates to `/digital-twin/genome` (a dead route).

**Why it happens:**
The migration moved the API route mounting point but didn't move the physical data directory or update the service's path constants. This is a classic incomplete migration — the API surface changed but the storage layer didn't follow.

**How to avoid:**
1. M44 P6 must update `genome.js` to use `PATHS.meatspace` for genome data storage, and include a one-time data migration that moves files from `data/digital-twin/genome-*` to `data/meatspace/genome-*`.
2. Update `IdentityTab.jsx` line 190 to navigate to `/meatspace` (the genome tab within MeatSpace) instead of `/digital-twin/genome`.
3. Update route comments in `server/routes/genome.js` that still reference `/api/digital-twin/genome/`.
4. Verify `meatspace.js` service reads from the correct path for genome cross-references (it imports `getSnpIndex` from `genome.js`).

**Warning signs:**
- `data/digital-twin/` contains `genome-raw.txt` and `genome.json` while `data/meatspace/` has no genome files
- Clicking "Genome" in IdentityTab navigates to a 404 page
- Genome route comments reference the old `/api/digital-twin/genome/` path

**Phase to address:**
M44 P6 (Migration Cleanup) — this is the explicit scope of this phase.

---

### Pitfall 7: Health Auto Export JSON Schema Changes Break Ingestion Silently

**What goes wrong:**
The Health Auto Export app updates its JSON payload format (field renames, nested structure changes, new metric types). The Zod validation schema on `POST /api/health/ingest` rejects the new format, and the iOS app silently fails to deliver data. Since the app runs in the background on the phone, there's no visible error — data just stops arriving. The user discovers weeks later that health data has a gap.

**Why it happens:**
Third-party app APIs evolve without notice. The Health Auto Export app has had multiple major versions. The PortOS endpoint is a receiver, so it must handle whatever the app sends. Zod's strict validation (the project convention) rejects unknown fields by default, which is the opposite of what you want for a third-party data receiver.

**How to avoid:**
1. Use Zod's `.passthrough()` on the ingest schema — validate known fields but preserve unknown ones. New metric types shouldn't cause rejection.
2. Log the raw payload to `data/health/raw/` before validation, so even if parsing fails, the data isn't lost.
3. Implement a "last heard from" timestamp. If the ingest endpoint hasn't received data in 2x the expected interval, surface a warning on the MeatSpace dashboard.
4. Pin the expected schema version but handle gracefully: if the payload has an unexpected structure, store it raw and flag for review rather than rejecting.

**Warning signs:**
- Ingest endpoint returning 400 errors (check server logs)
- `data/health/` stops receiving new daily files
- Health Auto Export app shows delivery failures in its logs

**Phase to address:**
M44 P7 (Apple Health Integration) — permissive ingestion with raw logging must be the default from the start.

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Backup copies files without write coordination | Simpler implementation, no service changes | Occasional corrupt backups, silent data loss on restore | Never — corrupt backups are worse than no backups because they create false confidence |
| Parse Apple Health XML into memory, then batch write | Simpler code, easier to test | OOM kills on 500MB+ files, partial data writes | Only for testing with sample files <10MB |
| LLM generates cross-domain insights without grounding | Faster to build, more "interesting" outputs | Spurious correlations erode user trust, potentially dangerous health misinformation | Never for genome-health correlations; acceptable for taste-personality (lower stakes) |
| Search fans out synchronously with no timeouts | Simpler Promise.all, guaranteed completeness | One slow source blocks all results, bad UX on every keystroke | Only during initial prototype; replace before shipping |
| Store genome data in digital-twin directory after route move | No data migration needed | Confusing directory structure, data loss if digital-twin dir cleaned up | Only during the migration transition (M44 P6 should resolve immediately) |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Health Auto Export app | Strict Zod schema rejects new fields from app updates | Use `.passthrough()` on Zod schema; log raw payloads before validation; store unknown metrics rather than rejecting |
| Apple Health XML export | Using `xml2js` or similar DOM parser that loads entire file into memory | Use `sax` or `xml-stream` with per-record streaming; write day files incrementally; process in worker |
| External backup drive (macOS) | Assuming mount path existence means drive is mounted | Verify with `diskutil` or filesystem device ID check; write and read sentinel file; never `mkdir -p` the target |
| ClinVar database sync | Downloading full ClinVar VCF on every sync (1.5GB) | Already implemented in `clinvar.js` — but ensure backup system excludes or handles large downloaded reference files |
| Cross-insights LLM calls | Passing raw genome data to LLM and asking "what insights?" | Pre-filter to curated markers with known significance; use structured prompt with established associations; label confidence tiers |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Full `history.json` scan on every Cmd+K search | Search latency >1s, grows linearly with history size | Index recent history on startup; cap Cmd+K to last 30 days; full search in DevTools only | History exceeds ~5000 entries (already noted as unbounded in CONCERNS.md) |
| Loading all `data/health/YYYY-MM-DD.json` files for dashboard charts | Dashboard load time spikes after months of Apple Health data | Pre-aggregate daily summaries into `data/health/summary.json`; load individual days only on drill-down | After ~90 days of health data (~90 files to read and merge) |
| In-memory genome SNP index (600K+ entries) kept alive during search | 50-100MB memory overhead for genome data during search fan-out | Genome search should be opt-in for Cmd+K (most searches aren't about SNPs); lazy-load index only when genome category selected | Always — the index is large by design (line 11 of genome.js: in-memory Map with TTL) |
| Backup scanning entire `data/` tree for modification timestamps | Backup scheduling takes seconds, blocks event loop | Use `fs.watch` or maintain a change manifest that services update on write; scan only on first backup or after restart | `data/runs/` has 815+ directories; `data/cos/` has deep nested structures |
| Cross-insights engine running all correlation checks on every data change | API lag on meatspace or digital-twin updates | Compute insights on schedule (daily) or on explicit user request, not reactively on every data mutation | When genome markers + health metrics + taste dimensions exceed ~100 data points |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Search results with no source context | User sees "MTHFR C677T" but doesn't know if it's from genome, brain, or memory | Every search result card must show source icon + category label + timestamp + deep link |
| Backup "success" with no verification | User trusts backup is working; discovers corrupt backup during emergency restore | Show last verified restore test date on dashboard; backup widget should distinguish "copied" from "verified" |
| Apple Health import with no progress indication | User uploads 500MB XML, sees spinner for 10+ minutes, assumes it crashed | Stream progress via WebSocket: "Parsed 45,000 of ~2,000,000 records (2.3%)" with ETA |
| Cross-insights showing genome health risks without context | User sees "elevated Alzheimer's risk" without understanding relative risk or actionability | Always show: what the marker means, population frequency, what's actionable, link to source study |
| Cmd+K results mixing high-value and low-value matches | First 10 results are all history entries instead of the brain capture the user wanted | Source-type boosting with configurable weights; apps and brain captures ranked higher than raw history entries |

## "Looks Done But Isn't" Checklist

- [ ] **Backup system:** Often missing restore verification — verify by actually restoring to a temp directory and running JSON.parse on every file
- [ ] **Backup system:** Often missing drive-unmount detection — test with drive unplugged, verify backup fails loudly
- [ ] **Apple Health import:** Often missing deduplication — uploading the same XML twice should not create duplicate records (deduplicate by metric + timestamp)
- [ ] **Apple Health import:** Often missing timezone handling — Apple Health XML records use local timezone; PortOS data uses UTC (per ecosystem.config.cjs `TZ: 'UTC'`)
- [ ] **Cross-insights:** Often missing "no data" states — what does the engine show when genome is uploaded but no health data exists yet, or vice versa?
- [ ] **Cmd+K search:** Often missing empty-state and error-state UX — what happens when search returns zero results? When one source errors?
- [ ] **Cmd+K search:** Often missing keyboard navigation — up/down arrow to select results, Enter to navigate, Escape to close
- [ ] **Migration cleanup:** Often missing route redirect for old URLs — bookmarks and browser history pointing to `/digital-twin/genome` should redirect to `/meatspace`
- [ ] **Backup manifest:** Often missing checksums — a file list without SHA-256 hashes can't detect bit rot or partial writes

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Corrupt backup (mid-write copy) | MEDIUM | Re-run backup with write coordination; validate existing backups by parsing all JSON files; discard corrupt snapshots |
| OOM during Apple Health XML import | LOW | Restart PM2 process; switch to streaming parser; re-run import (idempotent if deduplication works) |
| Spurious cross-domain insights shipped to UI | MEDIUM | Add confidence tier labels retroactively; clear cached insights; rebuild correlation engine with grounded-only mode |
| Search fan-out timeout causing missing results | LOW | Add per-source timeouts; results appear incrementally; no data loss, just UX degradation |
| Silent backup failure (unmounted drive) | HIGH if data loss occurs | If original data intact: fix mount detection, re-run backup. If original data lost: no recovery possible — this is the pitfall that justifies M45's priority |
| Genome data in wrong directory | LOW | One-time migration script: `mv data/digital-twin/genome-* data/meatspace/`; update service path constant |
| Health Auto Export schema change breaks ingestion | MEDIUM | Retrieve raw payloads from app's internal cache (if available); update Zod schema; re-ingest; implement `.passthrough()` to prevent recurrence |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Backup copies corrupt mid-write JSON | M45 (Backup) | Restore test passes JSON.parse on 100% of backed-up files |
| External drive unmount goes undetected | M45 (Backup) | Unplug drive, trigger backup, verify red status on dashboard within 1 minute |
| Apple Health XML OOM | M44 P7 (Apple Health) | Import 500MB+ XML file while monitoring `process.memoryUsage().heapUsed` stays under 300MB |
| Health Auto Export schema drift | M44 P7 (Apple Health) | Add unknown fields to test payload; verify they're stored, not rejected |
| Cross-insights spurious correlations | M42 P5 (Cross-Insights) | Every displayed insight traces back to a ClinVar entry or curated marker; no LLM-fabricated associations |
| Search fan-out cascading latency | M46 (Cmd+K Search) | Disable one search source (e.g., memory); verify other results still return within 500ms |
| Genome data in wrong directory | M44 P6 (Migration Cleanup) | `ls data/meatspace/genome*` shows genome files; `ls data/digital-twin/genome*` returns nothing |
| IdentityTab broken genome link | M44 P6 (Migration Cleanup) | Click Genome card in IdentityTab; verify it navigates to MeatSpace genome view, not 404 |
| Apple Health timezone mismatch | M44 P7 (Apple Health) | Import record with known local timestamp; verify stored UTC timestamp is correct offset |

## Sources

- Codebase analysis: `server/services/genome.js` (line 7: `GENOME_DIR = PATHS.digitalTwin`), `server/services/meatspace.js` (line 11: imports from genome.js), `client/src/components/digital-twin/tabs/IdentityTab.jsx` (line 190: dead `/digital-twin/genome` link)
- `.planning/codebase/CONCERNS.md` — race conditions in file writes, missing mutex in CoS, unbounded history, memory embeddings out-of-sync
- `PLAN.md` M44 P7 spec — references `xml-stream` for streaming parse, Health Auto Export server reference repos
- `PLAN.md` M45 spec — incremental backup with checksums, retention policy
- `PLAN.md` M46 spec — fan-out to 7+ sources, `Promise.all` pattern
- `ecosystem.config.cjs` — `TZ: 'UTC'` base env, `max_memory_restart: '500M'` for server
- Apple Health export XML format: records use device-local timezone, not UTC (established behavior since iOS 8)
- macOS volume mounting behavior: `/Volumes/<name>/` directory persists briefly after unmount on APFS

---
*Pitfalls research for: PortOS next actions batch (M44 P6-P7, M42 P5, M45, M46)*
*Researched: 2026-02-26*
