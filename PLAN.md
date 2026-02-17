# Port OS - Implementation Plan

## Quick Reference

### Tech Stack
- Frontend: React + Tailwind CSS + Vite (port 5555)
- Backend: Express.js (port 5554)
- Process Manager: PM2
- Data Storage: JSON files in `./data/`

### Commands
```bash
# Install all dependencies
npm run install:all

# Start development (both client and server)
npm run dev

# Start with PM2
pm2 start ecosystem.config.cjs

# View PM2 logs
pm2 logs
```

---

## Milestones

### Completed

- [x] **M0-M3**: Bootstrap, app registry, PM2 integration, log viewer - Core infrastructure
- [x] **M4**: App Wizard - Register existing apps or create from templates. See [App Wizard](./docs/features/app-wizard.md)
- [x] **M5**: AI Providers - Multi-provider AI execution with headless Claude CLI
- [x] **M6**: Dev Tools - Command runner with history and execution tracking
- [x] **M8**: Prompt Manager - Customizable AI prompts with variables and stages. See [Prompt Manager](./docs/features/prompt-manager.md)
- [x] **M9**: Streaming Import - Real-time websocket updates during app detection
- [x] **M10**: Enhanced DevTools - Provider/model selection, screenshots, git status, usage metrics
- [x] **M11**: AI Agents Page - Process detection and management with colorful UI
- [x] **M12**: History Improvements - Expandable entries with runtime/output capture
- [x] **M13**: Autofixer - Autonomous crash detection and repair. See [Autofixer](./docs/features/autofixer.md)
- [x] **M14**: Chief of Staff - Autonomous agent manager with task orchestration. See [Chief of Staff](./docs/features/chief-of-staff.md)
- [x] **M15**: Error Handling - Graceful error handling with auto-fix. See [Error Handling](./docs/features/error-handling.md)
- [x] **M16**: Memory System - Semantic memory with LLM classification. See [Memory System](./docs/features/memory-system.md)
- [x] **M17**: PM2 Config Enhancement - Per-process port detection and CDP_PORT support
- [x] **M18**: PM2 Standardization - LLM-powered config refactoring
- [x] **M19**: CoS Agent Runner - Isolated PM2 process for agent spawning. See [CoS Agent Runner](./docs/features/cos-agent-runner.md)
- [x] **M20**: AI Error Handling - Enhanced error extraction and CoS integration
- [x] **M21**: Usage Metrics - Comprehensive AI usage tracking and mobile UI
- [x] **M22**: Orphan Auto-Retry - Automatic retry for orphaned agents
- [x] **M23**: Self-Improvement - Automated UI/security/code analysis with Playwright
- [x] **M24**: Goal-Driven Mode - COS-GOALS.md mission file and always-working behavior
- [x] **M25**: Task Learning - Completion tracking and success rate analysis
- [x] **M26**: Scheduled Scripts - Cron-based automation with agent triggering
- [x] **M27**: CoS Capability Enhancements - Dependency updates, performance tracking, learning insights
- [x] **M28**: Weekly Digest UI - Visual digest with insights and comparisons
- [x] **M29**: App Improvement - Comprehensive analysis extended to managed apps
- [x] **M30**: Configurable Intervals - Per-task-type scheduling (daily, weekly, once, on-demand)
- [x] **M31**: LLM Memory Classification - Intelligent memory extraction with quality filtering
- [x] **M32**: Brain System - Second-brain capture and classification. See [Brain System](./docs/features/brain-system.md)
- [x] **M33**: Soul System - Digital twin identity scaffold management. See [Soul System](./docs/features/soul-system.md)
- [x] **M34 P1-P2,P4**: Digital Twin - Quantitative personality modeling and confidence scoring. See [Digital Twin](./docs/features/digital-twin.md)
- [x] **M35**: Chief of Staff Enhancement - Proactive autonomous agent with hybrid memory, missions, LM Studio, thinking levels. See [CoS Enhancement](./docs/features/cos-enhancement.md)
- [x] **M35.1**: CoS UI - Added Arcane Sigil (3D) avatar style option alongside Cyberpunk 3D
- [x] **M36**: Browser Management - CDP/Playwright browser page with status, controls, config, and logs
- [x] **M37**: Autonomous Jobs - Recurring scheduled jobs that the CoS executes proactively using digital twin identity
- [x] **M38**: Agent Tools - AI content generation, feed browsing, and autonomous engagement for Moltbook agents
- [x] **M39**: Agent-Centric Drill-Down - Redesigned Agents section with agent-first hierarchy, deep-linkable URLs, and scoped sub-tabs
- [x] **M41**: CyberCity Immersive Overhaul - Procedural synthwave audio, enhanced post-processing (chromatic aberration, film grain, color grading), reflective wet-street ground, settings system, and atmosphere enhancements
- [x] **M43**: Moltworld Platform Support - Second platform integration for AI agents in a shared voxel world with movement, building, thinking, messaging, and SIM token economy

### Planned

- [ ] **M7**: App Templates - Template management and app scaffolding from templates
- [ ] **M34 P3,P5-P7**: Digital Twin - Behavioral feedback loop, multi-modal capture, advanced testing, personas
- [ ] **M40**: Agent Skill System - Task-type-specific prompt templates with routing logic, negative examples, and embedded workflows for improved agent accuracy and reliability
- [ ] **M42**: Unified Digital Twin Identity System - Connect Genome (117 markers, 32 categories), Chronotype (5 sleep markers + behavioral), Aesthetic Taste (P2 complete, P2.5 adds twin-aware prompting), and Mortality-Aware Goals into a single coherent Identity architecture with cross-insights engine
- [ ] **M44**: Pump.fun Launch Tracking Engine - Real-time pump.fun token detection via Helius webhooks, token enrichment via Birdeye, sniper account tracking, and launch analytics dashboard

---

## M44: Pump.fun Launch Tracking Engine

### Motivation

The Solana memecoin ecosystem on pump.fun generates thousands of token launches daily. A small percentage become high-performers (10x+ returns). Sniper accounts — wallets that consistently buy into winning tokens within seconds of launch — represent a detectable signal for launch quality. This engine detects new launches in real-time, tracks token performance, inventories sniper accounts, and builds a data foundation for predicting upcoming high-performing launches.

**Brain Project**: 467fbe07 — research complete (see `docs/research/pumpfun-data-sources.md`)

### Data Source Selection

| Source | Role | Tier | Cost/mo |
|--------|------|------|---------|
| **Helius** | Primary: real-time token detection, transaction monitoring | Developer | $49 |
| **Birdeye** | Enrichment: market cap, volume, security scores, OHLCV | Starter | $99 |
| **pump.fun Direct** | Supplement: creator metadata (sparingly, no SLA) | Free | $0 |

**Total**: $148/mo for Phase 1+2

### Data Model

All data persists to `data/pumpfun/` following PortOS conventions (entity stores with `records` keyed by ID, JSONL for append-heavy logs, 2s cache TTL).

#### `data/pumpfun/meta.json` — Configuration

