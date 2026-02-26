# Architecture

**Analysis Date:** 2026-02-26

## Pattern Overview

**Overall:** Monorepo with centralized Express.js backend serving multiple PM2-managed processes and a Vite/React frontend

**Key Characteristics:**
- Multi-process orchestration via PM2 (server, UI, CoS agent runner, autofixer, browser automation)
- Layered backend (routes → services → lib utilities)
- Validation-first approach with Zod schemas
- Centralized error handling with Socket.IO event broadcasting
- JSON file persistence in `/data/` directory
- Functional React components with custom hooks for state management

## Layers

**Presentation (Client):**
- Purpose: User interface for monitoring, controlling, and configuring PortOS and managed apps
- Location: `client/src/`
- Contains: React pages, reusable components, service clients, hooks, utilities
- Depends on: HTTP API via `api.js`, WebSocket via `socket.js`
- Used by: End users via Vite dev server (port 5555) or production build

**API Layer (Routes):**
- Purpose: HTTP request handlers that validate input and delegate to services
- Location: `server/routes/`
- Contains: Route handlers for apps, agents, CoS, brain, digital-twin, providers, etc.
- Depends on: Services (business logic), lib/validation.js (Zod schemas)
- Used by: Express app, consumed by client via HTTP

**Business Logic (Services):**
- Purpose: Core application logic, PM2 management, file I/O, event publishing
- Location: `server/services/`
- Contains: ~100+ service files managing apps, agents, CoS runner, brain, digital-twin, providers, etc.
- Depends on: lib/ (validation, error handling, file utils), PM2, Socket.IO
- Used by: Routes, other services, scheduled tasks

**Validation & Utilities (Lib):**
- Purpose: Shared schemas, error handling, file operations, platform detection
- Location: `server/lib/`
- Contains: Zod validation schemas, error handler, file utilities, vector math, task parsing
- Depends on: Zod, fs/promises
- Used by: Routes, services, Socket.IO validation

**Data Persistence:**
- Purpose: Store application state in JSON files
- Location: `data/` directory (runtime), `data.sample/` (template)
- Contains: apps.json, providers.json, runs/, prompts/, cos/, agents/, brain/, digital-twin/, meatspace/
- Accessed by: Services via fileUtils and custom loaders

**External Integration (portos-ai-toolkit):**
- Purpose: AI provider management, run tracking, prompt templating
- Location: External npm module at `../portos-ai-toolkit`
- Contains: Provider drivers, CLI runner, hooks system
- Integrated at: `server/index.js` creates toolkit instance, routes extend it

**Process Management (PM2):**
- Purpose: Orchestrate multi-process lifecycle
- Location: `ecosystem.config.cjs` (configuration), `server/cos-runner/index.js` (isolated CoS runner)
- Contains: Process definitions for server, UI, CoS runner, autofixer, browser service
- Managed by: PM2 CLI, PortOS routes use pm2Service for control

## Data Flow

**Typical Request Flow:**

1. Client initiates HTTP request via `services/api.js`
2. Express route handler (`server/routes/*.js`) receives request
3. Route validates input using Zod schema from `lib/validation.js`
4. Route calls service(s) via `server/services/`
5. Service executes business logic (file I/O, PM2 commands, external APIs)
6. Route responds with JSON result or throws ServerError
7. ErrorMiddleware catches errors, emits Socket.IO event, returns error response
8. Client displays response or error toast notification

**WebSocket Flow (Real-time Updates):**

1. Client subscribes via socket event (e.g., `detect:start`, `logs:subscribe`)
2. `services/socket.js` handles event with validation
3. Socket handler spawns long-running operation (detection, streaming logs)
4. Handler emits progress updates back via `socket.emit()`
5. Service publishes state change events (e.g., `apps:changed`)
6. All connected clients receive broadcast update

**State Management:**
- Server: JSON files + in-memory caches (e.g., `appsCache` in `services/apps.js`)
- Client: React state via hooks + Socket.IO subscriptions + API fetches
- Cache invalidation: File watchers, event emitters, TTL-based caching

## Key Abstractions

**App Registry:**
- Purpose: Track managed applications (PortOS itself, user projects)
- Examples: `server/services/apps.js`, routes/apps.js
- Pattern: In-memory cache (2s TTL) backed by `data/apps.json`, EventEmitter for subscriptions

**PM2 Service Layer:**
- Purpose: Abstract PM2 CLI commands behind consistent interface
- Examples: `server/services/pm2.js`, `pm2Standardizer.js`
- Pattern: Spawn child processes, parse output, return typed results

**Zod Validation:**
- Purpose: Runtime schema validation at API boundary
- Examples: `lib/validation.js`, `lib/digitalTwinValidation.js`, `lib/brainValidation.js`
- Pattern: Define schemas once, validate in routes and Socket.IO handlers

**Error Broadcasting:**
- Purpose: Propagate server errors to all UI clients in real-time
- Examples: `lib/errorHandler.js`, `services/autoFixer.js`
- Pattern: ServerError with metadata → errorMiddleware → Socket.IO `error:occurred` event → Toast UI

**AI Toolkit Integration:**
- Purpose: Centralize AI provider configuration and execution tracking
- Examples: `server/services/providers.js`, `runner.js`, routes/providers.js
- Pattern: Import toolkit, extend routes, set hooks for PortOS lifecycle tracking

## Entry Points

**Server Initialization:**
- Location: `server/index.js`
- Triggers: `npm run dev` or `pm2 start ecosystem.config.cjs`
- Responsibilities: Create Express app, initialize Socket.IO, load routes, set middleware, start HTTP server on port 5554

**Client Initialization:**
- Location: `client/src/main.jsx` → `App.jsx`
- Triggers: Vite dev server (port 5555) or production build
- Responsibilities: Set up React Router, initialize hooks, load Layout component with nested routes

**PM2 CoS Runner Process:**
- Location: `server/cos-runner/index.js`
- Triggers: Spawned by PM2 (separate process, not watched)
- Responsibilities: Run isolated Claude CLI agent instances, prevent orphaned processes

**Autofixer Service:**
- Location: `autofixer/server.js`
- Triggers: PM2 spawned process (port 5559)
- Responsibilities: Listen for error events, execute recovery scripts, report status

## Error Handling

**Strategy:** Catch errors at route level, emit Socket.IO events, let client display toast

**Patterns:**
- Routes use `asyncHandler` wrapper to catch Promise rejections
- Services throw `ServerError` with status, code, context
- `errorMiddleware` catches uncaught errors and emits via Socket.IO
- Client hook `useErrorNotifications` subscribes to `error:occurred` events
- Platform errors (PLATFORM_UNAVAILABLE) emit as warnings, not errors

## Cross-Cutting Concerns

**Logging:** Single-line format with emoji prefixes, string interpolation
- Example: `console.log('🚀 Server started on port ${PORT}')`
- Used in: All services and routes

**Validation:** Zod schemas defined in `lib/validation.js` and domain-specific files
- Routes call `validateRequest(schema, data, next)`
- Socket.IO calls `validateSocketData(schema, rawData, socket, eventName)`

**Authentication:** Not applicable (single-user, internal tool behind Tailscale VPN)

**File I/O:** Centralized through `lib/fileUtils.js` with consistent PATHS constants
- Services use `readJSONFile()`, `writeFile()`, `ensureDir()`

**Process Management:** PM2 commands abstracted via `services/pm2.js`
- All process lifecycle operations go through pm2Service

---

*Architecture analysis: 2026-02-26*
