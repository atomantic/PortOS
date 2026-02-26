# Feature Research

**Domain:** Personal OS dashboard -- JSON backup, Apple Health integration, cross-domain insight engine, Cmd+K search overlay
**Researched:** 2026-02-26
**Confidence:** MEDIUM-HIGH (based on established patterns in each subdomain; Apple Health payload schema not yet verified against current app version)

## Feature Landscape

This research covers five planned milestones (M44 P6/P7, M42 P5, M45, M46) across four distinct feature domains. Each domain is analyzed independently, then dependencies are mapped across all five.

---

## 1. JSON Backup Systems (M45)

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Incremental copy by mtime | Full copy of 800+ files on every run is wasteful; users expect only changed files transfer | LOW | `fs.stat()` mtime comparison against manifest is trivial |
| Backup manifest with checksums | Without integrity verification, a corrupted backup is worse than no backup -- silent data loss | MEDIUM | SHA-256 per file; store in `manifest.json` at backup root |
| Configurable schedule | Must not require manual trigger every time; daily default with override | LOW | Leverage existing automation scheduler (M26) |
| Retention policy (N daily + N weekly) | Unbounded backups fill drives; users expect automatic pruning | LOW | Date-based directory naming + prune logic |
| Manual trigger button | "Back up now" before risky operations is a fundamental expectation | LOW | POST /api/backup/trigger, button in dashboard widget |
| Backup health indicator | User must know at a glance if backups are current | LOW | Green/yellow/red based on last backup age |
| Atomic writes / temp-then-rename | A crash mid-backup must not corrupt the target; partial writes are the #1 backup failure mode | MEDIUM | Write to `.tmp` dir, rename on success |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Dry-run restore preview | Shows what would change before restoring -- reduces fear of restore destroying current state | MEDIUM | Diff manifest checksums between backup and current `data/` |
| Per-directory selective restore | Restore only `data/brain/` without touching `data/cos/` -- granular recovery | MEDIUM | Directory-scoped manifest filtering |
| Pre-backup validation | Verify JSON parse-ability of critical files before backing up -- don't back up corruption | LOW | `JSON.parse()` guard on key files |
| Socket.IO progress during backup/restore | Long operations (especially restore) need real-time progress feedback | LOW | Emit progress events through existing Socket.IO infra |
| Backup size tracking over time | Trend of data growth informs when to add more storage | LOW | Store size in manifest history |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Cloud backup (S3, GCS, etc.) | "What if the house burns down" | Adds cloud credentials, network dependency, cost, and complexity; out of scope per PROJECT.md | Local external drive now; cloud can layer later via rsync to a cloud-mounted volume |
| Versioned file-level history (git-style) | "Roll back a single file to 3 versions ago" | JSON files change frequently; versioning every write creates enormous storage overhead and complex diff UI | Snapshot-level retention (daily/weekly) is sufficient; individual file recovery comes from picking the right snapshot |
| Encryption at rest | Protect backup from physical theft | Single-user system on private network; encryption adds key management complexity and slows backup/restore | Rely on macOS FileVault for disk encryption |
| Database migration to SQLite | "JSON files are fragile" | Massive rewrite of entire data layer for marginal benefit; JSON-per-file is the established pattern | Backup system protects against the fragility concern directly |
| Real-time continuous backup (inotify/fsevents) | "Never lose a write" | High CPU/IO overhead; PortOS writes to data/ on every API call; continuous sync creates thundering herd on the external drive | Scheduled incremental (daily + manual trigger) covers 99% of risk |

---