```json
{
  "version": "1.0.0",
  "helius": {
    "apiKey": null,
    "webhookId": null,
    "webhookUrl": null,
    "programId": "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    "tier": "developer",
    "rpsLimit": 10
  },
  "birdeye": {
    "apiKey": null,
    "tier": "starter",
    "rpsLimit": 15
  },
  "tracking": {
    "enabled": false,
    "enrichmentIntervalMs": 60000,
    "snapshotIntervalMs": 300000,
    "retentionDays": 90,
    "autoEnrich": true
  },
  "filters": {
    "minHolders": 10,
    "minVolume24h": 1000,
    "minLiquiditySol": 5,
    "excludeRugPull": true
  },
  "alerts": {
    "volumeSpikeThreshold": 5,
    "holderSpikeThreshold": 3,
    "sniperOverlapThreshold": 3
  }
}
```

#### `data/pumpfun/tokens.json` — Tracked Tokens (Entity Store)

```json
{
  "records": {
    "TokenMintAddress44chars": {
      "mint": "TokenMintAddress44chars",
      "symbol": "PUMP",
      "name": "Pump Token",
      "creator": "CreatorWalletAddress",
      "launchSignature": "txSignature",
      "launchSlot": 123456789,
      "launchAt": "2026-02-17T12:00:00.000Z",
      "bondingCurve": {
        "address": "BondingCurveAccountAddress",
        "graduated": false,
        "graduatedAt": null
      },
      "status": "active",
      "performance": {
        "athMultiple": null,
        "athPrice": null,
        "athAt": null,
        "currentPrice": null,
        "priceAtLaunch": null
      },
      "metrics": {
        "holders": 0,
        "volume24h": 0,
        "marketCap": 0,
        "liquidity": 0,
        "securityScore": null
      },
      "snipers": [],
      "tags": [],
      "enrichedAt": null,
      "createdAt": "2026-02-17T12:00:00.000Z",
      "updatedAt": "2026-02-17T12:00:00.000Z"
    }
  }
}
```

Key: mint address (not UUID) since tokens are uniquely identified by their on-chain mint.

#### `data/pumpfun/snipers.json` — Sniper Account Inventory (Entity Store)

```json
{
  "records": {
    "WalletAddress": {
      "wallet": "WalletAddress",
      "label": null,
      "stats": {
        "totalSnipes": 0,
        "successRate": 0,
        "avgEntryDelaySec": 0,
        "avgReturnMultiple": 0,
        "bestReturn": null,
        "worstReturn": null,
        "activeSince": null
      },
      "recentTokens": [],
      "reputation": "unknown",
      "tags": [],
      "createdAt": "2026-02-17T12:00:00.000Z",
      "updatedAt": "2026-02-17T12:00:00.000Z"
    }
  }
}
```

Reputation levels: `unknown` → `newcomer` → `consistent` → `elite` (based on success rate + volume).

#### `data/pumpfun/events.jsonl` — Trade & Price Events (Append Log)

```jsonl
{"id":"evt-uuid","mint":"TokenMint","type":"launch","creator":"Wallet","signature":"txSig","slot":123456789,"timestamp":"2026-02-17T12:00:00.000Z"}
{"id":"evt-uuid","mint":"TokenMint","type":"trade","side":"buy","wallet":"Wallet","amountSol":1.5,"amountTokens":1000000,"signature":"txSig","slot":123456790,"timestamp":"2026-02-17T12:00:01.000Z"}
{"id":"evt-uuid","mint":"TokenMint","type":"enrichment","holders":250,"volume24h":50000,"marketCap":120000,"liquidity":5000,"securityScore":85,"source":"birdeye","timestamp":"2026-02-17T12:01:00.000Z"}
{"id":"evt-uuid","mint":"TokenMint","type":"graduation","bondingCurve":"Address","signature":"txSig","timestamp":"2026-02-17T14:00:00.000Z"}
```

Event types: `launch`, `trade`, `enrichment`, `graduation`, `sniper_detected`, `alert`.

### MVP Architecture

```
                    ┌──────────────────────────────────┐
                    │         Helius Webhooks           │
                    │  (pump.fun program monitoring)    │
                    └──────────────┬───────────────────┘
                                   │
                          POST /api/pumpfun/webhook
                          (new token + trade events)
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────┐
│                    PortOS Server                              │
│                                                              │
│  ┌─────────────────┐   ┌──────────────────┐                 │
│  │  Webhook Route   │──▶│  PumpFun Service  │                │
│  │  (validates +    │   │  - detectToken()  │                │
│  │   parses events) │   │  - recordTrade()  │                │
│  └─────────────────┘   │  - detectSniper() │                │
│                         │  - enrichToken()  │                │
│  ┌─────────────────┐   │  - getStats()     │                │
│  │  REST Routes     │──▶│  - alertCheck()   │                │
│  │  GET /tokens     │   └────────┬─────────┘                │
│  │  GET /snipers    │            │                           │
│  │  GET /stats      │            ▼                           │
│  └─────────────────┘   ┌──────────────────┐                 │
│                         │  Data Layer       │                │
│  ┌─────────────────┐   │  tokens.json      │                │
│  │  Enrichment      │   │  snipers.json     │                │
│  │  Scheduler       │──▶│  events.jsonl     │                │
│  │  (polls Birdeye  │   │  meta.json        │                │
│  │   for active     │   └──────────────────┘                │
│  │   tokens)        │                                        │
│  └─────────────────┘                                         │
│                                                              │
│  ┌─────────────────┐   ┌──────────────────┐                 │
│  │  Socket.IO       │──▶│  Client UI        │                │
│  │  pumpfun:token   │   │  /pumpfun         │                │
│  │  pumpfun:trade   │   │  /pumpfun/tokens  │                │
│  │  pumpfun:alert   │   │  /pumpfun/snipers │                │
│  └─────────────────┘   └──────────────────┘                 │
└──────────────────────────────────────────────────────────────┘
                                   │
                          Token enrichment
                          (market data, security)
                                   │
                                   ▼
                    ┌──────────────────────────────────┐
                    │         Birdeye REST API          │
                    │  token_overview, token_security,  │
                    │  OHLCV, price history             │
                    └──────────────────────────────────┘
```

### Implementation Phases

#### P1: Token Detection (Helius webhook receiver)
- Create `data/pumpfun/` directory with `meta.json`, `tokens.json`, `snipers.json`, `events.jsonl`
- Create `server/services/pumpfun.js` — core service with token detection, event logging, file I/O with caching
- Create `server/routes/pumpfun.js` — webhook endpoint (`POST /api/pumpfun/webhook`) + REST endpoints
- Add Zod schemas for webhook payload validation and API inputs in `server/lib/validation.js`
- Parse Helius enhanced transaction events: extract mint address, creator, initial supply from `TOKEN_MINT` type events where `source` is `PUMP_FUN`
- Persist detected tokens to `tokens.json`, log launch events to `events.jsonl`
- Mount routes in `server/index.js`
- Emit Socket.IO `pumpfun:token` events for real-time UI updates

