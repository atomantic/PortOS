# Architecture Research

**Domain:** Monorepo feature integration (backup, health ingest, cross-domain insights, unified search) into Express.js + React + PM2 + JSON file architecture
**Researched:** 2026-02-26
**Confidence:** HIGH — all five features follow well-established patterns and align with the existing PortOS architecture

## System Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            Client (React/Vite :5555)                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │  Cmd+K       │  │  MeatSpace   │  │  Insights    │  │  Backup        │  │
│  │  Overlay     │  │  Health Tab  │  │  Page/Panel  │  │  Status Widget │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘  │
│         │ HTTP/WS          │ HTTP             │ HTTP             │ HTTP      │
├─────────┴──────────────────┴─────────────────┴──────────────────┴───────────┤
│                       Express API Server (:5554)                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │  /api/search │  │  /api/       │  │  /api/       │  │  /api/backup   │  │
│  │  (fan-out)   │  │  meatspace/  │  │  insights    │  │  (CRUD +       │  │
│  │              │  │  health      │  │  (read-only) │  │   trigger)     │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                  │                  │                   │          │
│  ┌──────┴───────┐  ┌──────┴───────┐  ┌──────┴───────┐  ┌───────┴────────┐  │
│  │  searchSvc   │  │  appleHealth │  │  insightsSvc │  │  backupSvc     │  │
│  │  (aggregator)│  │  Svc (parse  │  │  (correlate  │  │  (scheduler +  │  │
│  │              │  │  + store)    │  │  + derive)   │  │   rsync/cp)    │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                  │                  │                   │          │
├─────────┴──────────────────┴─────────────────┴──────────────────┴───────────┤
│                         Data Layer (./data/)                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ brain/   │  │ meatspace│  │ digital- │  │ cos/     │  │ External     │  │
│  │ memory/  │  │ /health/ │  │ twin/    │  │ agents/  │  │ Drive Mount  │  │
│  │ apps.json│  │ genome/  │  │          │  │ runs/    │  │              │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Component Boundaries

### New Components

| Component | Responsibility | Communicates With | Files |
|-----------|---------------|-------------------|-------|
| **Backup Service** | Schedule and execute incremental backup of `./data/` to external drive; track run history and status | fileUtils, PM2 ecosystem (optional cron), Socket.IO for status | `server/services/backup.js`, `server/routes/backup.js` |
| **Apple Health Ingest** | Accept POST with XML body from Health Auto Export app; stream-parse Apple Health XML; normalize and persist to JSON | meatspace data files, Zod validation, meatspaceHealth service | `server/services/appleHealth.js`, `server/routes/appleHealth.js` (or nested under meatspace routes) |
| **Cross-Insights Engine** | Read from genome, health, taste, personality, and body data; compute derived correlations; cache results | genome service, digital-twin service, meatspace services, taste-questionnaire service (read-only consumers) | `server/services/insights.js`, `server/routes/insights.js` |
| **Unified Search API** | Receive query, fan out to domain-specific search functions, merge and rank results, return unified response | memory service (BM25 + vector), brain service, genome service, apps service, history service, digital-twin service, meatspace services | `server/services/search.js`, `server/routes/search.js` |
| **Cmd+K Overlay** | Client-side keyboard-triggered modal; debounced input; call unified search API; render categorized results with navigation | `services/api.js` (HTTP), React Router (for navigation to results) | `client/src/components/CommandPalette.jsx`, `client/src/hooks/useCommandPalette.js` |

### Existing Components Touched

| Component | Change | Impact |
|-----------|--------|--------|
| `server/index.js` | Mount 3-4 new route files | Minimal — follows existing import + `app.use()` pattern |
| `client/src/components/Layout.jsx` | Render `<CommandPalette />` as a sibling to `<Outlet />` | Minimal — one component addition, global keyboard listener |
| `server/lib/fileUtils.js` | No changes needed — `PATHS.meatspace` already exists | None |
| `server/lib/meatspaceValidation.js` | Add Zod schemas for Apple Health ingest payloads | Additive |
| `ecosystem.config.cjs` | No new ports needed — all features run within the existing Express server process | None |
| MeatSpace routes/services | Add health sub-routes or a sibling route file for Apple Health | Additive |

## Data Flow

### 1. Backup Flow

```
Timer/Manual Trigger
    ↓
backupService.runBackup()
    ↓
rsync ./data/ → /Volumes/[external-drive]/portos-backup/
    ↓
Record result to data/backup-history.json
    ↓
Socket.IO emit('backup:status', { ... })
    ↓
Client backup widget updates
```