## 2. Apple Health Integration (M44 P7)

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| POST /api/health/ingest endpoint | Health Auto Export app needs a URL to POST to; this is the entire integration surface | MEDIUM | Zod validation of the Health Auto Export JSON schema |
| Deduplication by metric+timestamp | App sends overlapping windows; without dedup, data doubles on every sync | MEDIUM | Composite key: `metricName + startDate` or hash-based |
| Day-partitioned JSON storage | `data/health/YYYY-MM-DD.json` matches existing PortOS pattern; keeps files manageable | LOW | One file per day, merge on write |
| Bulk XML import (Apple Health export.zip) | Users have years of historical data in Apple's XML export; without bulk import the feature starts empty | HIGH | Stream-parse 500MB+ XML; `xml-stream` or `sax` parser; progress via WebSocket |
| Zod schema validation | Reject malformed payloads; consistent with all other PortOS routes | LOW | Define schema from Health Auto Export docs |
| Basic dashboard cards (steps, heart rate, sleep) | Ingested data with no visualization is useless | MEDIUM | Time-series line charts for key metrics; reuse existing chart patterns |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Health-to-MeatSpace correlation views | Overlay HRV with alcohol intake, sleep quality with exercise -- the unique PortOS value is connecting siloed data | HIGH | Depends on M42 P5 cross-insights engine for full value; can start with simple overlay charts |
| Metric category browser | 150+ Apple Health metric types; let user browse/search available metrics and pin favorites | MEDIUM | Catalog ingested metric types, show latest values |
| Import progress via WebSocket | XML imports take minutes; real-time progress bar prevents "is it stuck?" anxiety | LOW | Existing Socket.IO infra; emit count/total during parse |
| Configurable sync interval display | Show when last sync happened and expected next sync from the iOS app | LOW | Track last ingest timestamp per source |
| Workout route maps | Health Auto Export includes GPS routes for workouts; rendering on a map is compelling | HIGH | Requires Leaflet/MapLibre, GPS coordinate parsing; defer to post-MVP |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Apple HealthKit direct API | "Skip the middleman app" | HealthKit is iOS-only SDK; PortOS is a Node.js server with no iOS runtime | Health Auto Export app bridges the gap for ~$4 |
| Real-time live sync from watch/phone | "I want instant updates" | Health Auto Export batches on configurable intervals (15-60 min); real-time would require custom iOS app development | 15-min interval from Health Auto Export is plenty for dashboard use |
| Write-back to Apple Health | "Let PortOS update my health records" | HealthKit write access requires an iOS app with entitlements; massive scope increase | PortOS is read-only consumer of health data |
| Medical-grade analytics / diagnosis | "Tell me if my HRV means I'm sick" | Liability risk; PortOS is not a medical device; LLM-generated health advice can be harmful | Show trends and correlations; let the user draw conclusions; flag "consult a doctor" |
| Support for every health platform (Fitbit, Garmin, Oura) | "I might switch devices" | Each platform has different APIs, auth flows, and data formats; scope explosion | Apple Health is the aggregator -- most devices already sync into it |

---

## 3. Cross-Domain Insight Engine (M42 P5)

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Genome-to-health correlation rules | Map specific SNP markers to health recommendations (e.g., MTHFR + folate, APOE + cardiovascular risk) | MEDIUM | Rule-based engine using existing 117 curated markers and their categories |
| Taste-to-identity theme extraction | Derive personality themes from taste profile (e.g., preference for dark narratives + minimalist architecture = "introspective pragmatist") | MEDIUM | LLM-powered summarization over structured taste data |
| Insight persistence | Generated insights must be saved and retrievable, not regenerated on every page load | LOW | `data/digital-twin/insights.json` |
| Insight provenance / citations | Each insight must cite which data sources contributed (e.g., "Based on: rs762551 fast caffeine metabolism + evening chronotype") | MEDIUM | Store source references with each insight entry |
| Manual refresh trigger | User should be able to regenerate insights when underlying data changes | LOW | Button in UI, POST endpoint |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Cross-domain contradiction detection | Flag when genome says one thing and behavior says another (e.g., genome says morning chronotype but user reports evening habits) | MEDIUM | Compare genetic predictions against behavioral/reported data |
| Confidence scoring per insight | Not all correlations are equally supported; show confidence level | LOW | Derive from marker classification (beneficial/typical/concern) and number of supporting data points |
| Temporal insight evolution | "Your taste profile has shifted toward warmer aesthetics since 6 months ago" -- track how insights change over time | HIGH | Requires snapshots of derived insights; defer to v2 |
| LLM-generated narrative summaries | Paragraph-form "here is who you are" synthesizing genome, taste, personality, and goals | MEDIUM | Use existing AI provider infra; identity context injection from M42 |
| Health-genome action items | Concrete recommendations: "Your MTHFR variant suggests supplementing methylfolate" | MEDIUM | Rule engine with pre-written recommendation templates per marker category |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Fully autonomous insight generation | "Generate insights automatically on a schedule" | LLM calls are expensive; insights don't change unless underlying data changes; scheduled generation wastes tokens | Generate on-demand when user requests or when source data is updated |
| Causal claims ("your genome causes X") | Users want definitive answers | SNP correlations are probabilistic, not causal; stating "causes" is scientifically wrong and potentially harmful | Use language like "associated with," "may influence," "research suggests" |
| Cross-user comparison | "How do I compare to population averages?" | Single-user system; no population data available; would require external datasets with licensing concerns | Show the user's own data with published population frequencies from dbSNP/ClinVar |
| Real-time streaming insights | "Update insights as I type/log data" | Insight generation requires multiple data sources and LLM calls; real-time is impractical and expensive | Batch on explicit trigger or on data change events |

