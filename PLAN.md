# Port OS - Implementation Plan

See full plan at: `~/.claude/plans/mutable-inventing-eagle.md`

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

### Milestones
- [x] M0-M3: Bootstrap, app registry, PM2 integration, log viewer - Core infrastructure complete
- [x] M4: App Wizard - Register existing apps or create from templates. See [App Wizard](./docs/features/app-wizard.md)
- [x] M5: AI Providers - Multi-provider AI execution with headless Claude CLI
- [x] M6: Dev Tools - Command runner with history and execution tracking
- [ ] M7: App Templates - Template management and app scaffolding (planned)
- [x] M8: Prompt Manager - Customizable AI prompts with variables and stages
- [x] M9: Streaming Import - Real-time websocket updates during app detection
- [x] M10: Enhanced DevTools - Provider/model selection, screenshots, git status, usage metrics
- [x] M11: AI Agents Page - Process detection and management with colorful UI
- [x] M12: History Improvements - Expandable entries with runtime/output capture
- [x] M13: Autofixer - Autonomous crash detection and repair. See [Autofixer](./docs/features/autofixer.md)
- [x] M14: Chief of Staff - Autonomous agent manager with task orchestration. See [Chief of Staff](./docs/features/chief-of-staff.md)
- [x] M15: Error Handling - Graceful error handling with auto-fix. See [Error Handling](./docs/features/error-handling.md)
- [x] M16: Memory System - Semantic memory with LLM classification. See [Memory System](./docs/features/memory-system.md)
- [x] M17: PM2 Config Enhancement - Per-process port detection and CDP_PORT support
- [x] M18: PM2 Standardization - LLM-powered config refactoring
- [x] M19: CoS Agent Runner - Isolated PM2 process for agent spawning
- [x] M20: AI Error Handling - Enhanced error extraction and CoS integration
- [x] M21: Usage Metrics - Comprehensive AI usage tracking and mobile UI
- [x] M22: Orphan Auto-Retry - Automatic retry for orphaned agents
- [x] M23: Self-Improvement - Automated UI/security/code analysis with Playwright
- [x] M24: Goal-Driven Mode - COS-GOALS.md mission file and always-working behavior
- [x] M25: Task Learning - Completion tracking and success rate analysis
- [x] M26: Scheduled Scripts - Cron-based automation with agent triggering
- [x] M28: Weekly Digest UI - Visual digest with insights and comparisons
- [x] M29: App Improvement - Comprehensive analysis extended to managed apps
- [x] M30: Configurable Intervals - Per-task-type scheduling (daily, weekly, once, on-demand)
- [x] M31: LLM Memory Classification - Intelligent memory extraction with quality filtering
- [x] M32: Brain System - Second-brain capture and classification. See [Brain System](./docs/features/brain-system.md)
- [x] M33: Soul System - Digital twin identity scaffold management
- [x] M35: Chief of Staff Enhancement - Proactive autonomous agent with hybrid memory, missions, LM Studio, thinking levels

### Documentation
- [Architecture Overview](./docs/ARCHITECTURE.md) - System design, data flow
- [API Reference](./docs/API.md) - REST endpoints, WebSocket events
- [Contributing Guide](./docs/CONTRIBUTING.md) - Code guidelines, git workflow
- [PM2 Configuration](./docs/PM2.md) - PM2 patterns and best practices
- [Port Allocation](./docs/PORTS.md) - Port conventions and allocation
- [Versioning & Releases](./docs/VERSIONING.md) - Version format, release process
- [GitHub Actions](./docs/GITHUB_ACTIONS.md) - CI/CD workflow patterns
- [Troubleshooting](./docs/TROUBLESHOOTING.md) - Common issues and solutions

