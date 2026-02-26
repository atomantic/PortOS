# Coding Conventions

**Analysis Date:** 2026-02-26

## Naming Patterns

**Files:**
- Kebab-case for all files: `apps.js`, `errorHandler.js`, `asyncMutex.js`
- Test files: `{name}.test.js` or `{name}.spec.js` (e.g., `validation.test.js`, `apps.test.js`)
- Integration tests: `{name}.integration.test.js` (e.g., `visionTest.integration.test.js`)
- Route files grouped by domain: `routes/apps.js`, `routes/health.js`, `routes/cos.js`
- Service files grouped by domain: `services/apps.js`, `services/pm2.js`, `services/history.js`
- Library/utility files in `lib/`: `lib/validation.js`, `lib/errorHandler.js`, `lib/logger.js`
- React components: PascalCase with `.jsx` extension: `Layout.jsx`, `Logo.jsx`, `NotificationDropdown.jsx`

**Functions:**
- camelCase for all functions: `asyncHandler`, `validateRequest`, `normalizeError`, `getAppById`, `createApp`
- Prefix boolean functions with `is` or `has` where applicable: `existsSync`, `hasLength`
- Event handlers prefixed with appropriate verb: `handleError`, `handleRecoveryRequested`, `handleCriticalError`

**Variables:**
- camelCase for all variables: `pm2Home`, `statusValues`, `overallStatus`, `mockApps`, `mockPm2Processes`
- Constant-like data structures in camelCase (not SCREAMING_SNAKE_CASE): `PORTOS_APP_ID`, `APPS_FILE`, `DATA_DIR`, `API_BASE`
- Private/internal variables can use underscore prefix: `_internal`
- Event emitter instances: `appsEvents`, `errorEvents`, `cosEvents`

**Types:**
- Zod schemas use descriptive names ending with `Schema`: `appSchema`, `processSchema`, `providerSchema`, `agentPersonalitySchema`, `platformAccountSchema`
- Partial update schemas use naming pattern: `{type}UpdateSchema` (e.g., `appUpdateSchema`)
- Enum schemas follow pattern: `{type}TypeSchema` (e.g., `personalityStyleSchema`, `platformTypeSchema`)

## Code Style

**Formatting:**
- No explicit ESLint or Prettier config found
- ES Module syntax (`import`/`export`) required in all files (`"type": "module"` in package.json)
- 2-space indentation (observed in codebase)
- No semicolons suppressed (semicolons present throughout)

**Linting:**
- No ESLint configuration detected
- Code relies on natural JavaScript conventions

## Import Organization

**Order:**
1. Node.js built-in modules: `import { Router } from 'express'`, `import { spawn } from 'child_process'`, `import { EventEmitter } from 'events'`
2. Third-party packages: `import express from 'express'`, `import { z } from 'zod'`, `import toast from 'react-hot-toast'`
3. Local modules (relative imports): `import * as appsService from '../services/apps.js'`, `import { validateRequest } from '../lib/validation.js'`
4. Local specific imports after wildcard imports

**Path Aliases:**
- No path aliases configured (uses relative paths: `../services/`, `../lib/`, `./components/`)
- Server-side: Uses consistent relative path depth from routes/services to lib
- Client-side: Uses relative imports from services, hooks, components directories

## Error Handling

**Patterns:**
- No try/catch blocks (per CLAUDE.md conventions) — errors bubble to centralized middleware
- Async route handlers wrapped with `asyncHandler()` middleware defined in `errorHandler.js`
- `ServerError` class used for structured error creation with metadata
- `normalizeError()` function converts any error type to `ServerError` for consistency
- HTTP status codes map to error codes: `404 → NOT_FOUND`, `400 → BAD_REQUEST`, `422 → VALIDATION_ERROR`
- Error context object attached to errors for additional debugging info: `{ context: { resource: 'user' } }`
- Errors emit Socket.IO events for client notification (see `emitErrorEvent()`)
- `PLATFORM_UNAVAILABLE` errors treated as warnings rather than critical errors

Example from `server/routes/apps.js`:
```javascript
const loadApp = asyncHandler(async (req, res, next) => {
  const app = await appsService.getAppById(req.params.id);
  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }
  req.loadedApp = app;
  next();
});
```

## Logging

**Framework:** `console` (no external logging library)

**Patterns:**
- Single-line logging with emoji prefixes (per CLAUDE.md conventions)
- Never log full JSON blobs or arrays
- Use string interpolation for values
- Logger utility functions in `server/lib/logger.js`:
  - `startup()` → 🚀 (initialization messages)
  - `process()` → 📜 (operation progress)
  - `error()` → ❌ (errors to console.error)
  - `success()` → ✅ (successful operations)
  - `config()` → 🔧 (configuration changes)
  - `feature()` → 🎉 (new features)
  - `bug()` → 🐛 (bug detection)
  - `info()` → ℹ️ (informational messages)
  - `warning()` → ⚠️ (deprecations, warnings to console.warn)
  - `debug()` → 🔍 (debug traces)