**Key decisions:**
- Use `rsync --archive --delete --exclude` (or `cp -a` as fallback) for incremental copy. rsync is already available on macOS.
- Scheduler uses the same `setInterval` + time-check pattern as `brainScheduler.js` — not a new PM2 process, not node-cron. This keeps consistency with existing scheduling patterns (brainScheduler checks every 60s against a target time).
- Backup state (last run, next scheduled, history) persists to `data/backup-history.json`.
- Mount path for external drive is stored in a config file (`data/backup-config.json`) — user configures once.

### 2. Apple Health Ingest Flow

```
Health Auto Export App (HTTP POST)
    ↓
POST /api/meatspace/health/import
    ↓
Zod validates wrapper (metadata, content-type)
    ↓
appleHealthService.ingestXML(xmlBuffer)
    ↓
sax/expat stream parser (NOT full DOM parse — files can be 500MB+)
    ↓
Normalize records → { type, date, value, unit, source }
    ↓
Batch-write to data/meatspace/health/{type}.json
    ↓
Return import stats { imported: N, skipped: N, errors: N }
```

**Key decisions:**
- Stream parsing is essential. Apple Health XML exports are regularly 200-500MB. A DOM parser would OOM the 500MB memory limit on portos-server. Use `sax` (event-based XML parser, zero dependencies, 15+ years mature) or `@oozcitak/saxes` (maintained fork).
- Split ingested data by record type (e.g., `heart-rate.json`, `steps.json`, `weight.json`, `sleep.json`) rather than one giant file. This matches the existing meatspace pattern of domain-specific JSON files.
- Deduplication by `(type, date, source)` composite key — Apple Health exports contain historical data on every export.
- Express already has `express.json({ limit: '50mb' })` and `express.urlencoded({ limit: '50mb' })` configured. For raw XML, add `express.raw({ type: 'application/xml', limit: '600mb' })` on the specific route, or accept base64-encoded XML inside a JSON POST (matching the existing TSV import pattern).
- Alternatively, accept the XML as multipart upload via the existing `uploads` infrastructure.

### 3. Cross-Insights Engine Flow

```
GET /api/insights (or GET /api/insights/:domain)
    ↓
insightsService.computeInsights()
    ↓
Read (parallel):
  ├── genome service → SNP markers, longevity
  ├── meatspace services → blood, body, alcohol, lifestyle
  ├── digital-twin → taste, personality traits, soul profile
  └── (future) apple health → heart rate trends, sleep patterns
    ↓
Correlation rules (declarative):
  genome(APOE ε4) + blood(LDL) → cardiovascular risk insight
  genome(CYP1A2) + lifestyle(caffeine) → caffeine sensitivity insight
  taste(flavor profiles) + personality(openness) → identity theme insight
  body(BMI trend) + lifestyle(exercise) → fitness trajectory insight
    ↓
Cache in data/insights-cache.json (TTL: 1 hour)
    ↓
Return { insights: [...], generatedAt, domains }
```