#### P2: Token Enrichment (Birdeye integration)
- Add enrichment scheduler to `pumpfun.js` — polls Birdeye `/defi/token_overview` and `/defi/token_security` for active tokens
- Update token records with market cap, volume, holder count, security score, liquidity
- Track ATH (all-time high) price and multiple for each token
- Log enrichment snapshots to `events.jsonl` for historical tracking
- Detect bonding curve graduation events
- Filter out rug-pulls using Birdeye security endpoint (mint authority, freeze authority checks)

#### P3: Sniper Detection & Analytics
- Parse early buy transactions (within first 60s of launch) from Helius trade events
- Cross-reference buyer wallets across multiple launches to identify repeat snipers
- Build sniper reputation scores: success rate, avg entry delay, avg return multiple
- Track sniper overlap — when 3+ known snipers enter the same token, flag as high signal
- Create `/pumpfun/snipers` REST endpoint for sniper leaderboard data
- Emit `pumpfun:alert` Socket.IO events when sniper overlap threshold exceeded

#### P4: Dashboard UI
- Create `client/src/pages/PumpFun.jsx` — main page with tab navigation
- `/pumpfun/tokens` — live token feed with status, metrics, performance columns, sortable
- `/pumpfun/snipers` — sniper leaderboard with wallet, stats, recent tokens
- `/pumpfun/stats` — aggregate dashboard: launches/day, avg performer, top tokens, sniper activity
- `/pumpfun/settings` — API key management, filter config, alert thresholds
- Real-time updates via Socket.IO subscription
- Deep-linkable routes per CLAUDE.md conventions

### Files to Create

**New files:**
- `data/pumpfun/meta.json` — configuration
- `data/pumpfun/tokens.json` — token entity store
- `data/pumpfun/snipers.json` — sniper entity store
- `data/pumpfun/events.jsonl` — event log
- `server/services/pumpfun.js` — core service
- `server/routes/pumpfun.js` — API routes
- `client/src/pages/PumpFun.jsx` — dashboard page

**Modified files:**
- `server/lib/validation.js` — add pumpfun Zod schemas
- `server/index.js` — mount pumpfun routes
- `client/src/App.jsx` — add PumpFun route
- `client/src/components/Sidebar.jsx` — add PumpFun nav item

### Design Decisions

1. **Mint address as entity key** (not UUID) — tokens are uniquely identified by their on-chain mint address, avoiding a mapping layer
2. **Webhook-first** — push model from Helius eliminates polling overhead and gives ~1s detection latency
3. **Enrichment on schedule, not inline** — Birdeye calls happen on a timer (60s default) for active tokens rather than blocking the webhook handler
4. **JSONL for events** — trade/price events are high-volume, append-only; JSONL avoids rewriting large files
5. **Sniper detection is cross-launch** — individual trades are meaningless; the value is in correlating the same wallet appearing in multiple successful early entries
6. **No external DB** — consistent with PortOS's JSON file persistence pattern; suitable for the expected data volume (hundreds of tokens/day, not millions)
7. **Security filtering built-in** — Birdeye's token_security endpoint flags rug-pull indicators early, preventing noise in the tracking data

---

## M42: Unified Digital Twin Identity System

### Motivation

Four separate workstreams converge on the same vision: a personal digital twin that knows *who you are* biologically, temporally, aesthetically, and existentially. Today these live as disconnected features:

| Subsystem | Current State | Location |
|-----------|--------------|----------|
| **Genome** | Fully implemented: 23andMe upload, 117 curated SNP markers across 32 categories, ClinVar integration, epigenetic tracking | `server/services/genome.js`, `GenomeTab.jsx`, `data/digital-twin/genome.json` |
| **Chronotype** | Genetic data ready: 5 sleep/circadian markers (CLOCK rs1801260, DEC2 rs57875989, PER2 rs35333999, CRY1 rs2287161, MTNR1B rs10830963) + `daily_routines` enrichment category. Derivation service not yet built | `curatedGenomeMarkers.js` sleep category, `ENRICHMENT_CATEGORIES.daily_routines` |
| **Aesthetic Taste** | P2 complete: Taste questionnaire with 5 sections (movies, music, visual_art, architecture, food), conversational Q&A, AI summary generation. Enrichment categories also feed taste data from book/movie/music lists | `TasteTab.jsx`, `taste-questionnaire.js`, `data/digital-twin/taste-profile.json` |
| **Goal Tracking** | Partially exists: `COS-GOALS.md` for CoS missions, `TASKS.md` for user tasks, `EXISTENTIAL.md` soul doc | `data/COS-GOALS.md`, `data/TASKS.md`, `data/digital-twin/EXISTENTIAL.md` |

These should be unified under a single **Identity** architecture so the twin can reason across all dimensions (e.g., "your CLOCK gene says evening chronotype — schedule deep work after 8pm" or "given your longevity markers and age, here's how to prioritize your 10-year goals").

### Data Model

#### Entity: `identity.json` (new, top-level twin orchestration)

```json
{
  "version": "1.0.0",
  "createdAt": "2026-02-12T00:00:00.000Z",
  "updatedAt": "2026-02-12T00:00:00.000Z",
  "sections": {
    "genome": { "status": "active", "dataFile": "genome.json", "markerCount": 117, "categoryCount": 32, "lastScanAt": "..." },
    "chronotype": { "status": "active", "dataFile": "chronotype.json", "derivedFrom": ["genome:sleep", "enrichment:daily_routines"] },
    "aesthetics": { "status": "active", "dataFile": "aesthetics.json", "derivedFrom": ["enrichment:aesthetics", "enrichment:favorite_books", "enrichment:favorite_movies", "enrichment:music_taste"] },
    "goals": { "status": "active", "dataFile": "goals.json" }
  },
  "crossLinks": []
}
```

#### Entity: Chronotype Profile (`chronotype.json`)

Derived from genome sleep markers + daily_routines enrichment answers + user overrides.

```json
{
  "chronotype": "evening",
  "confidence": 0.75,
  "sources": {
    "genetic": {
      "clockGene": { "rsid": "rs1801260", "genotype": "T/C", "signal": "mild_evening" },
      "dec2": { "rsid": "rs57875989", "genotype": "G/G", "signal": "standard_sleep_need" },
      "per2": { "rsid": "rs35333999", "genotype": "C/C", "signal": "standard_circadian" },
      "cry1": { "rsid": "rs2287161", "genotype": "C/C", "signal": "standard_period" },
      "mtnr1b": { "rsid": "rs10830963", "genotype": "T/T", "signal": "normal_melatonin_receptor" }
    },
    "behavioral": {
      "preferredWakeTime": "08:30",
      "preferredSleepTime": "00:30",
      "peakFocusWindow": "20:00-02:00",
      "energyDipWindow": "14:00-16:00"
    }
  },
  "recommendations": {
    "deepWork": "20:00-02:00",
    "lightTasks": "09:00-12:00",
    "exercise": "17:00-19:00",
    "caffeineCutoff": "14:00"
  },
  "updatedAt": "2026-02-12T00:00:00.000Z"
}
```