Example patterns:
```javascript
console.log(`🚀 Server started on port ${PORT}`);
console.log(`📜 Processing ${items.length} items`);
console.error(`❌ Failed to connect: ${err.message}`);
```

## Comments

**When to Comment:**
- JSDoc/TSDoc comments on exported functions: `/** * Utility description * @param {type} name - description */`
- Explain "why" not "what" for complex logic
- Comments above sections: `// =============================================================================`
- Inline comments for non-obvious logic, but sparingly

Example from `server/lib/validation.js`:
```javascript
// =============================================================================
// AGENT PERSONALITY SCHEMAS
// =============================================================================

// Agent personality style
export const personalityStyleSchema = z.enum([
  'professional',
  'casual',
  'witty',
  'academic',
  'creative'
]);
```

## Function Design

**Size:** Functions are generally focused on single responsibility, ranging 5-40 lines

**Parameters:**
- Destructured parameters for objects: `asyncHandler(async (req, res, next) => { ... })`
- Optional options objects as last parameter: `readJSONFile(APPS_FILE, { apps: {} })`
- Middleware pattern for Express routes: `(req, res, next) => { ... }`

**Return Values:**
- Handlers return void (Express middleware)
- Services return Promises (async functions)
- Utility functions return data or Promise<data>
- Schema validation returns result object: `{ success: boolean, data?: T, errors?: Array }`

Example from `server/routes/apps.js`:
```javascript
router.get('/', asyncHandler(async (req, res) => {
  const apps = await appsService.getAllApps();
  // ... enrichment logic ...
  res.json(enriched);
}));
```

## Module Design

**Exports:**
- Named exports for most utilities and services: `export const getAppById = async (id) => { ... }`
- Default exports rarely used
- Service modules export both data and functions: `export const PORTOS_APP_ID = 'portos-default'`, `export async function getAllApps() { ... }`

**Barrel Files:**
- Minimal use of barrel files; prefer specific imports
- Routes/services imported with wildcard: `import * as appsService from '../services/apps.js'`

## Async Patterns

**Promise handling:**
- Async/await preferred over .then() chains
- Error handling via asyncHandler wrapper, not try/catch
- Promise.all() for concurrent operations with settled promises when appropriate

Example from `server/routes/apps.js`:
```javascript
const enriched = await Promise.all(apps.map(async (app) => {
  const pm2Home = app.pm2Home || null;
  const pm2Map = pm2Maps.get(pm2Home) || new Map();
  // ... processing logic ...
  return { ...app, pm2Status: statuses, overallStatus };
}));
```

## React/Client Conventions

**Hooks:**
- Functional components with hooks only (no classes)
- Custom hooks file naming: `use{Purpose}.js` (e.g., `useErrorNotifications.js`, `useNotifications.js`)
- Hooks return object with methods: `return { requestAutoFix }`

**Component Organization:**
- Components in `client/src/components/`
- Pages in `client/src/pages/` (route-based)
- Services in `client/src/services/` (API and WebSocket)
- Custom hooks in `client/src/hooks/`
- Utilities in `client/src/utils/`

**Navigation:**
- Sidebar nav items in `Layout.jsx` organized alphabetically (after Dashboard + CyberCity section and separator)
- URL params for tabbed pages instead of local state: `/devtools/history` not `/devtools` with internal state
- All views must be linkable routes

**UI Patterns:**
- No `window.alert()` or `window.confirm()` — use toast notifications via `react-hot-toast`
- Toast notifications with emoji icons: `toast()`, `toast.error()`, `toast.success()`
- Example: `toast('Recovery agent dispatched', { icon: '🔧' })`

Example hook from `client/src/hooks/useErrorNotifications.js`:
```javascript
export function useErrorNotifications() {
  const requestAutoFix = useCallback((errorCode, context) => {
    socket.emit('error:recover', { code: errorCode, context });
    toast('Recovery agent dispatched', { icon: '🔧' });
  }, []);

  useEffect(() => {
    socket.emit('errors:subscribe');
    // ... handlers setup ...
    return () => {
      socket.off('error:occurred', handleError);
    };
  }, []);

  return { requestAutoFix };
}
```

## Data Validation

**Zod Schemas:**
- All route inputs validated via Zod schemas in `server/lib/validation.js`
- `validateRequest(schema, data)` wrapper function normalizes validation results
- Validation result format: `{ success: boolean, data?: T, errors?: Array<{ path: string, message: string }> }`
- Schemas define defaults, optional fields, and constraints

Example:
```javascript
export const appSchema = z.object({
  name: z.string().min(1).max(100),
  repoPath: z.string().min(1),
  type: z.string().default('express'),
  uiPort: z.number().int().min(1).max(65535).nullable().optional(),
  processes: z.array(processSchema).optional()
});
```

---

*Convention analysis: 2026-02-26*