---

## 4. Unified Search / Cmd+K Overlay (M46)

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Cmd+K / Ctrl+K keyboard shortcut | Universal convention for launcher/search overlays (Slack, VS Code, Linear, Notion, Raycast) | LOW | Global keydown listener in Layout.jsx |
| Instant overlay from any page | Search must be accessible everywhere without navigation | LOW | Portal-mounted component in Layout.jsx |
| Categorized results | Results grouped by source type (Brain, Memory, Apps, History, Health) | MEDIUM | Fan-out to multiple search functions, tag results with source |
| Deep-link to source | Clicking a result navigates to the exact item (brain capture, agent run, history entry) | MEDIUM | Each data source needs a canonical URL; most already have linkable routes |
| Debounced type-ahead (200ms) | Without debounce, every keystroke fires a search; with too much delay, feels laggy | LOW | Standard `useDebounce` hook |
| Escape to close | Universal overlay dismiss convention | LOW | Keyboard event handler |
| Result snippets with highlighted match | Users need to see why a result matched, not just the title | MEDIUM | Return match context from search, highlight query terms in UI |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Recent searches / history | "I searched for this yesterday" -- reduces re-typing | LOW | localStorage array of last N queries |
| Keyboard navigation (arrow keys + Enter) | Power users expect to never touch the mouse | MEDIUM | Focus management, active index state |
| Source-type filtering | "Search only in Brain" or "Search only Health" -- scope narrows results | MEDIUM | Filter chips or prefix syntax (e.g., `brain: meditation`) |
| Result ranking with source-type boosting | Brain captures and apps rank higher than old history entries for most queries | MEDIUM | Configurable weight per source type in search aggregator |
| Quick actions in results | "Restart app X" or "Open agent Y" directly from search results | HIGH | Requires action registry per result type; defer to v2 |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Semantic / vector search in Cmd+K v1 | "Keyword search misses meaning" | Existing vector+BM25 hybrid is only built for Memory system; extending to all data sources requires embedding every data type; large scope increase | Ship keyword-first (already decided in PROJECT.md); semantic can layer on later using existing vector infra |
| Fuzzy matching everything | "Find even with typos" | Fuzzy across 10+ data sources with different schemas is complex; false positives degrade trust | Exact substring match + case-insensitive is sufficient for v1; add fuzzy for app names only |
| Client-side indexing (Lunr, MiniSearch) | "Avoid server round-trips" | Data lives server-side in JSON files; duplicating to client creates stale data and memory bloat on mobile | Server-side search with fast response time (<200ms target) |
| Natural language queries | "Show me what I captured about meditation last week" | Requires NLP date parsing, intent classification -- this is a full search product | Keyword search with date range filter is 80/20 |
| Indexing external content (web bookmarks, emails) | "Search everything I've ever seen" | Scope explosion; each external source needs its own ingestion pipeline | PortOS searches PortOS data; external ingestion is a separate feature |

---