**Key decisions:**
- Insights are computed on-demand (not scheduled) because the underlying data changes infrequently. A 1-hour TTL cache avoids repeated computation.
- Correlation rules are declarative data structures (not hardcoded if/else chains). Each rule specifies: `{ id, name, domains: ['genome', 'blood'], condition: fn, compute: fn, category }`. This makes it easy to add new correlations without touching engine logic.
- The engine is read-only — it never writes to source domains. It only reads from existing service exports.
- Start with genome-to-health and taste-to-identity correlations (user's stated priority), then expand the rule set.
- No AI provider needed for initial insights — these are deterministic rule-based correlations. AI-powered narrative summaries can layer on later.

### 4. Unified Search Flow

```
Client: Cmd+K input → debounce 300ms → GET /api/search?q=...&limit=20
    ↓
searchService.search(query, options)
    ↓
Fan-out (parallel):
  ├── brain: capturedThoughts.filter(match) → { type: 'thought', ... }
  ├── memory: BM25 search (existing memoryBM25.js) → { type: 'memory', ... }
  ├── apps: apps.json name/description match → { type: 'app', ... }
  ├── history: activity log keyword match → { type: 'activity', ... }
  ├── digital-twin: document content match → { type: 'document', ... }
  ├── genome: SNP rsid match → { type: 'snp', ... }
  ├── agents: personality name/description match → { type: 'agent', ... }
  └── meatspace: health record label match → { type: 'health', ... }
    ↓
Merge results, assign category, sort by relevance score
    ↓
Return { results: [{ type, title, snippet, url, score }], timing }
```

**Key decisions:**
- Keyword-first (project constraint: semantic search is out of scope for v1). Each domain adapter does simple string matching or delegates to existing search (memory already has BM25).
- Fan-out is `Promise.allSettled()` — a failing domain must not break the entire search. Failed domains return empty results with a warning.
- Each domain adapter is a small function: `(query, limit) => [{ type, title, snippet, url, score }]`. This is the interface contract.
- Results include a `url` field (React Router path) so the Cmd+K overlay can navigate directly: e.g., `/brain/inbox`, `/meatspace/genome`, `/apps`.
- Response includes `timing` object so the UI can show "Searched 8 domains in 45ms".

### 5. Cmd+K Overlay Flow

```
User presses Cmd+K (or Ctrl+K)
    ↓
CommandPalette opens (modal overlay, z-50)
    ↓
User types query → debounce 300ms → api.get('/api/search?q=...')
    ↓
Results render in categories:
  🧠 Thoughts (2)    📱 Apps (1)    🧬 Genome (1)    ...
    ↓
Arrow keys navigate, Enter activates
    ↓
React Router navigate(result.url)
    ↓
CommandPalette closes
```

**Key decisions:**
- Global keyboard listener in `useCommandPalette.js` hook, rendered via `CommandPalette.jsx` inside `Layout.jsx` — wraps `<Outlet />`.
- No external dependency (cmdk, kbar). The component is straightforward: input + list + keyboard nav. External libraries add bundle weight for minimal gain in a single-user app.
- Empty state shows recent navigation or suggested actions (not blank).
- Escape closes. Clicking outside closes. Focus traps inside while open.

## Patterns to Follow

### Pattern 1: Service-per-Domain with Route Mounting

**What:** Each new feature gets its own service file and route file, mounted in `server/index.js`.
**When:** Always — this is the universal pattern in PortOS.
**Trade-offs:** More files, but clear boundaries. Every feature has exactly two touchpoints in `index.js` (import + mount).

```javascript
// server/index.js additions:
import backupRoutes from './routes/backup.js';
import insightsRoutes from './routes/insights.js';
import searchRoutes from './routes/search.js';

app.use('/api/backup', backupRoutes);
app.use('/api/insights', insightsRoutes);
app.use('/api/search', searchRoutes);

// Apple Health routes nest under existing meatspace mount:
// server/routes/meatspace.js — add health import routes
// OR mount separately: app.use('/api/meatspace/health', appleHealthRoutes);
```

### Pattern 2: Interval Scheduler (brainScheduler Pattern)

**What:** Use `setInterval` with a 60-second check loop that compares current time to target schedule. No cron dependency.
**When:** Backup scheduling.
**Trade-offs:** 60-second granularity (fine for daily backups). Avoids adding node-cron dependency. Consistent with brainScheduler.js which already does daily + weekly scheduling.

```javascript
// Same pattern as brainScheduler.js
const CHECK_INTERVAL_MS = 60000;
let schedulerInterval = null;

export function startBackupScheduler() {
  schedulerInterval = setInterval(checkSchedule, CHECK_INTERVAL_MS);
  console.log('💾 Backup scheduler started');
}
```

### Pattern 3: Aggregator Service (Fan-out + Merge)

**What:** A service that calls multiple other services in parallel and merges results.
**When:** Unified search and cross-insights engine.
**Trade-offs:** Creates a dependency on multiple services, but only read dependencies. Using `Promise.allSettled` ensures resilience.

```javascript
// server/services/search.js
const adapters = [
  { domain: 'brain', search: searchBrain },
  { domain: 'memory', search: searchMemory },
  { domain: 'apps', search: searchApps },
  // ...
];

export async function search(query, options = {}) {
  const results = await Promise.allSettled(
    adapters.map(a => a.search(query, options.limit))
  );
  // Merge fulfilled results, log rejected
  return mergeResults(results, adapters);
}
```

## Anti-Patterns to Avoid

### Anti-Pattern 1: DOM-Parsing Large XML

**What people do:** Use `DOMParser` or `xml2js` to parse the entire Apple Health XML into memory.
**Why it's wrong:** Apple Health exports are 200-500MB. Full DOM parse will exceed the 500MB memory limit and crash the process.
**Do this instead:** Use SAX/event-based streaming parser. Process records one at a time, write in batches.

### Anti-Pattern 2: Monolithic Search Function

**What people do:** Write one giant function that knows how to search every domain.
**Why it's wrong:** Tightly couples search to every data model. Adding a new searchable domain requires modifying the core function.
**Do this instead:** Use adapter pattern. Each domain registers a `(query, limit) => results[]` function. The search service only knows the adapter interface.

### Anti-Pattern 3: Synchronous Backup Blocking Server

**What people do:** Run rsync synchronously or await the entire copy in the request handler.
**Why it's wrong:** Backup can take minutes. Blocks the Express event loop or times out the HTTP request.
**Do this instead:** Spawn rsync as a child process. Return immediately with a job ID. Report progress via Socket.IO events.

### Anti-Pattern 4: Circular Service Dependencies in Insights

**What people do:** Have the insights service import from and write back to source services.
**Why it's wrong:** Creates bidirectional coupling. Source services should not know about insights.
**Do this instead:** Insights engine is strictly read-only. It imports from source services but never writes to them. Insights cache is its own data file.

## Integration Points

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Search API ↔ Domain Services | Direct function import (in-process) | Each adapter imports the relevant service. No HTTP between them. |
| Backup Service ↔ File System | `child_process.spawn('rsync', [...])` | Async child process. Not blocking. |
| Apple Health Route ↔ appleHealth Service | Direct function call (standard route→service pattern) | XML parsing happens in service layer, not route. |
| Insights Engine ↔ Domain Services | Direct function import (read-only) | Insights never mutate source data. |
| Cmd+K ↔ Search API | HTTP GET `/api/search` | Standard client→API pattern via `services/api.js`. |
| Backup/Search ↔ Client | Socket.IO for real-time status | Backup progress events. Search uses HTTP (short-lived). |

### External Integrations

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| External Drive | Mount path in `data/backup-config.json` | User configures once. Service validates mount exists before backup. |
| Health Auto Export App | HTTP POST to `/api/meatspace/health/import` | Third-party iOS app sends XML via HTTP. PortOS is the server. |
| rsync | `child_process.spawn` | macOS built-in. No npm dependency needed. |
| SAX XML Parser | npm dependency (`sax` or `saxes`) | Only new npm dependency across all five features. |

## Build Order and Dependencies

The five features have the following dependency graph:

```
M44 P6 (Cleanup)          ← No dependencies, pure cleanup
    ↓
M45 (Backup)              ← No dependencies on other new features
                             CRITICAL: protects ./data/ before adding more data
    ↓
M44 P7 (Apple Health)     ← Depends on meatspace infrastructure (already exists)
                             Should happen after backup is in place
    ↓
M42 P5 (Cross-Insights)   ← Depends on genome + health + taste data existing
                             Benefits from Apple Health data being available
    ↓
M46 (Unified Search)      ← Benefits from all data sources existing
                             Depends on no specific feature but searches everything
```

### Suggested Build Order Rationale

1. **M44 P6 (Cleanup)** — First because it fixes existing technical debt before building on top. Zero risk, zero dependencies.

2. **M45 (Backup)** — Second because it protects the single copy of all data in `./data/`. Every subsequent feature adds more data. Having backup in place before adding Apple Health bulk imports and insights caches is prudent.

3. **M44 P7 (Apple Health)** — Third because it adds a new data source that enriches the insights engine. The meatspace infrastructure already exists (routes, services, validation). This is additive.

4. **M42 P5 (Cross-Insights)** — Fourth because it benefits from having both genome data (already present) and Apple Health data (just added) to correlate. Building it before Apple Health would mean fewer correlations to ship.

5. **M46 (Unified Search)** — Last because it benefits from all data sources existing. Each domain adapter is independent, so search can ship incrementally, but the experience is richest when all domains are populated.

**Parallelism opportunity:** M44 P6 (cleanup) and M45 (backup) have zero overlap and can be built simultaneously. M44 P7 and M42 P5 are also parallelizable if the insights engine starts with genome-only correlations and adds health correlations when available. M46 is naturally incremental (add adapters one at a time).

## Scaling Considerations

| Concern | Current Scale (Single User) | If Data Grows 10x |
|---------|----------------------------|--------------------|
| Search latency | Fan-out across 8 JSON files, <100ms total | Add BM25 indexes for large domains (brain, health). Memory BM25 already exists. |
| Apple Health ingest | Stream parse handles 500MB+ files | Already using streaming — no change needed |
| Backup duration | rsync incremental on ~10MB of JSON | rsync handles this natively. Only changed files copy. |
| Insights computation | Read 5-6 JSON files, apply rules, <50ms | Cache TTL already handles this. No change needed. |
| Search index staleness | Keyword search reads live data on each query | Add in-memory caches with short TTL (2-5s) matching existing `appsCache` pattern |

PortOS is single-user, so horizontal scaling is not a concern. The bottleneck sequence is: (1) Apple Health file size during ingest, (2) search fan-out latency if data files grow very large. Both are addressed by the streaming and caching patterns already described.

## Sources

- PortOS codebase analysis: `server/index.js`, `ecosystem.config.cjs`, `server/services/brainScheduler.js`, `server/lib/bm25.js`, `server/services/memoryBM25.js` — HIGH confidence (direct code inspection)
- PortOS architecture docs: `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/STRUCTURE.md` — HIGH confidence
- SAX XML parsing: established Node.js pattern for large XML processing — HIGH confidence (training data + long-standing community practice)
- rsync incremental backup: macOS built-in utility, well-documented — HIGH confidence

---
*Architecture research for: PortOS next actions batch*
*Researched: 2026-02-26*
