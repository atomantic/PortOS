# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install all dependencies
npm run install:all

# Start (builds client, serves production UI + API on port 5555)
npm start

# Development (Vite hot-reload on 5554, API on 5555)
npm run dev

# Run tests
cd server && npm test
cd server && npm run test:watch  # Watch mode

# PM2 management
pm2 start ecosystem.config.cjs
pm2 stop ecosystem.config.cjs
pm2 logs
```

## Security Model

PortOS is a **single-user, single-instance** application running on a private network behind Tailscale VPN. It is not exposed to the public internet. There is exactly one user and one server process — concurrent request races, mutex locking on file I/O, and atomic write patterns are unnecessary and should not be added or flagged as concerns. Simple re-entrancy guards (e.g., per-account sync locks to prevent duplicate in-flight operations) are fine and expected. As such, it intentionally omits authentication, CORS restrictions, rate limiting, HTTPS, and full concurrency controls — these are non-issues for its deployment context. Do not add these or flag their absence as security concerns.

The default database password `portos` (in `ecosystem.config.cjs`, `docker-compose.yml`, and `.env.example`) is an intentional backward-compatible fallback for local development. Do not remove it or flag it as a security concern. Production deployments override it via the `PGPASSWORD` environment variable.

## Architecture

PortOS is a monorepo with Express.js server (port 5555) and React/Vite client (port 5554). PM2 manages app lifecycles. Data persists to JSON files in `./data/`.

### Port Allocation

PortOS uses ports 5554-5561. In native mode, PostgreSQL uses the system pg on port 5432; in Docker mode, port 5561. Define all ports in `ecosystem.config.cjs` using the `ports` object:

```javascript
ports: { api: 5555, health: 5554 }  // labeled ports for documentation
```

See `docs/PORTS.md` for the full port allocation guide.

### Server (`server/`)
- **Routes**: HTTP handlers with Zod validation
- **Services**: Business logic, PM2/file/Socket.IO operations
- **Lib**: Shared validation schemas

### Client (`client/src/`)
- **Pages**: Route-based components
- **Components**: Reusable UI elements
- **Services**: `api.js` (HTTP) and `socket.js` (WebSocket)
- **Hooks**: `useErrorNotifications.js` subscribes to server errors, shows toast notifications

### Data Flow
Client → HTTP/WebSocket → Routes (validate) → Services (logic) → JSON files/PM2

### AI Toolkit (`portos-ai-toolkit`)

PortOS depends on `portos-ai-toolkit` as an npm module for AI provider management, run tracking, and prompt templates. The toolkit is a separate project located at `../portos-ai-toolkit` and published to npm.

**Key points:**
- Provider configuration (models, tiers, fallbacks) is managed by the toolkit's `providers.js`
- PortOS extends toolkit routes in `server/routes/providers.js` for vision testing and provider status
- When adding new provider fields (e.g., `fallbackProvider`, `lightModel`), update the toolkit's `createProvider()` function
- The toolkit uses spread in `updateProvider()` so existing providers preserve custom fields, but `createProvider()` has an explicit field list
- After updating the toolkit, run `npm update portos-ai-toolkit` in PortOS to pull changes

## Scope Boundary

When CoS agents or AI tools work on managed apps outside PortOS, all research, plans, docs, and code for those apps must be written to the target app's own repository/directory -- never to this repo. PortOS stores only its own features, plans, and documentation. If an agent generates a PLAN.md, research doc, or feature spec for another app, it goes in that app's directory.

## Code Conventions

- **No try/catch** - errors bubble to centralized middleware
- **No window.alert/confirm** - use inline confirmations or toast notifications
- **Linkable routes for all views** - tabbed pages use URL params, not local state (e.g., `/devtools/history` not `/devtools` with tab state)
- **Functional programming** - no classes, use hooks in React
- **Zod validation** - all route inputs validated via `lib/validation.js`
- **Command allowlist** - shell execution restricted to approved commands only
- **Mobile responsive** - all pages should be mobile responsive friendly
- **Above the fold** - keep actionable content and info above the fold and design pages for maximum information and access without scrolling
- **No hardcoded localhost** - use `window.location.hostname` for URLs; app accessed via Tailscale remotely
- **Alphabetical navigation** - sidebar nav items in `Layout.jsx` are alphabetically ordered after the Dashboard+CyberCity top section and separator; children within collapsible sections are also alphabetical
- **Reactive UI updates** - after mutations (delete, create, update), update local state directly instead of refetching the entire list from the server. Use `setState(prev => prev.filter(...))` or similar patterns for immediate feedback
- **Single-line logging** - use emoji prefixes and string interpolation, never log full JSON blobs or arrays
  ```js
  console.log(`🚀 Server started on port ${PORT}`);
  console.log(`📜 Processing ${items.length} items`);
  console.error(`❌ Failed to connect: ${err.message}`);
  ```

## Tailwind Design Tokens

```
port-bg: #0f0f0f       port-card: #1a1a1a
port-border: #2a2a2a   port-accent: #3b82f6
port-success: #22c55e  port-warning: #f59e0b
port-error: #ef4444
```

## Git Workflow

- **main**: Active development
- **release**: Push `main` to `release` to trigger GitHub Release workflow
- **Push pattern**: `git pull --rebase --autostash && git push`
- **Changelog**: Append entries to `.changelog/NEXT.md` during development; `/do:release` (Claude Code slash command) finalizes it into a versioned file
- **Versioning**: Version in `package.json` reflects the last release. Do not bump during development — `/do:release` handles version bumps
- After each feature or bug fix, run `/simplify` and then commit and push code
- If we have created enough commits to wrap up a feature or issue to warrant a production release, pull the latest main and release branches and then run `/do:release` from main

See `.changelog/README.md` for detailed format and best practices.
