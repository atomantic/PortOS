# Codebase Structure

**Analysis Date:** 2026-02-26

## Directory Layout

```
PortOS/
├── .planning/
│   ├── codebase/              # Generated codebase analysis documents
│   └── ...
├── .changelog/                # Release changelogs (v0.10.x.md, etc)
├── .github/
│   └── workflows/             # GitHub Actions CI/CD
├── .claude/
│   └── commands/              # Claude Code custom commands
├── autofixer/                 # Autofixer standalone service
│   ├── server.js              # Autofixer API server
│   └── ui.js                  # Autofixer UI server
├── browser/                   # Browser automation service (Playwright CDP)
│   └── server.js              # CDP proxy and health check server
├── client/                    # React/Vite frontend
│   ├── src/
│   │   ├── main.jsx           # Vite entry point
│   │   ├── App.jsx            # Router setup and main layout
│   │   ├── index.css          # Tailwind imports
│   │   ├── pages/             # Route pages (~20 main pages)
│   │   ├── components/        # Reusable UI components (~140 files)
│   │   ├── hooks/             # Custom React hooks
│   │   ├── services/
│   │   │   ├── api.js         # HTTP client wrapper
│   │   │   └── socket.js      # Socket.IO connection singleton
│   │   └── utils/             # Utility functions
│   ├── public/                # Static assets (fonts, favicon)
│   └── dist/                  # Production build output
├── data/                      # Runtime JSON storage (gitignored)
│   ├── apps.json              # Registry of managed applications
│   ├── providers.json         # AI provider configurations
│   ├── runs/                  # AI run history
│   ├── prompts/               # Prompt templates
│   ├── cos/                   # Chief of Staff agent data
│   │   ├── memory/            # CoS memory/context
│   │   ├── agents/            # Sub-agent instances
│   │   ├── scripts/           # CoS script library
│   │   ├── missions/          # CoS mission definitions
│   │   └── reports/           # CoS execution reports
│   ├── brain/                 # Brain state (thoughts, digests, reviews)
│   ├── digital-twin/          # Digital twin profile data
│   ├── agents/                # Agent personalities and state
│   ├── meatspace/             # Meatspace (IRL) tracking data
│   └── screenshots/           # Captured screenshots
├── data.sample/               # Sample data templates (checked in)
│   ├── providers.json         # Sample provider config
│   ├── prompts/               # Default prompt templates
│   ├── cos/                   # Sample CoS structure
│   └── ...
├── docs/                      # Documentation
│   ├── PORTS.md               # Port allocation guide
│   ├── VERSIONING.md          # Version management
│   ├── features/              # Feature documentation
│   └── media/                 # Images and diagrams
├── scripts/                   # Utility scripts for setup and development
│   ├── dev-start.js           # Start PM2 with dev-specific config
│   ├── setup-data.js          # Initialize data directory
│   ├── setup-browser.js       # Configure browser environment
│   └── setup-ghostty.js       # Configure terminal
├── server/                    # Express.js backend
│   ├── index.js               # Server entry point, middleware, route mounting
│   ├── routes/                # HTTP route handlers (~50 route files)
│   │   ├── apps.js            # App registry CRUD
│   │   ├── agents.js          # Agent process management
│   │   ├── cos.js             # Chief of Staff routes
│   │   ├── brain.js           # Brain state management
│   │   ├── digital-twin.js    # Digital twin profile
│   │   ├── providers.js       # AI provider config extension
│   │   ├── runs.js            # AI run history
│   │   ├── prompts.js         # Prompt management
│   │   ├── health.js          # System health checks
│   │   ├── logs.js            # App log streaming
│   │   ├── git.js             # Git operations
│   │   ├── history.js         # Activity history
│   │   ├── commands.js        # Shell command execution
│   │   └── ... (30+ more)
│   ├── services/              # Business logic (~130 files)
│   │   ├── apps.js            # App registry persistence and caching
│   │   ├── pm2.js             # PM2 CLI wrapper
│   │   ├── agents.js          # Agent lifecycle management
│   │   ├── cos.js             # Chief of Staff orchestration
│   │   ├── brain.js           # Brain state management
│   │   ├── digital-twin.js    # Digital twin operations
│   │   ├── socket.js          # Socket.IO event handlers
│   │   ├── errorHandler.js    # Socket.IO error broadcasting
│   │   ├── autoFixer.js       # Error recovery automation
│   │   ├── providers.js       # AI provider management (toolkit wrapper)
│   │   ├── runner.js          # AI CLI execution (toolkit wrapper)
│   │   ├── history.js         # Activity logging
│   │   ├── usage.js           # Usage tracking
│   │   ├── pm2Standardizer.js # Auto-configure PM2 ecosystem files
│   │   ├── streamingDetect.js # Detect app config from repo
│   │   └── ... (100+ more)
│   ├── lib/                   # Shared utilities (~30 files)
│   │   ├── validation.js      # Zod schemas for all entities
│   │   ├── errorHandler.js    # ServerError class and middleware
│   │   ├── fileUtils.js       # File I/O and path constants
│   │   ├── logger.js          # Logging utilities
│   │   ├── taskParser.js      # Parse task descriptions
│   │   ├── brainValidation.js # Brain schema validation
│   │   ├── digitalTwinValidation.js # Digital twin schema validation
│   │   ├── memoryValidation.js # Memory schema validation
│   │   ├── bm25.js            # BM25 search algorithm
│   │   ├── vectorMath.js      # Vector operations
│   │   └── ... (more)
│   ├── cos-runner/            # CoS isolated process
│   │   └── index.js           # Spawn Claude CLI agents
│   ├── integrations/          # External platform integrations
│   │   ├── moltworld/         # Moltworld integration
│   │   └── moltbook/          # Moltbook integration
│   ├── scripts/               # Standalone utility scripts
│   │   └── ... (various data prep scripts)
│   ├── data/                  # Symlink to ../data for local references
│   └── node_modules/
├── shell/                     # Terminal/shell customization
│   ├── themes/                # Terminal color themes
│   └── shaders/               # Terminal shader configs
├── ecosystem.config.cjs       # PM2 process configuration
├── package.json               # Root workspace package
├── package-lock.json
├── vite.config.js             # Vite build config (if at root)
└── CLAUDE.md                  # Developer instructions
```

