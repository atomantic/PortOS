# Project Research Summary

**Project:** PortOS -- Next Actions Batch (M44 P6/P7, M42 P5, M45, M46)
**Domain:** Personal OS monorepo -- data protection, health ingestion, cross-domain intelligence, unified search
**Researched:** 2026-02-26
**Confidence:** HIGH

## Executive Summary

PortOS is a mature single-user personal OS with 44+ milestones of existing functionality spanning app management, AI orchestration, knowledge capture, digital identity, and health tracking. The next batch of five features transforms it from powerful but siloed into connected, protected, and searchable. Experts building these feature categories (incremental backup, health data ingestion, cross-domain correlation, command palette search) follow well-established patterns: rsync for file-level incremental backup, SAX streaming for large XML parsing, declarative rule engines for data correlation, and fan-out aggregation for multi-source search. Every feature maps cleanly onto the existing Express.js + React + JSON-file architecture with no new infrastructure required.

The recommended approach is to build in strict dependency order: cleanup stale genome references first (unblocks insights), then backup (protects all data before adding new data writers), then Apple Health ingestion (adds the richest new data source), then cross-domain insights (correlates genome with health data), and finally unified search (benefits from all data sources existing). The only new npm dependencies are `fast-xml-parser` on the server (streaming XML parsing for Apple Health) and `cmdk`, `fuse.js`, `tinykeys` on the client (command palette UI). Everything else leverages existing PortOS infrastructure: `eventScheduler.js` for scheduling, `memoryBM25.js` for search, `child_process.execFile` for rsync, and Socket.IO for real-time progress.

The key risks are (1) backup copying mid-write JSON files produces corrupt backups that give false confidence, (2) Apple Health XML exports at 500MB-2GB will OOM the server if not streamed, (3) cross-domain insights generating spurious correlations that erode trust, and (4) search fan-out latency cascading when one source is slow. All four have concrete prevention strategies: write coordination before backup, mandatory streaming parser, grounded-only correlation rules, and `Promise.allSettled` with per-source timeouts. The most dangerous pitfall is silent backup failure when an external drive unmounts -- the user believes data is protected when it is not.

## Key Findings

### Recommended Stack

The stack is deliberately minimal. Three new client packages (`cmdk`, `fuse.js`, `tinykeys`) and one new server package (`fast-xml-parser`) cover all five features. Everything else uses existing PortOS infrastructure or macOS built-ins.

**Core technologies:**
- **rsync via child_process.execFile**: Incremental backup -- battle-tested C implementation, ships with macOS, handles delta sync and hardlinked snapshots
- **fast-xml-parser ^5.4.1**: Apple Health XML parsing -- only parser supporting both DOM and SAX modes in one package; v5 SAX handles 500MB+ files without OOM
- **cmdk ^1.1.1**: Cmd+K command palette -- built on Radix primitives, handles keyboard navigation/focus/scroll, unstyled by default
- **fuse.js ^7.1.0**: Client-side fuzzy search -- zero dependencies, instant results for navigation while server search is in-flight
- **tinykeys ^3.0.0**: Global keyboard shortcuts -- 650 bytes, binds Cmd+K without conflicting with input fields

**What NOT to use:** xml2js (OOM on large files), node-rsync (abandoned), node-cron (duplicates existing scheduler), MiniSearch (third search engine alongside BM25 + vector), mousetrap (unmaintained).

See `.planning/research/STACK.md` for version compatibility matrix and alternatives analysis.

### Expected Features

**Must have (table stakes):**
- Incremental backup with SHA-256 manifest, configurable schedule, manual trigger, and health indicator widget
- POST /api/health/ingest endpoint with Zod validation, deduplication, and day-partitioned storage
- Basic health dashboard cards (steps, heart rate, sleep)
- Genome-to-health correlation rules with provenance citations
- Cmd+K overlay with categorized results, debounced input, deep-link navigation

**Should have (ship after v1 validation):**
- Dry-run restore preview and selective per-directory restore
- Bulk Apple Health XML import with WebSocket progress
- LLM narrative summaries and contradiction detection in insights
- Search history, keyboard navigation, source-type filtering

**Defer (v2+):**
- Workout GPS route maps, additional health platform support
- Temporal insight evolution, semantic search across all sources
- Quick actions from search results, natural language date queries

See `.planning/research/FEATURES.md` for full prioritization matrix, anti-features, and dependency graph.

### Architecture Approach

All five features follow the existing service-per-domain pattern: each gets a service file and route file, mounted in `server/index.js`. The backup service uses the brainScheduler interval pattern for scheduling. The search service uses an adapter/fan-out pattern with `Promise.allSettled`. The insights engine is strictly read-only, reading from genome/health/taste services but never writing back. Apple Health routes nest under the existing meatspace mount. The Cmd+K overlay is a single component in Layout.jsx with a global keyboard hook. No new PM2 processes, no new ports, no new data stores.