## 5. Genome/Epigenetic Migration Cleanup (M44 P6)

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Fix route comments referencing old paths | Comments still say `/api/digital-twin/genome/`; these mislead developers | LOW | Find-and-replace in route files |
| Fix IdentityTab Genome card link | Card links to `/digital-twin/genome` which no longer exists; should link to `/meatspace/genome` or be removed | LOW | Update href or remove the card |
| Verify no other stale references | Other UI components or services may still reference old genome routes | LOW | Grep for `digital-twin/genome` across codebase |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Redirect from old route to new | If anyone bookmarked the old URL, redirect gracefully | LOW | Express redirect middleware |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Duplicate genome data in both locations | "Keep backward compatibility" | Two sources of truth; data drift guaranteed | Single canonical location in MeatSpace |

---

## Feature Dependencies

```
M44 P6 (Genome Cleanup)
    └──enables──> M42 P5 (Cross-Insights Engine)
                      genome routes must be correct for insight engine to read genome data

M44 P7 (Apple Health Integration)
    └──enhances──> M42 P5 (Cross-Insights Engine)
                       health data enables genome-to-health correlations (HRV vs APOE, etc.)

M45 (Data Backup)
    └──protects──> ALL features
                       zero redundancy means backup should ship before or alongside new data writers

M46 (Unified Search)
    └──requires──> existing search infrastructure (BM25 in memory system)
    └──enhanced-by──> M44 P7 (more data sources to search)
    └──enhanced-by──> M42 P5 (insights become searchable)

M42 P5 (Cross-Insights Engine)
    └──requires──> M44 P6 (clean genome routes)
    └──enhanced-by──> M44 P7 (Apple Health data for health correlations)
    └──uses──> existing identity.js, genome.js, taste-questionnaire.js
```

### Dependency Notes

- **M44 P6 before M42 P5:** Cross-Insights Engine reads genome data through genome.js; if route comments and IdentityTab still reference old paths, there is confusion about the canonical data location. Clean this up first.
- **M45 independent but urgent:** Backup has no technical dependencies on other features, but its risk-reduction value means it should ship early. New data writers (M44 P7 health data) increase the blast radius of data loss.
- **M44 P7 enhances M42 P5:** The most compelling cross-insights are genome-to-health correlations (e.g., APOE genotype vs. cardiovascular metrics from Apple Health). M42 P5 can ship with genome+taste insights first, then add health correlations when M44 P7 lands.
- **M46 is additive:** Search works over whatever data exists at the time. It can ship at any point and gains value as more data sources are added.

---

## MVP Definition

### Launch With (v1 of each milestone)

- [ ] **M44 P6:** Fix all stale genome route references and IdentityTab card -- 1-2 hours of cleanup
- [ ] **M45:** Incremental backup with mtime comparison, SHA-256 manifest, configurable target path, daily schedule via existing scheduler, manual trigger button, green/yellow/red health widget
- [ ] **M44 P7:** POST /api/health/ingest for Health Auto Export JSON, Zod validation, dedup by metric+timestamp, day-partitioned storage, basic dashboard cards for steps/heart rate/sleep
- [ ] **M42 P5:** Genome-to-health rule engine (map curated markers to recommendations), taste-to-identity LLM summarization, insight persistence to JSON, provenance citations
- [ ] **M46:** Cmd+K overlay, server-side fan-out search across brain/memory/apps/history, categorized results with source icons, debounced input, deep-link navigation, Escape to close

### Add After Validation (v1.x)

- [ ] **M45:** Dry-run restore preview, per-directory selective restore, backup size trending
- [ ] **M44 P7:** Bulk XML import with WebSocket progress, metric category browser, health-to-MeatSpace correlation overlay charts
- [ ] **M42 P5:** Contradiction detection (genome vs. behavior), LLM narrative summaries, confidence scoring
- [ ] **M46:** Recent search history, keyboard navigation (arrows + Enter), source-type filter chips, result ranking with configurable boosts

### Future Consideration (v2+)