**Derivation logic**: Five genome sleep markers provide the genetic baseline: CLOCK (evening preference), DEC2 (sleep duration need), PER2 (circadian period), CRY1 (delayed sleep phase), MTNR1B (melatonin receptor / nighttime glucose). The `daily_routines` enrichment answers provide behavioral confirmation. When genetic and behavioral signals agree, confidence is high. When they disagree, surface the conflict for user review. Caffeine cutoff cross-references caffeine metabolism markers (CYP1A2 rs762551, ADA rs73598374). MTNR1B status also informs late-eating recommendations.

#### Entity: Aesthetic Taste Profile (`aesthetics.json`)

Consolidates scattered aesthetic data into a structured profile.

```json
{
  "profile": {
    "visualStyle": [],
    "narrativePreferences": [],
    "musicProfile": [],
    "designPrinciples": [],
    "antiPatterns": []
  },
  "sources": {
    "enrichmentAnswers": { "aesthetics": "...", "questionsAnswered": 0 },
    "bookAnalysis": { "themes": [], "sourceDoc": "BOOKS.md" },
    "movieAnalysis": { "themes": [], "sourceDoc": "MOVIES.md" },
    "musicAnalysis": { "themes": [], "sourceDoc": "AUDIO.md" }
  },
  "questionnaire": {
    "completed": false,
    "sections": [
      "visual_design",
      "color_and_mood",
      "architecture_and_space",
      "fashion_and_texture",
      "sound_and_music",
      "narrative_and_story",
      "anti_preferences"
    ]
  },
  "updatedAt": null
}
```

**Derivation logic**: Taste is partially observable from existing enrichment data (book/movie/music lists). The aesthetic questionnaire fills in the rest via prompted sections — each section shows image/description pairs and asks for preference rankings. LLM analysis of existing media lists extracts themes (e.g., "brutalist minimalism", "high-contrast neon", "atmospheric dread") to seed the profile.

#### Entity: Mortality-Aware Goals (`goals.json`)

```json
{
  "birthDate": "1980-01-15",
  "lifeExpectancyEstimate": {
    "baseline": 78.5,
    "adjusted": null,
    "adjustmentFactors": {
      "geneticLongevity": null,
      "cardiovascularRisk": null,
      "lifestyle": null
    },
    "source": "SSA actuarial table + genome markers"
  },
  "timeHorizons": {
    "yearsRemaining": null,
    "healthyYearsRemaining": null,
    "percentLifeComplete": null
  },
  "goals": [
    {
      "id": "uuid",
      "title": "...",
      "description": "...",
      "horizon": "5-year",
      "category": "creative|family|health|financial|legacy|mastery",
      "urgency": null,
      "status": "active|completed|abandoned",
      "milestones": [],
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "updatedAt": null
}
```

**Derivation logic**: Birth date + actuarial baseline + genome longevity/cardiovascular markers produce an adjusted life expectancy. This creates urgency scoring: a "legacy" goal with a 20-year timeline hits differently at 30% life-complete vs 70%. Goals are categorized and scored by time-decay urgency. The system can suggest reprioritization when markers indicate risk factors (e.g., high cardiovascular genetic risk → prioritize health goals).

### Entity Relationships

```
                    ┌──────────────────┐
                    │   identity.json  │
                    │  (orchestrator)  │
                    └──┬───┬───┬───┬──┘
                       │   │   │   │
            ┌──────────┘   │   │   └──────────┐
            ▼              ▼   ▼              ▼
     ┌─────────┐   ┌──────────┐  ┌──────────┐  ┌─────────┐
     │ Genome  │   │Chronotype│  │Aesthetics│  │  Goals  │
     │genome.json│ │chrono.json│ │aesth.json│  │goals.json│
     └────┬────┘   └────┬─────┘  └────┬─────┘  └────┬────┘
          │              │             │              │
          │    ┌─────────┘             │              │
          │    │ derives from          │              │
          ├────┤ sleep markers         │              │
          │    │                       │              │
          │    │ caffeine cutoff ◄─────┤              │
          │    │ from caffeine markers │              │
          │    │                       │              │
          │    └───────────────────────┤              │
          │                            │              │
          │    longevity/cardio ────────────────────► │
          │    markers inform          │    urgency   │
          │    life expectancy         │    scoring   │
          │                            │              │
          │              ┌─────────────┘              │
          │              │ derives from               │
          │              │ enrichment: aesthetics,     │
          │              │ books, movies, music        │
          │              │                            │
          └──────────────┴────────────────────────────┘
                    All reference meta.json
                    (documents, enrichment, traits)
```

**Cross-cutting links** (stored in `identity.json.crossLinks`):
- `genome:sleep` → `chronotype:genetic` (CLOCK/DEC2/PER2/CRY1/MTNR1B markers feed chronotype)
- `genome:caffeine` → `chronotype:recommendations.caffeineCutoff` (CYP1A2/ADA markers set cutoff)
- `genome:sleep:mtnr1b` → `chronotype:recommendations.lateEatingCutoff` (MTNR1B impairs nighttime glucose)
- `genome:longevity` + `genome:cardiovascular` → `goals:lifeExpectancyEstimate` (risk-adjusted lifespan)
- `enrichment:daily_routines` → `chronotype:behavioral` (self-reported schedule)
- `enrichment:aesthetics` + `enrichment:favorite_*` + `enrichment:music_taste` → `aesthetics:profile` (taste extraction)
- `traits:valuesHierarchy` → `goals:category` priority weighting (autonomy-valuing person weights mastery goals higher)

### Identity Page Structure

The existing Digital Twin page at `/digital-twin/:tab` gets a new **Identity** tab that serves as the unified view. Individual subsystem tabs (Genome, Enrich) remain for deep dives.

#### Route: `/digital-twin/identity`

