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

### Planned

- [ ] **M7**: App Templates - Template management and app scaffolding from templates
- [ ] **M34 P3,P5-P7**: Digital Twin - Behavioral feedback loop, multi-modal capture, advanced testing, personas
- [ ] **M40**: Agent Skill System - Task-type-specific prompt templates with routing logic, negative examples, and embedded workflows for improved agent accuracy and reliability
- [ ] **M42**: Unified Digital Twin Identity System - Connect Genome, Chronotype, Aesthetic Taste, and Mortality-Aware Goals into a single coherent Identity architecture

---

## M42: Unified Digital Twin Identity System

### Motivation

Four separate workstreams converge on the same vision: a personal digital twin that knows *who you are* biologically, temporally, aesthetically, and existentially. Today these live as disconnected features:

| Subsystem | Current State | Location |
|-----------|--------------|----------|
| **Genome** | Fully implemented: 23andMe upload, 37+ curated SNP markers across 13 categories, ClinVar integration | `server/services/genome.js`, `GenomeTab.jsx`, `data/digital-twin/genome.json` |
| **Chronotype** | Partially exists: 2 sleep markers (CLOCK rs1801260, DEC2 rs57875989) in genome + `daily_routines` enrichment category | `curatedGenomeMarkers.js` sleep category, `ENRICHMENT_CATEGORIES.daily_routines` |
| **Aesthetic Taste** | Partially exists: `aesthetics` enrichment category + book/movie/music list-based enrichments | `ENRICHMENT_CATEGORIES.aesthetics`, `BOOKS.md`, `MOVIES.md`, `AUDIO.md` |
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
    "genome": { "status": "active", "dataFile": "genome.json", "markerCount": 37, "lastScanAt": "..." },
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
      "dec2": { "rsid": "rs57875989", "genotype": "G/G", "signal": "standard_sleep_need" }
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

**Derivation logic**: Genome sleep markers provide the genetic baseline. The `daily_routines` enrichment answers provide behavioral confirmation. When genetic and behavioral signals agree, confidence is high. When they disagree, surface the conflict for user review. Caffeine cutoff cross-references caffeine metabolism markers (CYP1A2 rs762551, ADA rs73598374).

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
- `genome:sleep` → `chronotype:genetic` (CLOCK/DEC2 markers feed chronotype)
- `genome:caffeine` → `chronotype:recommendations.caffeineCutoff` (CYP1A2/ADA markers set cutoff)
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
│  │  37 markers scanned across 13 categories              │  │
│  │  Key findings: 3 beneficial, 2 concern, 1 major       │  │
│  │  [View Full Genome →]                                 │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─ Chronotype Card ─────────────────────────────────────┐  │
│  │  Type: Evening Owl (75% confidence)                   │  │
│  │  Genetic: CLOCK T/C (mild evening) + DEC2 G/G         │  │
│  │  Peak focus: 8pm-2am | Caffeine cutoff: 2pm           │  │
│  │  [Configure Schedule →]                               │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─ Aesthetic Taste Card ────────────────────────────────┐  │
│  │  Status: Needs questionnaire (0/7 sections)           │  │
│  │  Detected themes from media: brutalist, atmospheric   │  │
│  │  [Start Taste Questionnaire →]                        │  │
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
- Create `server/services/identity.js` — orchestrator that reads from genome, enrichment, and new data files
- Create `data/digital-twin/chronotype.json` — derive from genome sleep markers + daily_routines enrichment
- Add `GET /api/digital-twin/identity` route returning unified section status
- Add `GET/PUT /api/digital-twin/identity/chronotype` routes
- Derivation function: `deriveChronotypeFromGenome(genomeSummary)` extracts CLOCK + DEC2 status → chronotype signal

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
- Genome-adjusted life expectancy: weight longevity markers (FOXO3A, IGF1R, CETP) and cardiovascular risk markers (Factor V, 9p21, Lp(a)) into adjustment factor
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

#### P5: Cross-Insights Engine
- Add `generateCrossInsights(identity)` in identity service
- Cross-reference genome markers with chronotype, goals, and enrichment data
- Generate natural-language insight strings (e.g., caffeine + chronotype, longevity + goal urgency)
- Display on Identity dashboard and inject into CoS context when relevant
- Consider autonomous job: periodic identity insight refresh

### Data Flow

```
User uploads 23andMe → genome.json (existing)
                        ↓
Identity service reads genome sleep markers + caffeine markers
                        ↓
Derives chronotype.json (with behavioral input from enrichment)
                        ↓
User sets birth date → goals.json (life expectancy from actuarial + genome)
                        ↓
User completes taste questionnaire → aesthetics.json
                        ↓
LLM analyzes books/movies/music → seeds aesthetic profile themes
                        ↓
Cross-insights engine reads all 4 sections → generates natural-language insights
                        ↓
Identity tab renders unified dashboard
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

### Design Decisions

1. **Separate data files per section** (not one giant file) — each section has independent update cadence and the genome file is already large
2. **Derivation over duplication** — chronotype reads from genome.json at query time rather than copying marker data. Identity service is the join layer
3. **Progressive disclosure** — Identity tab shows summary cards; deep dives are sub-routes, not modals (per CLAUDE.md: all views must be deep-linkable)
4. **LLM-assisted but user-confirmed** — aesthetic themes extracted by LLM from media lists are suggestions, not gospel. User confirms/edits
5. **No new dependencies** — uses existing Zod, Express, React, Lucide stack
6. **Genome data stays read-only** — identity service reads genome markers but never writes to genome.json

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