## Directory Purposes

**`.planning/codebase/`:**
- Purpose: Generated analysis documents for GSD orchestrator
- Contains: ARCHITECTURE.md, STRUCTURE.md, CONVENTIONS.md, TESTING.md, CONCERNS.md
- Key files: None (auto-generated)

**`client/src/pages/`:**
- Purpose: Route-level page components (one per major feature)
- Contains: Dashboard, Apps, ChiefOfStaff, Brain, DigitalTwin, DevTools, etc.
- Key files: `Dashboard.jsx` (homepage), `Apps.jsx` (app management)

**`client/src/components/`:**
- Purpose: Reusable UI components organized by feature
- Contains: Base components (Layout, AppTile, BrailleSpinner) + feature-specific subdirs (city/, cos/, brain/, digital-twin/, etc.)
- Key files: `Layout.jsx` (main shell with sidebar), `AppIcon.jsx` (app icon renderer)

**`client/src/hooks/`:**
- Purpose: Custom React hooks for reusable logic
- Contains: useErrorNotifications (toast subscription), useSocket (singleton access), useTheme, useCityData, etc.
- Key files: `useErrorNotifications.js` (subscribes to Socket.IO error events)

**`server/routes/`:**
- Purpose: HTTP route handlers for specific features
- Contains: CRUD operations with Zod validation, delegates to services
- Key files: `apps.js` (150+ lines), `cos.js` (45K+ lines), `brain.js`, `agents.js`

**`server/services/`:**
- Purpose: Business logic and state management
- Contains: File I/O, PM2 management, event publishing, domain-specific workflows
- Key files: `apps.js` (registry + caching), `cos.js` (129K+ CoS orchestration), `pm2.js` (process control)

**`server/lib/`:**
- Purpose: Shared infrastructure and utilities
- Contains: Zod schemas, error handling, file operations, validation logic
- Key files: `validation.js` (14K+ agent/account/brain schemas), `errorHandler.js`, `fileUtils.js`

**`server/cos-runner/`:**
- Purpose: Isolated process for spawning long-running Claude CLI agents
- Contains: CoS agent spawner, process lifecycle management
- Key files: `index.js` (must not auto-restart with main server)

**`data/`:**
- Purpose: Runtime JSON storage (all app state, user data)
- Contains: JSON files for apps, providers, runs, prompts, agents, CoS memory, brain state, etc.
- Generated by: Services via fileUtils, AI toolkit