```
┌─────────────────────────────────────────────────────────────┐
│ Digital Twin                                                │
│ Overview | Documents | ... | Identity | Genome | ...        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─ Identity Dashboard ──────────────────────────────────┐  │
│  │  Completeness: ████████░░ 72%                         │  │
│  │  4 sections: Genome ✓  Chronotype ◐  Taste ○  Goals ○│  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─ Genome Summary Card ─────────────────────────────────┐  │
│  │  117 markers scanned across 32 categories             │  │
│  │  Key findings: ~20 beneficial, ~40 concern, ~5 major  │  │
│  │  [View Full Genome →]                                 │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─ Chronotype Card ─────────────────────────────────────┐  │
│  │  Type: Evening Owl (75% confidence from 5 markers)    │  │
│  │  Genetic: CLOCK T/C + CRY1 C/C + PER2 C/C + DEC2 G/G│  │
│  │  Peak focus: 8pm-2am | Caffeine cutoff: 2pm           │  │
│  │  Late eating cutoff: 8pm (MTNR1B-informed)            │  │
│  │  [Configure Schedule →]                               │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─ Aesthetic Taste Card ────────────────────────────────┐  │
│  │  Taste Tab: 0/5 sections completed (P2 UI ready)      │  │
│  │  Detected themes from media: brutalist, atmospheric   │  │
│  │  [Continue Taste Questionnaire →] [Go to Taste Tab →] │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─ Life Goals Card ─────────────────────────────────────┐  │
│  │  Status: Not configured                               │  │
│  │  Set birth date and goals to enable mortality-aware   │  │
│  │  priority scoring                                     │  │
│  │  [Set Up Goals →]                                     │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─ Cross-Insights ──────────────────────────────────────┐  │
│  │  "Your CLOCK gene evening tendency + caffeine          │  │
│  │   sensitivity suggest cutting coffee by 2pm"           │  │
│  │  "Longevity marker FOXO3A T/T (concern) + IL-6 C/C   │  │
│  │   (inflammation concern) — prioritize health goals"   │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### Sub-routes for deep dives:
- `/digital-twin/identity` — Dashboard overview (above)
- `/digital-twin/identity/chronotype` — Full chronotype editor with schedule builder
- `/digital-twin/identity/taste` — Aesthetic questionnaire flow (section-by-section)
- `/digital-twin/identity/goals` — Goal CRUD with urgency visualization
- `/digital-twin/genome` — Existing genome tab (unchanged)

### Implementation Phases

#### P1: Identity Orchestrator & Chronotype (data layer)
- Create `data/digital-twin/identity.json` with section status tracking
- Create `server/services/identity.js` — orchestrator that reads from genome, enrichment, taste-profile, and new data files
- Create `data/digital-twin/chronotype.json` — derive from 5 genome sleep markers + daily_routines enrichment
- Add `GET /api/digital-twin/identity` route returning unified section status
- Add `GET/PUT /api/digital-twin/identity/chronotype` routes
- Derivation function: `deriveChronotypeFromGenome(genomeSummary)` extracts all 5 sleep markers (CLOCK, DEC2, PER2, CRY1, MTNR1B) → composite chronotype signal with weighted confidence
- Cross-reference CYP1A2/ADA caffeine markers and MTNR1B melatonin receptor for caffeine cutoff and late-eating recommendations

#### P2: Aesthetic Taste Questionnaire ✅
- Created `data/digital-twin/taste-profile.json` for structured taste preference storage
- Created `server/services/taste-questionnaire.js` with 5 taste sections (movies, music, visual_art, architecture, food), each with core questions and branching follow-ups triggered by keyword detection
- Added 7 API routes under `/api/digital-twin/taste/*` (profile, sections, next question, answer, responses, summary, reset)
- Built `TasteTab.jsx` conversational Q&A UI with section grid, question flow, review mode, and AI-powered summary generation
- Responses persisted to taste-profile.json and appended to AESTHETICS.md for digital twin context
- Added Taste tab to Digital Twin page navigation

#### P3: Mortality-Aware Goal Tracking
- Create `data/digital-twin/goals.json`
- Add `GET/POST/PUT/DELETE /api/digital-twin/identity/goals` routes
- Birth date input + SSA actuarial table lookup
- Genome-adjusted life expectancy: weight longevity markers (5 markers: FOXO3A, IGF1R, CETP, IPMK, TP53) and cardiovascular risk markers (5 markers: Factor V, 9p21, Lp(a), LPA aspirin, PCSK9) into adjustment factor
- Time-horizon calculation: years remaining, healthy years, percent complete
- Urgency scoring: `urgency = (goalHorizonYears - yearsRemaining) / goalHorizonYears` normalized
- Goal CRUD with category tagging and milestone tracking

#### P4: Identity Tab UI
- Add `identity` tab to `TABS` constant in `constants.js`
- Create `IdentityTab.jsx` with dashboard layout (4 summary cards + cross-insights)
- Create `ChronotypeEditor.jsx` — schedule visualization and override controls
- Create `TasteQuestionnaire.jsx` — section-by-section prompted flow
- Create `GoalTracker.jsx` — goal list with urgency heatmap and timeline view
- Wire sub-routes for deep dives

#### P2.5: Digital Twin Aesthetic Taste Prompting (brain idea 608dc733)

##### Problem

P2's Taste questionnaire uses static questions and keyword-triggered follow-ups. The questions are good but generic — they don't reference anything the twin already knows about the user. Brain idea 608dc733 proposes using the digital twin's existing knowledge (books, music, movie lists, enrichment answers, personality traits) to generate personalized, conversational prompts that feel like talking to someone who already knows you rather than filling out a survey.

##### What Data to Capture

The aesthetic taste system captures preferences across **7 domains**, extending P2's 5 sections with 2 new ones (fashion/texture and digital/interface):

| Domain | Data Captured | Sources That Seed It |
|--------|--------------|---------------------|
| **Movies & Film** | Visual style preferences, narrative structure, mood/atmosphere, genre affinities, anti-preferences, formative films | BOOKS.md (narrative taste), enrichment:favorite_movies, existing P2 responses |
| **Music & Sound** | Functional use (focus/energy/decompress), genre affinities, production preferences, anti-sounds, formative artists | AUDIO.md, enrichment:music_taste, existing P2 responses |
| **Visual Art & Design** | Minimalism vs maximalism spectrum, color palette preferences, design movements, typography, layout sensibility | CREATIVE.md, enrichment:aesthetics, existing P2 responses |
| **Architecture & Spaces** | Material preferences, light quality, scale/intimacy, indoor-outdoor relationship, sacred vs functional | enrichment:aesthetics, existing P2 responses |
| **Food & Culinary** | Flavor profiles, cuisine affinities, cooking philosophy, dining experience priorities, sensory texture preferences | enrichment:daily_routines (meal patterns), existing P2 responses |
| **Fashion & Texture** *(new)* | Material/fabric preferences, silhouette comfort, color wardrobe, formality spectrum, tactile sensitivity | genome:sensory markers (if available), enrichment:aesthetics |
| **Digital & Interface** *(new)* | Dark vs light mode, information density, animation tolerance, typography preferences, notification style, tool aesthetics | PREFERENCES.md, existing PortOS theme choices (port-bg, port-card etc.) |

Each domain captures:
- **Positive affinities** — what they're drawn to and why
- **Anti-preferences** — what they actively avoid (often more revealing than likes)
- **Functional context** — how the preference serves them (focus, comfort, identity, social)
- **Formative influences** — early experiences that shaped the preference
- **Evolution** — how the preference has changed over time

##### Conversational Prompting Flow

The key design principle: **conversation, not survey**. The twin generates questions that reference things it already knows, creating a dialogue that feels like it's building on shared context.

**Flow architecture:**

```
┌─────────────────────────────────────────────────┐
│ 1. Context Aggregation                          │
│    Read: BOOKS.md, AUDIO.md, CREATIVE.md,       │
│    PREFERENCES.md, enrichment answers,          │
│    existing taste-profile.json responses,       │
│    personality traits (Big Five Openness)        │
├─────────────────────────────────────────────────┤
│ 2. Static Core Question (from P2)               │
│    Serve the existing static question first      │
│    to establish baseline in that domain          │
├─────────────────────────────────────────────────┤
│ 3. Personalized Follow-Up Generation            │
│    LLM generates 1 contextual follow-up using   │
│    identity context + previous answer            │
│    e.g., "You listed Blade Runner — what about  │
│    its visual language specifically grabbed you?" │
├─────────────────────────────────────────────────┤
│ 4. Depth Probing (optional, user-initiated)     │
│    "Want to go deeper?" button generates         │
│    another personalized question that connects   │
│    across domains (e.g., music taste ↔ visual)   │
├─────────────────────────────────────────────────┤
│ 5. Summary & Synthesis                          │
│    After core + follow-ups complete, LLM         │
│    generates section summary + cross-domain      │
│    pattern detection                             │
└─────────────────────────────────────────────────┘
```

**Prompt template for personalized question generation:**

```
You are a thoughtful interviewer building an aesthetic taste profile.
You already know the following about this person:

## Identity Context
{identityContext — excerpts from BOOKS.md, AUDIO.md, enrichment answers, traits}

## Previous Responses in This Section
{existingResponses — Q&A pairs from taste-profile.json for this section}

## Section: {sectionLabel}

Generate ONE follow-up question that:
1. References something specific from their identity context or previous answers
2. Probes WHY they prefer what they do, not just WHAT
3. Feels conversational — like a friend who knows them asking a natural question
4. Explores an angle their previous answers haven't covered yet
5. Is concise (1-2 sentences max)

Do NOT:
- Ask generic questions that ignore the context
- Repeat topics already covered in previous responses
- Use survey language ("On a scale of 1-10...")
- Ask multiple questions at once
```

**Example personalized exchanges:**

> **Static (P2):** "Name 3-5 films you consider near-perfect."
> **User:** "Blade Runner, Stalker, Lost in Translation, Drive, Arrival"
>
> **Personalized (P2.5):** "Your BOOKS.md lists several sci-fi titles with themes of isolation and altered perception. Four of your five film picks share that same atmosphere. Is solitude a feature of stories you're drawn to, or is it more about the specific visual treatment of lonely spaces?"

> **Static (P2):** "What artists or albums have had a lasting impact?"
> **User:** "Radiohead, Boards of Canada, Massive Attack"
>
> **Personalized (P2.5):** "All three of those artists layer heavy texture over minimalist structures. Your CREATIVE.md mentions an appreciation for 'controlled complexity.' Does this principle — density within restraint — apply to how you think about visual design too?"

##### Data Model — Where Taste Lives

Taste data lives in **two files** with distinct roles:

**1. Raw questionnaire responses: `data/digital-twin/taste-profile.json`** (existing, extended)

```json
{
  "version": "2.0.0",
  "createdAt": "...",
  "updatedAt": "...",
  "sections": {
    "movies": {
      "status": "completed",
      "responses": [
        {
          "questionId": "movies-core-1",
          "answer": "Blade Runner, Stalker, Lost in Translation...",
          "answeredAt": "...",
          "source": "static"
        },
        {
          "questionId": "movies-p25-1",
          "answer": "It's not solitude per se, it's the visual...",
          "answeredAt": "...",
          "source": "personalized",
          "generatedQuestion": "Your BOOKS.md lists several sci-fi titles...",
          "identityContextUsed": ["BOOKS.md:sci-fi-themes", "taste:movies-core-1"]
        }
      ],
      "summary": "..."
    },
    "fashion": { "status": "pending", "responses": [], "summary": null },
    "digital": { "status": "pending", "responses": [], "summary": null }
  },
  "profileSummary": null,
  "lastSessionAt": null
}
```

Changes from v1:
- `source` field distinguishes static vs personalized questions
- `generatedQuestion` stores the LLM-generated question text (since personalized questions aren't in the static definition)
- `identityContextUsed` tracks which identity sources informed the question (for provenance)
- Two new sections: `fashion`, `digital`
- Version bumped to 2.0.0

**2. Synthesized aesthetic profile: `data/digital-twin/aesthetics.json`** (planned in P1, populated by P2.5)

```json
{
  "version": "1.0.0",
  "updatedAt": "...",
  "profile": {
    "visualStyle": ["brutalist minimalism", "high-contrast neon", "controlled complexity"],
    "narrativePreferences": ["isolation themes", "slow burn", "ambiguity over resolution"],
    "musicProfile": ["textural electronica", "atmospheric layering", "functional listening"],
    "spatialPreferences": ["raw materials", "dramatic light", "intimacy over grandeur"],
    "culinaryIdentity": ["umami-driven", "improvisational cooking", "experience over formality"],
    "fashionSensibility": ["monochrome", "natural fibers", "minimal branding"],
    "digitalAesthetic": ["dark mode", "high information density", "subtle animation"],
    "antiPatterns": ["visual clutter", "forced symmetry", "saccharine sentimentality"],
    "corePrinciples": ["density within restraint", "function informing form", "earned complexity"]
  },
  "sources": {
    "tasteQuestionnaire": {
      "sectionsCompleted": 7,
      "totalResponses": 28,
      "lastUpdated": "..."
    },
    "enrichment": {
      "aesthetics": { "questionsAnswered": 5 },
      "favoriteBooks": { "analyzed": true, "themes": ["existential sci-fi", "systems thinking"] },
      "favoriteMovies": { "analyzed": true, "themes": ["atmospheric isolation", "neon noir"] },
      "musicTaste": { "analyzed": true, "themes": ["textural electronica", "ambient"] }
    },
    "documents": ["BOOKS.md", "AUDIO.md", "CREATIVE.md", "PREFERENCES.md"]
  },
  "crossDomainPatterns": [
    "Preference for 'controlled complexity' appears across music (layered textures), visual art (minimalist structure with dense detail), architecture (raw materials with precise placement), and food (complex umami built from simple ingredients)",
    "Anti-preference for overt sentimentality spans film (avoids melodrama), music (dislikes saccharine pop), and design (rejects decorative ornamentation)"
  ],
  "genomicCorrelations": {
    "tasteReceptorGenes": "TAS2R38 status may correlate with bitter-food tolerance preferences",
    "sensoryProcessing": "Olfactory receptor variants may explain heightened texture sensitivity"
  }
}
```

This file is the **canonical aesthetic profile** referenced by the Identity orchestrator (`identity.json`). It is regenerated whenever taste-profile.json accumulates significant new responses.

##### Implementation Steps

1. **Add 2 new sections** to `TASTE_SECTIONS` in `taste-questionnaire.js`: `fashion` and `digital`, each with 3 core questions and keyword-triggered follow-ups
2. **Add `aggregateIdentityContext(sectionId)`** to `taste-questionnaire.js` — reads BOOKS.md, AUDIO.md, CREATIVE.md, PREFERENCES.md, enrichment answers, and existing taste responses to build a context string for the LLM
3. **Add `generatePersonalizedTasteQuestion(sectionId, existingResponses, identityContext)`** — calls the active AI provider with the prompt template above, returns a single personalized follow-up question
4. **Add `POST /api/digital-twin/taste/:section/personalized-question`** route that returns a generated question
5. **Extend `submitAnswer()`** to accept `source: 'personalized'` and store `generatedQuestion` + `identityContextUsed` metadata
6. **Add "Go deeper" button** to TasteTab.jsx after each static follow-up cycle completes — clicking it calls the personalized question endpoint
7. **Add `generateAestheticsProfile()`** to `taste-questionnaire.js` — synthesizes all taste-profile.json responses + enrichment data into `aesthetics.json`
8. **Bump taste-profile.json version** to 2.0.0, migrate existing responses to include `source: 'static'`
9. **Update TasteTab.jsx** to render personalized questions differently (subtle indicator showing the twin referenced specific context)

##### Prerequisite Relaxation

The original spec listed P1 (Identity orchestrator) as a hard prerequisite. This is relaxed: P2.5 can read identity documents directly from the filesystem (`BOOKS.md`, `AUDIO.md`, etc.) and enrichment data from `meta.json` without needing the orchestrator layer. The orchestrator becomes useful for caching and cross-section queries but is not strictly required for context aggregation.

#### P5: Cross-Insights Engine
- Add `generateCrossInsights(identity)` in identity service
- Cross-reference genome markers with chronotype, goals, and enrichment data
- Generate natural-language insight strings (e.g., caffeine + chronotype, longevity + goal urgency)
- Display on Identity dashboard and inject into CoS context when relevant
- Consider autonomous job: periodic identity insight refresh
- Example cross-insights from current marker data:
  - CLOCK + CRY1 + PER2 → composite chronotype confidence (3 markers agreeing = high confidence evening/morning)
  - MTNR1B concern + evening chronotype → "avoid eating after 8pm — your melatonin receptor variant impairs late glucose handling"
  - CYP1A2 slow metabolizer + CLOCK evening → "caffeine cutoff by noon, not 2pm"
  - FOXO3A/CETP/IGF1R longevity markers + cardiovascular risk → adjusted life expectancy for goal urgency

### Identity Extension Roadmap

This roadmap connects brain ideas and the Genome Section Integration project (0e6a0332) into a unified implementation sequence.

#### Source Ideas
- **Brain idea 608dc733**: "Prompting Aesthetic Taste Docs via Digital Twin" — use the twin's existing knowledge to generate personalized aesthetic preference questions
- **Brain idea 284dd487**: "Genome Types & Chronotype Trait" — derive chronotype from 5 sleep/circadian markers + behavioral data
- **Project 0e6a0332**: "Genome Section Integration" — unify genome data with Identity page architecture

#### Phase Dependency Graph

```
P1: Identity Orchestrator & Chronotype ──── (brain idea 284dd487)
 │   Creates identity.json, chronotype.json,
 │   identity service, derivation from 5 sleep markers
 │
 ├─► P2.5: Personalized Taste Prompting ─── (brain idea 608dc733)
 │    Uses identity context to generate smart taste questions
 │    Enhances existing TasteTab with twin-aware follow-ups
 │
 ├─► P3: Mortality-Aware Goal Tracking
 │    Birth date + genome longevity/cardio markers → life expectancy
 │    Urgency scoring for prioritized goal management
 │
 └─► P4: Identity Tab UI
      Dashboard with summary cards for all 4 sections
      Sub-routes for chronotype, taste, goals deep dives
      │
      └─► P5: Cross-Insights Engine
           Reads all sections, generates natural-language insights
           Injects identity context into CoS agent briefings
```

#### Implementation Priority
1. **P1** — Foundation: nothing else works without the orchestrator
2. **P2.5** — Quick win: enhances existing Taste tab with minimal new infrastructure
3. **P3** — New feature: mortality-aware goals need genome data flowing through identity service
4. **P4** — UI: renders what P1-P3 produce
5. **P5** — Polish: cross-entity reasoning requires all sections populated

### Data Flow

```
User uploads 23andMe → genome.json (117 markers, 32 categories)
                        ↓
Identity service reads 5 sleep markers + 2 caffeine markers
                        ↓
Derives chronotype.json (+ behavioral input from daily_routines enrichment)
                        ↓
Twin reads identity context → generates personalized taste questions (P2.5)
                        ↓
User completes taste questionnaire → taste-profile.json → aesthetics.json
                        ↓
LLM analyzes books/movies/music docs → seeds aesthetic profile themes
                        ↓
User sets birth date → goals.json (life expectancy from actuarial + 10 genome markers)
                        ↓
Cross-insights engine reads all 4 sections → generates natural-language insights
                        ↓
Identity tab renders unified dashboard with summary cards + insights
                        ↓
CoS injects identity context into agent briefings when relevant
```

### Files to Create/Modify

**New files:**
- `data/digital-twin/identity.json` — orchestrator metadata
- `data/digital-twin/chronotype.json` — derived chronotype profile
- `data/digital-twin/aesthetics.json` — taste profile
- `data/digital-twin/goals.json` — mortality-aware goals
- `server/services/identity.js` — identity orchestration service
- `server/routes/identity.js` — API routes
- `server/lib/identityValidation.js` — Zod schemas
- `client/src/components/digital-twin/tabs/IdentityTab.jsx` — dashboard
- `client/src/components/digital-twin/identity/ChronotypeEditor.jsx`
- `client/src/components/digital-twin/identity/TasteQuestionnaire.jsx`
- `client/src/components/digital-twin/identity/GoalTracker.jsx`
- `client/src/components/digital-twin/identity/CrossInsights.jsx`

**Modified files:**
- `client/src/components/digital-twin/constants.js` — add Identity tab
- `client/src/pages/DigitalTwin.jsx` — add Identity tab rendering
- `client/src/services/api.js` — add identity API methods
- `server/index.js` — mount identity routes
- `server/services/taste-questionnaire.js` — add `generatePersonalizedTasteQuestion()` using identity context (P2.5)
- `client/src/components/digital-twin/tabs/TasteTab.jsx` — wire personalized question generation (P2.5)

### Design Decisions

1. **Separate data files per section** (not one giant file) — each section has independent update cadence and the genome file (82KB) is already large
2. **Derivation over duplication** — chronotype reads from genome.json at query time rather than copying marker data. Identity service is the join layer
3. **Progressive disclosure** — Identity tab shows summary cards; deep dives are sub-routes, not modals (per CLAUDE.md: all views must be deep-linkable)
4. **LLM-assisted but user-confirmed** — aesthetic themes extracted by LLM from media lists are suggestions, not gospel. User confirms/edits
5. **No new dependencies** — uses existing Zod, Express, React, Lucide stack
6. **Genome data stays read-only** — identity service reads genome markers but never writes to genome.json
7. **Taste data consolidation** — P2 created `taste-profile.json` (5 sections). P2.5 adds twin-aware personalized questions. Long-term, taste data migrates into `aesthetics.json` as the canonical aesthetic profile, with taste-profile.json as the raw questionnaire responses
8. **Weighted chronotype confidence** — 5 sleep markers weighted by specificity: CRY1 (strongest DSPD signal) > CLOCK (evening tendency) > PER2 (circadian period) > MTNR1B (melatonin coupling) > DEC2 (duration, not phase). Behavioral data from daily_routines enrichment gets equal weight to genetic composite

---

## Documentation

### Architecture & Guides
- [Architecture Overview](./docs/ARCHITECTURE.md) - System design, data flow
- [API Reference](./docs/API.md) - REST endpoints, WebSocket events
- [Contributing Guide](./docs/CONTRIBUTING.md) - Code guidelines, git workflow
- [PM2 Configuration](./docs/PM2.md) - PM2 patterns and best practices
- [Port Allocation](./docs/PORTS.md) - Port conventions and allocation
- [Versioning & Releases](./docs/VERSIONING.md) - Version format, release process
- [GitHub Actions](./docs/GITHUB_ACTIONS.md) - CI/CD workflow patterns
- [Troubleshooting](./docs/TROUBLESHOOTING.md) - Common issues and solutions

### Feature Documentation
- [App Wizard](./docs/features/app-wizard.md) - Register apps and create from templates
- [Autofixer](./docs/features/autofixer.md) - Autonomous crash detection and repair
- [Brain System](./docs/features/brain-system.md) - Second-brain capture and classification
- [Chief of Staff](./docs/features/chief-of-staff.md) - Autonomous agent orchestration
- [CoS Agent Runner](./docs/features/cos-agent-runner.md) - Isolated agent process management
- [CoS Enhancement](./docs/features/cos-enhancement.md) - M35 hybrid memory, missions, thinking levels
- [Digital Twin](./docs/features/digital-twin.md) - Quantitative personality modeling
- [Error Handling](./docs/features/error-handling.md) - Graceful error handling with auto-fix
- [Memory System](./docs/features/memory-system.md) - Semantic memory with LLM classification
- [Prompt Manager](./docs/features/prompt-manager.md) - Customizable AI prompts
- [Soul System](./docs/features/soul-system.md) - Digital twin identity scaffold
- [Browser Management](./docs/features/browser.md) - CDP/Playwright browser management

---

## Next Actions

Based on recent work and incomplete milestones:

1. **Complete M7: App Templates** - Implement template management UI and app scaffolding from templates
2. **Digital Twin P3: Behavioral Feedback Loop** - Add "sounds like me" response validation and adaptive weighting
3. **Vision API Polish** - Continue refining LM Studio vision integration based on test results
4. **Memory Consolidation** - Implement automatic memory consolidation for similar memories
5. **M40: Agent Skill System** - See details below

---

## M40: Agent Skill System

Inspired by [OpenAI Skills & Shell Tips](https://developers.openai.com/blog/skills-shell-tips), this milestone improves CoS agent accuracy and reliability through better task routing, prompt specificity, and context management.

### P1: Task-Type-Specific Agent Prompts (Skill Templates) ✅
Created specialized prompt templates per task category with routing, examples, and guidelines:
- **Routing descriptions**: "Use when..." / "Don't use when..." sections in each skill template
- **Embedded examples**: Worked examples of successful completions for each task type
- **Task-specific guidelines**: Security audit includes OWASP checklist; feature includes validation/convention requirements; refactor emphasizes behavior preservation

**Implemented**:
- Added `data/prompts/skills/` directory with 6 task-type templates: `bug-fix.md`, `feature.md`, `security-audit.md`, `refactor.md`, `documentation.md`, `mobile-responsive.md`
- Added `detectSkillTemplate()` and `loadSkillTemplate()` in `subAgentSpawner.js` with keyword-based matching (ordered by specificity — security/mobile before generic bug-fix/feature)
- Updated `buildAgentPrompt()` to inject matched skill template into both the Mustache template system and the fallback template
- Updated `cos-agent-briefing.md` with `{{#skillSection}}` conditional block
- Templates only loaded when matched to avoid token inflation

### P2: Agent Context Compaction ✅
Long-running agents can hit context limits causing failures. Add proactive context management:
- Pass `--max-turns` or equivalent context budget hints when spawning agents
- Track agent output length and detect when agents are approaching context limits
- ✅ Add compaction metadata to agent error analysis so retries can include "compact context" instructions
- ✅ Update the agent briefing to include explicit output format constraints for verbose task types

### P3: Negative Example Coverage for Task Routing ✅
Improve task-to-model routing accuracy by adding negative examples to the model selection logic:
- ✅ Document which task types should NOT use light models (already partially done, but formalize it)
- ✅ Add "anti-patterns" to task learning: when a task type fails with a specific model, record the negative signal via `routingAccuracy` cross-reference (taskType × modelTier)
- ✅ Surface routing accuracy metrics in the Learning tab so the user can see misroutes
- ✅ Enhanced `suggestModelTier()` to use negative signal data for smarter tier avoidance

### P4: Deterministic Workflow Skills ✅
For recurring autonomous jobs (daily briefing, git maintenance, security audit, app improvement), encode the full workflow as a deterministic skill:
- ✅ Each skill defines exact steps, expected outputs, and success criteria in `data/prompts/skills/jobs/`
- ✅ Prevents prompt drift across runs — jobs now load structured skill templates instead of inline prompt strings
- ✅ Skills are versioned and editable via the Prompt Manager UI (Job Skills tab)
- ✅ `generateTaskFromJob()` builds effective prompts from skill template sections (Steps, Expected Outputs, Success Criteria)
- ✅ API routes added: GET/PUT `/api/prompts/skills/jobs/:name`, preview via GET `/api/prompts/skills/jobs/:name/preview`

---

## Error Handling Summary

The server implements comprehensive error handling:
- **asyncHandler**: All routes wrapped with error handler that catches uncaught errors
- **ServerError**: Custom error class with status, code, severity, and context
- **Socket.IO Events**: Errors broadcast to UI via `error:occurred` event
- **Process Handlers**: Unhandled rejections and uncaught exceptions emit socket events
- **Logging**: Errors logged with emoji prefixes, no server crashes
- See [Error Handling](./docs/features/error-handling.md) for details

---

## Security Audit (2026-01-08)

Comprehensive security audit performed by CoS Self-Improvement agent.

### Vulnerabilities Found and Fixed

1. **Command Injection in Git Service** (CRITICAL - FIXED)
   - File: `server/services/git.js`
   - Fix: Replaced `exec()` with `spawn()` and `shell: false`, added path validation

2. **Path Traversal in Screenshots Route** (HIGH - FIXED)
   - File: `server/routes/screenshots.js`
   - Fix: Added `sanitizeFilename()` and path validation

### Secure Patterns (No Issues Found)
- Command execution uses allowlist
- PM2 operations use spawn with shell: false
- Input validation with Zod schemas
- No dangerouslySetInnerHTML in React
- API keys stored server-side only
- JSON content type required for mutations

---

## Planned Feature Details

### M7: App Templates

Templates allow creating new apps from pre-configured project structures.

**Built-in Template: PortOS Stack**
- Express.js API server
- React + Vite frontend
- Tailwind CSS styling
- PM2 ecosystem configuration
- GitHub Actions CI/CD workflows
- Auto-versioning system

**Features**
1. Template Selection - Browse available templates with feature descriptions
2. App Creation - Scaffold new project with chosen name and target directory
3. Custom Templates - Register additional templates from local paths
4. Template Management - View, edit, delete custom templates

**Pages**
- `/templates` - Template browser and app creation
- `/templates/new` - Register custom template

**API Endpoints**
| Route | Description |
|-------|-------------|
| GET /api/templates | List all templates |
| POST /api/templates | Add custom template |
| POST /api/templates/create | Create app from template |
| DELETE /api/templates/:id | Remove custom template |