- [ ] **M44 P7:** Workout GPS route maps, support for additional health platforms
- [ ] **M42 P5:** Temporal insight evolution (track changes over time), health-genome action items with recommendation templates
- [ ] **M46:** Semantic search extension (extend existing vector+BM25 to all data sources), quick actions from search results, natural language date queries

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| M44 P6: Genome route cleanup | LOW (housekeeping) | LOW | P1 -- do first, unblocks M42 P5 |
| M45: Incremental backup + manifest | HIGH (data protection) | MEDIUM | P1 -- risk reduction for all data |
| M45: Dashboard health widget | MEDIUM | LOW | P1 -- visibility into backup status |
| M45: Dry-run restore | MEDIUM | MEDIUM | P2 -- ship after backup works |
| M44 P7: Health ingest endpoint | HIGH | MEDIUM | P1 -- enables Apple Health data flow |
| M44 P7: Day-partitioned storage + dedup | HIGH | MEDIUM | P1 -- required for ingest to be useful |
| M44 P7: Bulk XML import | MEDIUM | HIGH | P2 -- historical data is valuable but complex |
| M44 P7: Basic health dashboard cards | HIGH | MEDIUM | P1 -- visualization makes data actionable |
| M42 P5: Genome-to-health rules | HIGH | MEDIUM | P1 -- core value proposition of cross-insights |
| M42 P5: Taste-to-identity themes | MEDIUM | MEDIUM | P1 -- completes the identity picture |
| M42 P5: LLM narrative summaries | MEDIUM | MEDIUM | P2 -- compelling but not essential for v1 |
| M42 P5: Contradiction detection | MEDIUM | MEDIUM | P2 -- interesting differentiator |
| M46: Cmd+K overlay + fan-out search | HIGH | MEDIUM | P1 -- immediate cross-cutting utility |
| M46: Keyboard navigation | MEDIUM | MEDIUM | P2 -- power user feature |
| M46: Source-type filtering | MEDIUM | MEDIUM | P2 -- useful once result volume grows |
| M46: Semantic search extension | MEDIUM | HIGH | P3 -- existing keyword search is sufficient for v1 |

**Priority key:**
- P1: Must have for launch
- P2: Should have, add when possible
- P3: Nice to have, future consideration

---

## Competitor Feature Analysis

These are not direct competitors but reference implementations in each domain.

| Feature Area | Reference Products | How They Do It | PortOS Approach |
|---------|--------------|--------------|--------------|
| JSON backup | Obsidian Sync, Logseq Git | Obsidian uses proprietary sync service; Logseq uses git auto-commit | File-level incremental copy with checksums; simpler and more transparent |
| Apple Health integration | Exist.co, Gyroscope, Health Mate | Cloud services with OAuth to HealthKit; require account creation | Health Auto Export app as bridge; no cloud dependency; data stays local |
| Cross-domain insights | Exist.co (mood+activity), Gyroscope (health+productivity) | Correlation dashboards with fixed insight types | LLM-powered insight generation; genome data is a unique dimension no competitor has |
| Cmd+K search | Raycast, Alfred, Notion, Linear | Client-side indexing (Raycast/Alfred); server-side fan-out (Notion/Linear) | Server-side fan-out matching Linear/Notion pattern; data lives server-side so this is the natural fit |
| Genome+health correlation | Promethease, SelfDecode, Nebula | Proprietary databases of SNP-phenotype associations; subscription model | Curated 117 markers with open ClinVar references; correlate with actual health data from Apple Health rather than just genetic risk scores |

---

## Sources

- PortOS codebase: `server/services/memoryBM25.js` (existing BM25 search infrastructure), `server/services/genome.js` (117 curated markers), `server/services/identity.js` (chronotype derivation, longevity markers), `ecosystem.config.cjs` (port allocation)
- PLAN.md: Detailed specs for M44 P7, M45, M46
- PROJECT.md: Scope boundaries, constraints, existing infrastructure
- Health Auto Export app: [App Store listing](https://apps.apple.com/us/app/health-auto-export-json-csv/id1115567069), [GitHub reference server](https://github.com/HealthyApps/health-auto-export-server)
- Apple Health XML export: [apple-health-parser reference](https://github.com/cvyl/apple-health-parser)
- Cmd+K patterns: Observed in Raycast, VS Code, Linear, Notion, Slack -- universal convention
- JSON backup patterns: rsync incremental, Time Machine snapshot model, Obsidian Sync

---
*Feature research for: PortOS next actions batch (M44 P6/P7, M42 P5, M45, M46)*
*Researched: 2026-02-26*