#### Feature Documentation
- [App Wizard](./docs/features/app-wizard.md) - Register apps and create from templates
- [Autofixer](./docs/features/autofixer.md) - Autonomous crash detection and repair
- [Chief of Staff](./docs/features/chief-of-staff.md) - Autonomous agent orchestration
- [Error Handling](./docs/features/error-handling.md) - Graceful error handling with auto-fix
- [Memory System](./docs/features/memory-system.md) - Semantic memory with LLM classification
- [Brain System](./docs/features/brain-system.md) - Second-brain capture and classification
- [Soul System](#m33-soul-system) - Digital twin identity scaffold management

### Error Handling
The server implements comprehensive error handling:
- **asyncHandler**: All routes wrapped with error handler that catches uncaught errors
- **ServerError**: Custom error class with status, code, severity, and context
- **Socket.IO Events**: Errors broadcast to UI via `error:occurred` event
- **Process Handlers**: Unhandled rejections and uncaught exceptions emit socket events
- **Logging**: Errors logged with emoji prefixes, no server crashes
- See [Error Handling](./docs/features/error-handling.md)

---

## Next Actions

Based on recent work and incomplete milestones:

1. **Complete M7: App Templates** - Implement template management UI and app scaffolding from templates
2. **Vision API Polish** - Continue refining LM Studio vision integration based on test results
3. **Post-Execution Validation** - Extend agent task validation to verify commits and changes
4. **Shared AI Library** - Extract common AI patterns into reusable library (see [docs/SHARED_AI_LIBRARY_PLAN.md](./docs/SHARED_AI_LIBRARY_PLAN.md))
5. **CoS Goals Refinement** - Review and update COS-GOALS.md based on recent self-improvement runs
6. **Memory Consolidation** - Implement automatic memory consolidation for similar memories
7. **Brain Weekly Review** - Test and refine weekly review generation
8. **Documentation Updates** - Keep ARCHITECTURE.md and API.md current with recent features

---

## Detailed Milestone Documentation

### M7: App Templates (Planned)

Templates allow creating new apps from pre-configured project structures.

#### Built-in Template: PortOS Stack
The default template mirrors this application's architecture:
- Express.js API server
- React + Vite frontend
- Tailwind CSS styling
- Collapsible navigation layout
- PM2 ecosystem configuration
- GitHub Actions CI/CD workflows
- Auto-versioning system

#### Features
1. **Template Selection**: Browse available templates with feature descriptions
2. **App Creation**: Scaffold new project with chosen name and target directory
3. **Custom Templates**: Register additional templates from local paths
4. **Template Management**: View, edit, delete custom templates

#### Pages
- `/templates` - Template browser and app creation
- `/templates/new` - Register custom template

#### Template Structure
Templates are stored in `./data/templates/` with:
- `manifest.json` - Template metadata and feature list
- Source files to copy when creating new app

#### API Endpoints
| Route | Description |
|-------|-------------|
| GET /api/templates | List all templates |
| POST /api/templates | Add custom template |
| POST /api/templates/create | Create app from template |
| DELETE /api/templates/:id | Remove custom template |

---

### M8: Prompt Manager

Customizable AI prompts for all backend AI operations. Inspired by void-private's prompt management architecture.

#### Architecture
- **File-based prompts**: Prompts stored as `.md` files for easy editing and version control
- **Variable system**: Reusable variables with metadata, categories, and usage tracking
- **Stage configuration**: Each prompt stage defines provider, model type, and execution options
- **Template rendering**: Mustache-like syntax with conditionals, arrays, and nested data

#### Directory Structure
```
./data/prompts/
├── stages/              # Individual prompt templates (.md files)
│   ├── app-detection.md
│   ├── code-analysis.md
│   └── ...
├── variables.json       # Reusable prompt variables
└── stage-config.json    # Stage metadata and provider config
```

#### Features
1. **Prompt Stages**: Define different prompts for different AI tasks (detection, analysis, etc.)
2. **Variables**: Reusable content blocks (personas, formats, constraints)
3. **Per-Stage Provider Config**: Each stage can use different AI providers/models
4. **Web UI**: Edit prompts, variables, and preview rendered output
5. **Template Syntax**: `{{variable}}`, `{{#condition}}...{{/condition}}`, arrays

#### UI Pages
- `/prompts` - Prompt Manager with tabs for Stages, Variables, Elements
- Live preview with test variables
- Insert variable references

#### API Endpoints
| Route | Description |
|-------|-------------|
| GET /api/prompts | List all prompt stages |
| GET /api/prompts/:stage | Get stage template |
| PUT /api/prompts/:stage | Update stage/template |
| POST /api/prompts/:stage/preview | Preview compiled prompt |
| GET /api/prompts/variables | List all variables |
| PUT /api/prompts/variables/:key | Update variable |
| POST /api/prompts/variables | Create variable |
| DELETE /api/prompts/variables/:key | Delete variable |

---

### M9: Streaming Import Detection

Enhanced app import with real-time websocket updates as AI discovers project configuration.

#### Features
1. **Progressive Discovery**: Form fields update in real-time as AI analyzes the project
2. **Status Animations**: Visual indicators showing detection progress
3. **PM2 Detection**: Check if app is already running in PM2
4. **Websocket Updates**: Server streams discoveries to UI as they happen

#### Discovery Steps (streamed to UI)
1. Validating directory path
2. Reading package.json
3. Detecting project type (React, Express, monorepo, etc.)
4. Finding configuration files
5. Extracting ports from configs
6. Detecting start commands
7. Checking PM2 process status
8. AI-powered analysis for name, description
9. Generating PM2 process names

#### UI/UX
- Progress indicator with current step
- Form fields animate in as values are discovered
- Already-running indicator if detected in PM2
- Expandable "Detection Log" showing raw discovery output

#### API
| Route | Description |
|-------|-------------|
| WS /api/detect/stream | Websocket for streaming detection |
| GET /api/detect/pm2-status | Check if app running in PM2 |

---

### M17: PM2 Ecosystem Config Enhancement

Enhanced app management to detect and track all PM2 processes with their ports.

#### Features
- **Per-process port detection**: Extracts ports for each PM2 process from ecosystem.config.js/cjs
- **CDP_PORT support**: Detects Chrome DevTools Protocol ports for browser processes
- **Constant resolution**: Handles variable references like `CDP_PORT: CDP_PORT` by parsing top-level constants
- **Comment handling**: Properly skips `//` and `/* */` comments when parsing config files
- **Refresh button**: UI button to re-scan ecosystem config and update app data

#### Schema Extension
```javascript
// Added to server/lib/validation.js
export const processSchema = z.object({
  name: z.string().min(1),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  description: z.string().optional()
});

// Added to appSchema
processes: z.array(processSchema).optional()
```

---

### M18: PM2 Standardization

LLM-powered refactoring to standardize app configurations to follow PM2 best practices.

#### Features
1. **Standardize PM2 Button**: Available in each app's expanded details row
2. **LLM Analysis**: Uses configured AI provider to analyze project structure
3. **Auto-apply Changes**: Automatically modifies files with git backup
4. **Git Backup**: Creates backup branch before any modifications
5. **Port Consolidation**: Moves all ports to ecosystem.config.cjs env blocks
6. **Stray Port Removal**: Removes PORT from .env files, comments out port in vite.config

#### PM2 Standard
- All ports defined in `ecosystem.config.cjs` env blocks
- PM2 configured with watch for live-reload on server processes
- Vite processes use `npx vite --host --port XXXX` in args
- No stray port references in .env or vite.config

---

### M19: CoS Agent Runner

Isolated PM2 process for spawning Claude CLI agents, preventing orphaned processes when portos-server restarts.

#### Problem
When multiple CoS agents are running and the main portos-server restarts (due to code changes, crashes, or manual restart), child processes spawned via `child_process.spawn()` become orphaned. The parent loses track of them because the `activeAgents` Map is in memory.

#### Solution
A separate `portos-cos` PM2 process that:
1. Runs independently from `portos-server`
2. Manages agent spawning via HTTP/Socket.IO bridge
3. Doesn't restart when `portos-server` restarts
4. Maintains its own state file for PID tracking

#### Architecture
```
┌─────────────────┐     HTTP/Socket.IO    ┌─────────────────┐
│  portos-server  │ ──────────────────►   │   portos-cos    │
│    (5554)       │     spawn/terminate   │     (5558)      │
│                 │ ◄──────────────────   │                 │
│  subAgentSpawner│     events/output     │  cos-runner     │
└─────────────────┘                       └────────┬────────┘
                                                   │
                                                   │ spawn
                                                   ▼
                                          ┌───────────────┐
                                          │  Claude CLI   │
                                          │   Processes   │
                                          └───────────────┘
```

---

### M20: AI Provider Error Handling

Enhanced error extraction and display for AI provider execution failures, with automatic CoS investigation task creation.

#### Problem
When AI provider executions fail (e.g., invalid model, API errors), the devtools/runner UI only showed exit codes without meaningful error information, making debugging difficult.

#### Solution
1. **Error Extraction**: Extract meaningful error details from CLI output
2. **Error Categorization**: Classify errors by type (model_not_found, auth_error, rate_limit, etc.)
3. **Suggested Fixes**: Provide actionable suggestions for each error category
4. **CoS Integration**: Create investigation tasks for actionable failures
5. **UI Enhancement**: Display error details, category, and suggestions in history list

#### Error Categories
| Category | Description | Actionable |
|----------|-------------|------------|
| model_not_found | Model doesn't exist in provider | Yes |
| auth_error | API key invalid or unauthorized | Yes |
| api_error | Generic API request failure | Yes |
| rate_limit | Rate limiting triggered | No (transient) |
| quota_exceeded | Billing/quota issue | Yes |
| network_error | Connection refused/timeout | No (transient) |
| timeout | Process timeout (SIGTERM) | No |
| command_not_found | CLI tool not installed | Yes |
| permission_denied | File/directory access denied | Yes |
| unknown | Unrecognized error pattern | No |

---

### M21: Usage Metrics Integration

Enhanced usage tracking to capture all AI provider executions across CoS agents and DevTools runner.

#### Problem
The Usage page existed but displayed zero data because the tracking functions were never called when runs executed.

#### Solution
1. **Usage Service Integration**: Added `recordSession` and `recordMessages` calls to runner.js and subAgentSpawner.js
2. **Mobile Responsive Design**: Redesigned usage page with responsive Tailwind breakpoints
3. **Unified Tracking**: Both manual DevTools runs and CoS agent executions now record usage

#### Data Tracked
| Metric | Source | Description |
|--------|--------|-------------|
| Sessions | createRun, createAgentRun | Incremented when any AI execution starts |
| Messages | run completion | Recorded on successful run completion |
| Tokens | Output-based estimate | ~4 characters per token estimation |
| Provider Stats | Per provider | Sessions, messages, tokens by provider |
| Model Stats | Per model | Sessions, messages, tokens by model |
| Daily Activity | Per day | Sessions, messages, tokens by date |
| Hourly Activity | 24-hour array | Session counts by hour of day |

---

### M22: Orphan Auto-Retry

Automatic retry for orphaned agents with investigation task creation after repeated failures.

#### Problem
When agents become orphaned (server restart, runner crash, etc.), the task remained stuck and the system didn't automatically retry or investigate the issue.

#### Solution
1. **Auto-Retry**: Reset orphaned tasks to pending for automatic retry (up to 3 attempts)
2. **Retry Tracking**: Track retry count in task metadata (orphanRetryCount)
3. **Investigation Task**: After max retries, create auto-approved investigation task
4. **Evaluation Trigger**: Trigger task evaluation immediately after orphan cleanup

#### Retry Flow
```
Agent Orphaned
    └─► cleanupOrphanedAgents() marks agent as completed
    └─► handleOrphanedTask() checks retry count
        ├─► retryCount < 3: Reset task to pending, trigger evaluation
        └─► retryCount >= 3: Mark task blocked, create investigation task
```

---

### M23: Self-Improvement System

Automated self-analysis and improvement system that uses Playwright and Opus to continuously improve PortOS.

See [docs/features/chief-of-staff.md](./docs/features/chief-of-staff.md#self-improvement) for details on analysis types and rotation system.

---

### M24: Goal-Driven Proactive Mode

Makes CoS proactive and goal-driven, spending more time working and less time idle.

#### Solution

1. **COS-GOALS.md Mission File**: Created `data/COS-GOALS.md` with mission statement, active goals, task priorities
2. **Always-Working Behavior**: CoS ALWAYS returns work - falls back to self-improvement if apps are on cooldown
3. **Expanded Task Types**: Added 4 new self-improvement types (cos-enhancement, test-coverage, documentation, feature-ideas)
4. **Configuration Changes**: Shorter intervals (1m eval, 30m cooldown), MEDIUM priority for idle reviews

---

### M25: Task Learning System

Tracks patterns from completed tasks to improve future task execution and model selection.

#### Features
1. **Completion Tracking**: Records success/failure for every agent task completion
2. **Success Rate Analysis**: Calculates success rates by task type and model tier
3. **Duration Tracking**: Tracks average execution time per task type
4. **Error Pattern Analysis**: Identifies recurring error categories
5. **Model Effectiveness**: Compares performance across model tiers (light/medium/heavy)
6. **Recommendations**: Generates actionable insights based on historical data

---

### M26: Scheduled Scripts

Cron-based script scheduling with optional agent triggering for automated health checks and maintenance.

#### Features
1. **Schedule Presets**: Common intervals (5min, 15min, hourly, daily, weekly, on-demand)
2. **Custom Cron**: Full cron expression support for complex schedules
3. **Command Allowlist**: Security-first design using same allowlist as command runner
4. **Agent Triggering**: Scripts can spawn CoS agents when issues are detected
5. **Run History**: Track last execution, output, and exit codes
6. **Enable/Disable**: Toggle scripts without deleting them

---

### M28: Weekly Digest UI

Added a visual "Digest" tab to the Chief of Staff page that displays weekly activity summaries with insights, accomplishments, and week-over-week comparisons.

#### Features
1. **Weekly Summary View**: Visual dashboard showing tasks completed, success rate, work time, and issue count
2. **Week-over-Week Comparison**: Shows percentage changes from previous week with trend indicators
3. **Live Week Progress**: Real-time view of current week progress with projected totals
4. **Top Accomplishments**: Lists most significant completed tasks sorted by duration
5. **Task Type Breakdown**: Table view of performance metrics by task type
6. **Error Patterns**: Highlights recurring errors that need attention
7. **Actionable Insights**: Auto-generated insights like "Star Performer", "Needs Attention", "Recurring Issue"
8. **Historical Navigation**: Dropdown to view digests from previous weeks

---

### M29: Comprehensive App Improvement

Extended the CoS self-improvement system to apply the same comprehensive analysis to managed apps (not just PortOS itself).

#### Problem
The CoS had a sophisticated self-improvement system with 12 different analysis types for PortOS itself, but managed apps only received simple idle reviews.

#### Solution
Created an app-agnostic self-improvement system that applies comprehensive analysis to any managed app:

1. **10 Analysis Types for Apps**: Security audit, code quality, test coverage, performance, accessibility, console errors, dependency updates, documentation, error handling, and TypeScript typing
2. **Rotation System**: Each app tracks its last improvement type and rotates through all 10 types
3. **App Activity Tracking**: Extended `appActivity.js` to track `lastImprovementType` per app
4. **Configuration Toggle**: New `comprehensiveAppImprovement` config option (default: true)

---

### M30: Configurable Task Intervals

Per-task-type scheduling: daily, weekly, once, on-demand; schedule UI tab; execution history tracking.

---

### M31: LLM-based Memory Classification

Replaced pattern-based memory extraction with intelligent LLM-based evaluation using local LM Studio.

See [Memory System](./docs/features/memory-system.md#llm-based-classification-m31) for details.

---

### Security Audit (2026-01-08)

Comprehensive security audit performed by CoS Self-Improvement agent.

#### Vulnerabilities Found and Fixed

1. **Command Injection in Git Service** (CRITICAL - FIXED)
   - File: `server/services/git.js`
   - Fix: Replaced `exec()` with `spawn()` and `shell: false`, added path validation

2. **Path Traversal in Screenshots Route** (HIGH - FIXED)
   - File: `server/routes/screenshots.js`
   - Fix: Added `sanitizeFilename()` and path validation

#### No Issues Found (Secure Patterns)
- Command execution uses allowlist
- PM2 operations use spawn with shell: false
- Input validation with Zod schemas
- No dangerouslySetInnerHTML in React
- API keys stored server-side only
- JSON content type required for mutations

---

### M27: CoS Capability Enhancements (2026-01-08)

Enhancements to the Chief of Staff system for better task learning, smarter prioritization, and expanded self-improvement capabilities.

#### Features

1. **New Self-Improvement Task Type: Dependency Updates** - Runs `npm audit`, checks for outdated packages, updates safely
2. **Enhanced Performance Tracking** - `getPerformanceSummary()` function provides overall success rate, top performers, tasks needing attention
3. **Learning Insights System** - `recordLearningInsight()` and `getRecentInsights()` for storing and retrieving observations
4. **Periodic Performance Logging** - Every 10 evaluations, CoS logs success rate and task performance stats

---

### M33: Soul System

Digital twin identity scaffold management for creating and testing aligned AI personas.

#### Problem
LLMs can embody specific personas, but creating comprehensive identity documents and testing alignment across different models is manual and error-prone.

#### Solution
A dedicated Soul page (`/soul`) with five tabs:

1. **Overview Tab**: Dashboard showing soul health score, document counts, test scores, enrichment progress, and quick actions
2. **Documents Tab**: Sidebar-based document editor for managing soul markdown files by category (core, audio, behavioral, enrichment)
3. **Test Tab**: Multi-model behavioral testing against 14 predefined tests, with side-by-side result comparison
4. **Enrich Tab**: Guided questionnaire across 10 categories that generates soul document content from answers
5. **Export Tab**: Export soul for use in external LLMs (System Prompt, CLAUDE.md, JSON, individual files)

#### Directory Structure
```
data/soul/
├── meta.json              # Document metadata, test history, settings
├── SOUL.md                # Core identity
├── Expanded.md            # High-fidelity spec
├── BEHAVIORAL_TEST_SUITE.md  # 14 behavioral tests
├── AUDIO*.md              # Audio preferences
├── MEMORIES.md            # Generated via enrichment
├── FAVORITES.md           # Generated via enrichment
└── PREFERENCES.md         # Generated via enrichment
```

#### CoS Integration
- Soul context automatically injected into agent prompts when enabled
- Settings control `autoInjectToCoS` and `maxContextTokens`
- Prompt template `cos-agent-briefing.md` includes `{{soulSection}}`

#### Enrichment Categories
| Category | Description |
|----------|-------------|
| Core Memories | Formative experiences |
| Favorite Books | Books that shaped thinking |
| Favorite Movies | Films that resonate |
| Music Taste | Cognitive infrastructure |
| Communication | How to give/receive info |
| Decision Making | Approach to choices |
| Values | Core principles |
| Aesthetics | Visual preferences |
| Daily Routines | Structure habits |
| Career/Skills | Professional expertise |

#### API Endpoints
| Route | Description |
|-------|-------------|
| GET /api/soul | Status summary |
| GET /api/soul/documents | List documents |
| POST /api/soul/documents | Create document |
| PUT /api/soul/documents/:id | Update document |
| DELETE /api/soul/documents/:id | Delete document |
| GET /api/soul/tests | Get test suite |
| POST /api/soul/tests/run | Run single-model tests |
| POST /api/soul/tests/run-multi | Run multi-model tests |
| GET /api/soul/enrich/categories | List enrichment categories |
| POST /api/soul/enrich/question | Get next question |
| POST /api/soul/enrich/answer | Submit answer |
| POST /api/soul/export | Export soul |
| GET /api/soul/validate/completeness | Check soul completeness |
| POST /api/soul/validate/contradictions | Detect contradictions |
| POST /api/soul/tests/generate | Generate dynamic tests |
| POST /api/soul/analyze-writing | Analyze writing samples |

#### Soul Enhancement: Reliable Digital Twins (M33.1)

Additional features to create more reliable digital twins through improved data collection, validation, testing, and user guidance.

##### New Enrichment Categories
Added 3 new categories with 3 preset questions each:
- **non_negotiables**: Principles and boundaries that define your limits
- **decision_heuristics**: Mental models and shortcuts for making choices
- **error_intolerance**: What your digital twin should never do

##### Validation & Analysis
1. **Completeness Validator**: Checks for 6 required sections (identity, values, communication, decision making, non-negotiables, error intolerance), shows percentage complete with actionable suggestions
2. **Contradiction Detector**: AI-powered analysis to find inconsistencies between soul documents, with severity levels and resolution suggestions

##### Dynamic Testing
- **Generate Tests**: AI generates behavioral tests based on soul content, targeting values, communication style, non-negotiables, and decision patterns
- Returns structured tests with prompts, expected behaviors, and failure signals

##### Writing Sample Analysis
- Paste writing samples to extract authentic voice patterns
- Analyzes: sentence structure, vocabulary, formality, tone, distinctive markers
- Generates WRITING_STYLE.md document content

##### User Guidance
1. **Soul Creation Wizard**: 5-step guided wizard for new users (identity, values, communication, decisions, boundaries)
2. **Best Practices Documentation**: SOUL_GUIDE.md with comprehensive guidance on creating effective soul documents

##### Context Optimization
- **Document Weighting**: Priority slider (1-10) on each document
- Higher weighted documents preserved first when context limits force truncation

---

## M34: Digital Twin Personality Enhancement

### Vision

Transform the Digital Twin from a **document capture system** into a **quantitative personality modeling and prediction system** that can accurately embody a human's values, decision patterns, and communication style.

### Current State Assessment

| Strength | Gap |
|----------|-----|
| Rich document storage (14 categories) | No quantitative personality dimensions |
| Multi-method enrichment | No automated extraction from behavior |
| Behavioral testing framework | No feedback loop from real usage |
| Writing sample analysis | No multi-modal capture (voice, video) |
| Contradiction detection | No personality confidence scoring |
| CoS integration | No external data source integration |

### Improvement Phases

#### Phase 1: Quantitative Personality Modeling (Foundation)

**Goal**: Add structured personality trait scoring alongside unstructured documents.

**1.1 Big Five Trait Scoring**
- Add quantified OCEAN scores (Openness, Conscientiousness, Extraversion, Agreeableness, Neuroticism)
- Infer scores from existing documents using LLM analysis
- Allow manual override/adjustment
- Store in `meta.json` under `traits.bigFive`

**1.2 Values Hierarchy**
- Extract explicit values from VALUES.md and NON_NEGOTIABLES.md
- Create ranked values list with conflict resolution rules
- Store in `meta.json` under `traits.valuesHierarchy`

**1.3 Communication Fingerprint**
- Quantify writing style: formality (1-10), verbosity (1-10), emoji usage, sentence length avg
- Extract from WRITING_STYLE.md and writing samples
- Store in `meta.json` under `traits.communicationProfile`

**Data Structure**:
```javascript
traits: {
  bigFive: { O: 0.75, C: 0.82, E: 0.45, A: 0.68, N: 0.32 },
  valuesHierarchy: ["authenticity", "growth", "family", ...],
  communicationProfile: {
    formality: 6,
    verbosity: 4,
    avgSentenceLength: 18,
    emojiUsage: "rare",
    preferredTone: "direct-but-warm"
  },
  lastAnalyzed: "2026-01-21T..."
}
```

**API Endpoints**:
| Route | Description |
|-------|-------------|
| GET /api/digital-twin/traits | Get all trait scores |
| POST /api/digital-twin/traits/analyze | Analyze documents → extract traits |
| PUT /api/digital-twin/traits/:category | Manual override trait scores |

---

#### Phase 2: Personality Confidence Scoring

**Goal**: Measure how well-defined each aspect of personality is, guiding enrichment.

**2.1 Coverage Metrics**
- For each Big Five dimension: evidence count from documents
- For each value: supporting document count + specificity score
- For communication: sample diversity, consistency across samples

**2.2 Confidence Algorithm**
```
confidence(aspect) = min(1.0,
  (evidence_count / required_evidence) *
  (consistency_score) *
  (recency_weight)
)
```

**2.3 Gap Recommendations**
- Identify lowest-confidence aspects
- Generate specific questions to fill gaps
- Prioritize enrichment categories by confidence gap

**UI Enhancement**:
- Add "Personality Map" visualization showing confidence per dimension
- Color-code: green (>80%), yellow (50-80%), red (<50%)
- Click dimension → suggested enrichment questions

---

#### Phase 3: Behavioral Feedback Loop

**Goal**: Learn from real-world twin usage to improve accuracy.

**3.1 Response Validation Interface**
- When CoS uses twin context, log the interaction
- User can mark responses: "sounds like me" / "not quite me" / "definitely not me"
- Store feedback in `data/digital-twin/feedback.json`

**3.2 Feedback Analysis**
- Periodically analyze feedback patterns
- Identify which aspects of twin are underperforming
- Generate document improvement suggestions

**3.3 Adaptive Weighting**
- Documents that correlate with "sounds like me" responses → increase weight
- Documents that correlate with misses → flag for review
- Auto-adjust document weights based on feedback patterns

**Data Structure**:
```javascript
feedback: [
  {
    id: "uuid",
    timestamp: "...",
    context: "summary of interaction",
    response: "what the twin said",
    rating: "sounds_like_me" | "not_quite" | "definitely_not",
    documentsUsed: ["doc-id-1", "doc-id-2"],
    traits: { /* which traits were relevant */ }
  }
]
```

---

#### Phase 4: External Data Integration

**Goal**: Reduce manual input by importing from external sources.

**4.1 Reading List Import**
- Goodreads CSV import → analyze for personality insights
- Extract: genres preferred, themes that resonate, reading patterns

**4.2 Music Profile Import**
- Spotify listening history → infer emotional patterns, energy levels
- Last.fm scrobbles → genre preferences, listening habits

**4.3 Social Media Analysis (Optional)**
- Twitter/X export → communication style, topics of interest
- LinkedIn export → professional values, career trajectory

**4.4 Calendar Pattern Analysis**
- iCal export → routine patterns, priorities by time allocation
- Meeting patterns → social preferences

**Implementation Notes**:
- All imports are user-initiated, explicit consent
- Data processed locally, not stored raw
- Only personality inferences stored, not source data

---

#### Phase 5: Multi-Modal Personality Capture

**Goal**: Capture personality from voice and video, not just text.

**5.1 Voice Analysis**
- Record voice samples describing self
- Extract: speech pace, pitch variation, pause patterns
- Infer: confidence level, emotional expressiveness

**5.2 Video Interview**
- Guided self-interview with webcam
- Analyze: facial expressions, gestures, eye contact patterns
- Generate insights about authentic presentation vs stated identity

**5.3 Audio Transcript Enrichment**
- Transcribe voice samples → analyze as writing samples
- Compare spoken vs written style differences

**Technical Approach**:
- Use Whisper for transcription
- Use open-source models for facial expression analysis
- Store only derived insights, not raw recordings

---

#### Phase 6: Advanced Behavioral Testing

**Goal**: More sophisticated twin validation beyond Q&A tests.

**6.1 Scenario Simulation Tests**
- Complex multi-turn conversations
- Role-play scenarios (negotiation, conflict, mentoring)
- Evaluate: consistency across turns, appropriate boundary-setting

**6.2 Ethical Dilemma Tests**
- Present moral dilemmas aligned with stated values
- Check if twin's reasoning matches user's value hierarchy
- Detect values actually held vs values aspired to

**6.3 Communication Style Tests**
- Generate responses, measure against communication fingerprint
- Check: formality match, verbosity match, tone match
- Quantitative scoring instead of pass/fail

**6.4 Adversarial Testing**
- Prompts designed to elicit non-me responses
- Check if twin maintains boundaries (error_intolerance)
- Verify non-negotiables are enforced

---

#### Phase 7: Twin Personas & Context Switching

**Goal**: Support multiple personality variants for different contexts.

**7.1 Persona System**
- Create named personas (Professional, Casual, Family, Creative)
- Each persona: subset of documents + weight overrides
- Context-aware persona selection

**7.2 Blending Rules**
- Define which traits change per persona vs remain constant
- Example: formality varies, core values stay constant

**7.3 Persona Testing**
- Test each persona independently
- Ensure personas don't violate core identity boundaries

---

### Implementation Status

| Phase | Status | Complexity | Impact |
|-------|--------|------------|--------|
| P1: Quantitative Modeling | ✅ COMPLETE | Medium | High - enables all other phases |
| P2: Confidence Scoring | ✅ COMPLETE | Low | High - guides enrichment |
| P3: Feedback Loop | 🔲 Planned | Medium | Very High - enables learning |
| P4: External Integration | ✅ COMPLETE | High | Medium - convenience |
| P5: Multi-Modal | 🔲 Planned | Very High | Medium - nice to have |
| P6: Advanced Testing | 🔲 Planned | Medium | High - validation quality |
| P7: Personas | 🔲 Planned | Medium | Medium - power users |

### Completed: Phase 1 & 2 (2026-01-21)

Implemented quantitative personality modeling and confidence scoring:
- Big Five trait extraction via AI analysis
- Values hierarchy with conflict detection
- Communication profile quantification
- Per-dimension confidence scoring
- Gap recommendations for low-confidence areas
- PersonalityMap radar chart component
- ConfidenceGauge visualization component
- GapRecommendations prioritized list component
- API endpoints: `/traits`, `/traits/analyze`, `/confidence`, `/confidence/calculate`, `/gaps`

### Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Behavioral test pass rate | ~70% | >90% |
| Enrichment category coverage | Manual | Confidence-guided |
| User feedback: "sounds like me" | N/A | >85% |
| Time to usable twin | Hours | <30 min |
| Trait confidence coverage | 0% | >80% across all dimensions |

---

### Technical Considerations

**New Prompt Templates Needed**:
- `twin-trait-extractor` - Analyze documents → Big Five scores
- `twin-values-ranker` - Extract and rank values with conflict rules
- `twin-confidence-analyzer` - Score document evidence per dimension
- `twin-feedback-analyzer` - Learn from usage feedback patterns
- `twin-scenario-generator` - Create multi-turn test scenarios
- `twin-dilemma-generator` - Create ethical dilemma tests

**Schema Extensions** (`lib/digitalTwinValidation.js`):
```javascript
traitsSchema = z.object({
  bigFive: z.object({
    O: z.number().min(0).max(1),
    C: z.number().min(0).max(1),
    E: z.number().min(0).max(1),
    A: z.number().min(0).max(1),
    N: z.number().min(0).max(1)
  }).optional(),
  valuesHierarchy: z.array(z.string()).optional(),
  communicationProfile: communicationProfileSchema.optional(),
  lastAnalyzed: z.string().datetime().optional()
});

confidenceSchema = z.object({
  overall: z.number().min(0).max(1),
  dimensions: z.record(z.string(), z.number().min(0).max(1)),
  gaps: z.array(z.object({
    dimension: z.string(),
    confidence: z.number(),
    suggestedQuestions: z.array(z.string())
  }))
});
```

**New UI Components**:
- `PersonalityMap.jsx` - Radar chart of Big Five + confidence coloring
- `ConfidenceGauge.jsx` - Per-dimension confidence indicator
- `FeedbackRater.jsx` - "Sounds like me" rating interface
- `GapRecommendations.jsx` - Prioritized enrichment suggestions
- `TraitEditor.jsx` - Manual trait override interface

---

## M35: Chief of Staff Enhancement

Comprehensive upgrade to COS from reactive task executor to proactive autonomous agent.

### Implementation Status

| Phase | Component | Status | Files Created |
|-------|-----------|--------|---------------|
| **Phase 1: Memory** | BM25 Algorithm | ✅ Complete | `server/lib/bm25.js` |
| | BM25 Index Manager | ✅ Complete | `server/services/memoryBM25.js` |
| | Session Delta Tracker | ✅ Complete | `server/services/sessionDelta.js` |
| | Hybrid Search (BM25+Vector) | ✅ Complete | Modified `memory.js`, `memoryRetriever.js` |
| **Phase 5: Architecture** | Tool State Machine | ✅ Complete | `server/services/toolStateMachine.js` |
| | Agent Gateway | ✅ Complete | `server/services/agentGateway.js` |
| | Error Recovery | ✅ Complete | `server/services/errorRecovery.js` |
| | Agent Run Cache | ✅ Complete | `server/services/agentRunCache.js` |
| | Spawner Integration | ✅ Complete | Modified `subAgentSpawner.js` |
| **Phase 2: Execution** | Event Scheduler | ✅ Complete | `server/services/eventScheduler.js` |
| | Execution Lanes | ✅ Complete | `server/services/executionLanes.js` |
| | Missions Service | ✅ Complete | `server/services/missions.js` |
| | Mission Data Files | ✅ Complete | `data/cos/missions/*.json` |
| | COS Event-Driven Updates | ✅ Complete | Modified `cos.js` |
| | Mission Task Generation | ✅ Complete | Modified `cos.js` |
| **Phase 3: LM Studio** | LM Studio Manager | ✅ Complete | `server/services/lmStudioManager.js` |
| | Local Thinking | ✅ Complete | `server/services/localThinking.js` |
| | LM Studio Routes | ✅ Complete | `server/routes/lmstudio.js` |
| **Phase 4: Thinking** | Thinking Levels | ✅ Complete | `server/services/thinkingLevels.js` |
| | Context Upgrader | ✅ Complete | `server/services/contextUpgrader.js` |
| | COS Evolution | ✅ Complete | `server/services/cosEvolution.js` |
| | Spawner Thinking Levels | ✅ Complete | Modified `subAgentSpawner.js` |

### Features Added

**Phase 1: Hybrid Memory Search**
- BM25 algorithm with IDF weighting and inverted index
- Reciprocal Rank Fusion (RRF) combining BM25 + vector search
- 40% BM25 / 60% vector weighting for optimal retrieval
- Session delta tracking for pending bytes/messages

**Phase 5: Agent Architecture**
- Tool execution state machine (IDLE → START → RUNNING → UPDATE → END → ERROR)
- Agent gateway with request deduplication and 10-minute cache
- Error recovery with 6 strategies: retry, escalate, fallback, decompose, defer, investigate
- Agent run cache for outputs, tool results, and contexts

**Phase 2: Proactive Execution**
- Event scheduler with cron expressions and timeout-safe timers (clamps to 2^31-1)
- Execution lanes: critical (1), standard (2), background (3) concurrent slots
- Mission system for long-term goals with sub-tasks
- Initial missions: pump-funner and solana-accounts improvements

**Phase 3: Local Model Integration**
- LM Studio availability checking and model discovery
- Quick completions for local thinking without cloud costs
- Memory classification using local models
- Embeddings via local LM Studio

**Phase 4: Dynamic Model Selection**
- Thinking levels: off, minimal, low, medium, high, xhigh
- Level resolution hierarchy: task → hooks → agent → provider
- Context upgrader with complexity analysis
- COS self-evolution with automatic model changes

### New API Endpoints

| Route | Description |
|-------|-------------|
| GET /api/lmstudio/status | Check LM Studio availability |
| GET /api/lmstudio/models | List loaded models |
| POST /api/lmstudio/completion | Local model completion |
| POST /api/lmstudio/analyze-task | Analyze task complexity |
| POST /api/lmstudio/classify-memory | Classify memory content |

### Design Decisions

1. **Mission Autonomy**: Full autonomy - COS can implement changes, run tests, commit without approval for managed apps
2. **Model Usage**: Local-first with LM Studio, no cloud API costs for thinking
3. **Self-Modification**: Full autonomy - COS can change its own base thinking model without user approval

### Test Suite

All COS Enhancement modules have comprehensive unit tests:

| Test File | Module | Tests |
|-----------|--------|-------|
| `server/lib/bm25.test.js` | BM25 Algorithm | Tokenization, IDF, indexing, search, serialization |
| `server/services/toolStateMachine.test.js` | Tool State Machine | State transitions, execution lifecycle, error recovery |
| `server/services/thinkingLevels.test.js` | Thinking Levels | Level resolution, model selection, upgrade/downgrade |
| `server/services/executionLanes.test.js` | Execution Lanes | Lane acquisition, release, capacity, promotion |
| `server/services/errorRecovery.test.js` | Error Recovery | Error analysis, strategy selection, execution |
| `server/services/agentRunCache.test.js` | Agent Run Cache | Caching, TTL, invalidation, statistics |
| `server/services/missions.test.js` | Missions Service | CRUD, sub-tasks, proactive generation, archiving |

Run all tests:
```bash
cd server && npm test
# 24 test files, 722 tests
```

### Integration Complete

All M35 phases have been integrated into the main codebase:

1. ✅ Tool state machine integrated into `subAgentSpawner.js`
   - Creates execution tracking per agent spawn
   - Releases lanes on completion/error
   - Completes executions with success/failure status

2. ✅ Event scheduler integrated into `cos.js`
   - Replaced setInterval with `scheduleEvent()` for evaluation loop
   - Replaced setInterval with `scheduleEvent()` for health check loop
   - Events use timeout-safe timers (clamps to 2^31-1)

3. ✅ Thinking levels integrated into `subAgentSpawner.js`
   - `resolveThinkingLevel()` checks task → agent → provider hierarchy
   - `getModelForLevel()` maps thinking levels to actual models
   - `isLocalPreferred()` identifies local-first execution opportunities

4. ✅ Execution lanes integrated into `subAgentSpawner.js`
   - `determineLane()` assigns lane based on task priority
   - `acquire()` and `waitForLane()` manage lane slots
   - `release()` frees lane on agent completion

5. ✅ Missions connected to proactive task generation
   - `generateMissionTasks()` generates tasks from active missions
   - Mission tasks inserted after user/system tasks, before idle review
   - Tasks respect `autonomyLevel` for approval requirements
3. Update `subAgentSpawner.js` to use thinking levels and context upgrader
4. Add lane acquisition before agent spawning
5. Connect missions to proactive task generation