**Major components:**
1. **Backup Service** (`server/services/backup.js`) -- schedules rsync to external drive, writes manifest, emits status via Socket.IO
2. **Apple Health Service** (`server/services/appleHealth.js`) -- stream-parses XML, normalizes records, deduplicates, writes to `data/meatspace/health/`
3. **Cross-Insights Engine** (`server/services/insights.js`) -- reads genome + health + taste data, applies declarative correlation rules, caches results
4. **Unified Search API** (`server/services/search.js`) -- fans out to domain-specific adapters, merges and ranks results, returns uniform response
5. **Command Palette** (`client/src/components/CommandPalette.jsx`) -- keyboard-triggered modal, calls search API, renders categorized results

See `.planning/research/ARCHITECTURE.md` for data flow diagrams, pattern catalog, and integration point map.

### Critical Pitfalls

1. **Backup copies mid-write JSON files** -- Use write coordination (Socket.IO flush signal + mutex) and post-copy JSON.parse validation on every backed-up file. Corrupt backups are worse than no backups.
2. **Apple Health XML OOM on 500MB+ files** -- Mandatory SAX/streaming parser from day one. Never accumulate records in memory. Process in worker or subprocess if possible.
3. **External drive unmount goes undetected** -- Verify mount with filesystem device ID check before each backup. Write sentinel file. Never mkdir -p the backup target. Surface failures prominently on dashboard.
4. **Cross-insights produce spurious correlations** -- Ground all genome-health insights in ClinVar/SNPedia. Use LLM to synthesize pre-validated correlations, not discover new ones. Label confidence tiers in UI.
5. **Search fan-out cascading latency** -- Use `Promise.allSettled` with 300ms per-source timeouts. Return partial results fast. Cap history search to recent entries.
6. **Health Auto Export schema drift** -- Use Zod `.passthrough()` on ingest schema. Log raw payloads before validation. Implement "last heard from" staleness warning.
7. **Genome data physically in wrong directory** -- M44 P6 must migrate files from `data/digital-twin/genome-*` to `data/meatspace/genome-*` and update service path constants.

See `.planning/research/PITFALLS.md` for recovery strategies, verification tests, and "looks done but isn't" checklist.

## Implications for Roadmap

Based on combined research, the five milestones have a clear dependency chain that dictates build order. Two can be parallelized.

### Phase 1: Genome Migration Cleanup (M44 P6)

**Rationale:** Zero-risk housekeeping that unblocks the cross-insights engine. Genome data currently lives in `data/digital-twin/` while served under meatspace routes -- a ticking time bomb if anyone cleans up the digital-twin directory.
**Delivers:** Correct genome data location, fixed IdentityTab navigation, clean route comments, redirect from old URLs.
**Addresses:** Table stakes from FEATURES.md (fix stale references, fix dead links).
**Avoids:** Pitfall 6 (genome data in wrong directory), Pitfall of insights engine reading from incorrect path.
**Effort:** Small (1-2 hours). Includes data migration script.

### Phase 2: Data Backup and Recovery (M45)

**Rationale:** Every subsequent phase adds new data writers (health data, insight caches). Backup must be in place before the blast radius of data loss increases. This is the highest-risk-reduction feature in the batch.
**Delivers:** Incremental rsync backup, SHA-256 manifest, configurable schedule, manual trigger, dashboard health widget, restore capability.
**Uses:** rsync via execFile, existing eventScheduler.js, Socket.IO for status.
**Implements:** Backup Service component with interval scheduler pattern.
**Avoids:** Pitfall 1 (corrupt mid-write copies), Pitfall 5 (silent unmount failure).
**Note:** Can be built in parallel with Phase 1 (zero overlap).

### Phase 3: Apple Health Integration (M44 P7)

**Rationale:** Adds the richest new data source, which dramatically enhances the cross-insights engine. The meatspace infrastructure already exists. Must use streaming parser from the start -- retrofitting is impractical.
**Delivers:** POST /api/health/ingest for Health Auto Export JSON, Zod validation with .passthrough(), dedup by metric+timestamp, day-partitioned storage, basic dashboard cards.
**Uses:** fast-xml-parser v5 (SAX mode for bulk XML), plain JSON.parse for Health Auto Export JSON.
**Implements:** Apple Health Service with stream parser and meatspace data integration.
**Avoids:** Pitfall 2 (XML OOM), Pitfall 7 (schema drift breaking ingestion).

### Phase 4: Cross-Domain Insights Engine (M42 P5)

**Rationale:** Depends on clean genome routes (Phase 1) and benefits enormously from Apple Health data (Phase 3). Building earlier means fewer correlations to ship. The rule engine itself is straightforward; the hard part is curating scientifically grounded rules.
**Delivers:** Genome-to-health correlation rules, taste-to-identity theme extraction, insight persistence with provenance citations, manual refresh trigger.
**Uses:** Existing genome.js curated markers, existing AI provider infra (for narrative summaries later), declarative rule engine pattern.
**Implements:** Cross-Insights Engine with read-only aggregation pattern.
**Avoids:** Pitfall 3 (spurious correlations), anti-pattern of circular service dependencies.

### Phase 5: Unified Search / Cmd+K (M46)

