# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install all dependencies
npm run install:all

# Development (both server and client)
npm run dev

# Run tests
cd server && npm test
cd server && npm run test:watch  # Watch mode

# Production
pm2 start ecosystem.config.cjs
pm2 logs
```

## Architecture

PortOS is a monorepo with Express.js server (port 5554) and React/Vite client (port 5555). PM2 manages app lifecycles. Data persists to JSON files in `./data/`.

### Server (`server/`)
- **Routes**: HTTP handlers with Zod validation
- **Services**: Business logic, PM2/file/Socket.IO operations
- **Lib**: Shared validation schemas

### Client (`client/src/`)
- **Pages**: Route-based components
- **Components**: Reusable UI elements
- **Services**: `api.js` (HTTP) and `socket.js` (WebSocket)

### Data Flow
Client → HTTP/WebSocket → Routes (validate) → Services (logic) → JSON files/PM2

## Code Conventions

- **No try/catch** - errors bubble to centralized middleware
- **No window.alert/confirm** - use inline confirmations or toast notifications
- **Linkable routes for all views** - tabbed pages use URL params, not local state (e.g., `/devtools/history` not `/devtools` with tab state)
- **Functional programming** - no classes, use hooks in React
- **Zod validation** - all route inputs validated via `lib/validation.js`
- **Command allowlist** - shell execution restricted to approved commands only
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

- **dev**: Active development (auto-bumps patch on CI pass)
- **main**: Production releases only
- PR `dev → main` creates tagged release and preps next version
- **Use `/gitup` to push** - The dev branch receives auto version bump commits from CI. Always use `git pull --rebase --autostash && git push` (or `/gitup`) instead of plain `git push`.

See `docs/VERSIONING.md` for details.