**`data.sample/`:**
- Purpose: Template data checked into git for bootstrapping new instances
- Contains: Sample provider configs, prompt templates, CoS mission examples
- Key files: `providers.json` (template AI providers)

## Key File Locations

**Entry Points:**
- Server: `server/index.js` (Express setup, route mounting, Socket.IO init)
- Client: `client/src/main.jsx` → `App.jsx` (Router setup)
- CoS Runner: `server/cos-runner/index.js` (Isolated agent spawner)
- PM2 Config: `ecosystem.config.cjs` (Process definitions)

**Configuration:**
- PM2: `ecosystem.config.cjs` (port allocation, env setup)
- Vite: `client/vite.config.js` (build config)
- Tailwind: `client/tailwind.config.js` (design tokens)
- AI Toolkit: `server/services/providers.js` (extends toolkit config)

**Core Logic:**
- App Management: `server/services/apps.js` (registry), `server/routes/apps.js` (API)
- PM2 Control: `server/services/pm2.js` (CLI wrapper), `routes/apps.js` (process endpoints)
- AI Execution: `server/services/runner.js` (toolkit wrapper), `routes/runs.js` (history)
- Error Handling: `server/lib/errorHandler.js` (ServerError + middleware), `services/socket.js` (broadcasting)

**Testing:**
- Unit Tests: Co-located with services, e.g., `services/apps.test.js`
- Test Config: `server/package.json` defines vitest/jest commands
- Key test files: `services/autobiography.test.js`, `services/brain.test.js`

## Naming Conventions

**Files:**
- Services: camelCase, descriptive (e.g., `agentActionExecutor.js`, `automationScheduler.js`)
- Routes: Match resource name (e.g., `apps.js`, `cos.js`)
- Components: PascalCase, descriptive (e.g., `SystemHealthWidget.jsx`)
- Pages: PascalCase, match route (e.g., `ChiefOfStaff.jsx`, `DigitalTwin.jsx`)
- Utilities: camelCase (e.g., `taskParser.js`, `vectorMath.js`)

**Directories:**
- Feature directories: kebab-case (e.g., `digital-twin/`, `cos-runner/`)
- Component categories: lowercase plural (e.g., `components/city/`, `hooks/`)
- Data domains: kebab-case (e.g., `data/digital-twin/`, `data/brain/`)

## Where to Add New Code

**New Feature:**
- Primary code: `server/services/{feature}.js` (business logic)
- Route handler: `server/routes/{feature}.js` (API endpoints)
- Tests: `server/services/{feature}.test.js`
- Schemas: Add to `server/lib/validation.js` or create `server/lib/{feature}Validation.js`
- Client: Create `client/src/pages/{Feature}.jsx` for new page

**New Component/Module:**
- Reusable components: `client/src/components/{Component}.jsx`
- Feature-specific components: `client/src/components/{feature}/`
- Hooks: `client/src/hooks/use{Hook}.js`
- Services: `server/services/{service}.js` (follow existing patterns)

**Utilities:**
- Shared server utilities: `server/lib/{utility}.js`
- Validation schemas: `server/lib/{domain}Validation.js`
- Client utilities: `client/src/utils/{utility}.js`
- API methods: Add to `client/src/services/api.js`

## Special Directories

**`data/`:**
- Purpose: All runtime application state
- Generated: Yes (by services at runtime)
- Committed: No (gitignored)
- Persistence: JSON files, watched by services for changes

**`data.sample/`:**
- Purpose: Bootstrap templates for new instances
- Generated: No (checked in manually)
- Committed: Yes (part of repo)
- Usage: Copied or referenced during setup

**`docs/`:**
- Purpose: User and developer documentation
- Key files: `PORTS.md` (port allocation), `VERSIONING.md` (release process)
- Maintenance: Update when architecture changes

**`shell/`:**
- Purpose: Terminal environment customization
- Contains: Theme files, shader configs
- Used by: `setup-ghostty.js` during initialization

**`autofixer/`:**
- Purpose: Standalone microservice for error recovery
- Contains: `server.js` (API), `ui.js` (UI server)
- Managed by: PM2 process (separate from main server)

**`browser/`:**
- Purpose: Browser automation via Playwright CDP
- Contains: CDP proxy server with health checks
- Managed by: PM2 process (separate, bound to localhost only)

---

*Structure analysis: 2026-02-26*