**Rationale:** Benefits from all data sources existing. Each domain adapter is independent so search can ship incrementally, but the experience is richest with all domains populated. Naturally the last feature.
**Delivers:** Cmd+K overlay, server-side fan-out search across 7+ sources, categorized results with source icons, debounced input, deep-link navigation.
**Uses:** cmdk, fuse.js, tinykeys on client. Existing BM25 + per-source filtering on server.
**Implements:** Unified Search API (fan-out aggregator) + Command Palette component.
**Avoids:** Pitfall 4 (cascading latency from slow sources).

### Phase Ordering Rationale

- **Phase 1 before Phase 4:** Cross-insights reads genome data through genome.js. If data is in the wrong directory, insights silently fail or read stale data.
- **Phase 2 before Phase 3:** Apple Health bulk imports add hundreds of MB of new data. Backup must protect existing data before adding new data writers.
- **Phase 3 before Phase 4:** The most compelling cross-insights are genome-to-health correlations. Without health data, the engine can only do genome+taste (less valuable).
- **Phase 5 last:** Search is additive. It works over whatever data exists. Shipping it last means maximum searchable content from day one.
- **Phases 1+2 in parallel:** Zero overlap in files touched, zero dependency between them. Ship both before moving to Phase 3.
- **Phases 3+4 partially parallelizable:** Insights engine can start with genome-only correlations while health data ingestion is built. Add health correlations when Phase 3 completes.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 3 (Apple Health):** Health Auto Export JSON schema is documented but not verified against the current app version (v7+). Test with actual payload before finalizing Zod schema. Also: timezone handling between Apple Health (local TZ) and PortOS (UTC) needs careful attention.
- **Phase 4 (Cross-Insights):** Curating scientifically grounded correlation rules requires reviewing the 117 markers in curatedGenomeMarkers.js against ClinVar/SNPedia for actionable health correlations. This is domain expertise, not engineering.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Cleanup):** Pure find-and-replace + data migration. No research needed.
- **Phase 2 (Backup):** rsync incremental backup is a decades-old pattern. Architecture decisions are clear.
- **Phase 5 (Search):** Fan-out search aggregation and command palette are well-documented patterns. cmdk handles the hard parts.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All package versions verified via npm registry 2026-02-26. Compatibility confirmed against existing React 18.3.1 and Node.js versions. No speculative choices. |
| Features | MEDIUM-HIGH | Table stakes are clear and well-grounded in codebase analysis. Health Auto Export JSON schema specifics need validation against current app version. |
| Architecture | HIGH | All five features follow existing PortOS patterns. No new infrastructure. Data flow diagrams align with codebase inspection. |
| Pitfalls | HIGH | Pitfalls grounded in specific codebase findings (genome.js line 7, CONCERNS.md race conditions, ecosystem.config.cjs memory limits). Verification tests are concrete. |

**Overall confidence:** HIGH

### Gaps to Address

- **Health Auto Export payload schema:** Feature research cites the app's GitHub wiki for JSON format, but the schema may have changed in recent app versions. Validate with an actual POST from the iOS app before finalizing the Zod schema. Mitigate with `.passthrough()` to accept unknown fields.
- **Apple Health XML timezone handling:** Records use device-local timezone; PortOS runs in UTC. The conversion logic needs to be specified during Phase 3 planning. This is a known pitfall but the exact offset strategy (store original + UTC? convert on ingest?) is not decided.
- **External drive mount path:** The backup target configuration assumes a macOS `/Volumes/` mount. The specific validation approach (diskutil vs. statfs device ID comparison) should be prototyped during Phase 2 planning.
- **Cross-insights rule curation:** The 117 curated genome markers exist, but which ones have actionable health correlations (vs. purely informational) needs domain review. This is content work, not engineering, and may take longer than the code.
- **Fuse.js vs. server-only search:** Architecture research suggests building the Cmd+K overlay without cmdk (custom component), while Stack research recommends cmdk. Recommendation: use cmdk -- it solves keyboard navigation and focus management, which are non-trivial to get right for accessibility.

## Sources

### Primary (HIGH confidence)
- PortOS codebase: `server/services/genome.js`, `server/services/memoryBM25.js`, `server/services/brainScheduler.js`, `ecosystem.config.cjs`, `server/lib/bm25.js`
- PortOS planning docs: `PLAN.md`, `PROJECT.md`, `.planning/codebase/CONCERNS.md`, `.planning/codebase/ARCHITECTURE.md`
- npm registry (verified 2026-02-26): fast-xml-parser, cmdk, fuse.js, tinykeys, chokidar version and peer dependency checks

### Secondary (MEDIUM confidence)
- Health Auto Export app: GitHub wiki (github.com/Lybron/health-auto-export), App Store listing -- JSON schema documentation
- Apple Health XML format: community parser projects (github.com/cvyl/apple-health-parser), established format since iOS 8
- Cmd+K UX patterns: observed in Raycast, VS Code, Linear, Notion, Slack

### Tertiary (LOW confidence)
- Apple Health XML timezone behavior: inferred from community documentation. Needs validation with actual export file.
- macOS volume unmount persistence behavior on APFS: observed but edge cases may vary by macOS version.

---
*Research completed: 2026-02-26*
*Ready for roadmap: yes*
