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
npm run pm2:start
npm run pm2:stop
npm run pm2:logs
```

## Architecture

PortOS is a monorepo with Express.js server (port 5554) and React/Vite client (port 5555). PM2 manages app lifecycles. Data persists to JSON files in `./data/`.

### Port Allocation

PortOS uses ports 5554-5560. Define all ports in `ecosystem.config.cjs` using the `ports` object:

```javascript
ports: { api: 5554, health: 5555 }  // labeled ports for documentation
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

## Code Conventions

- **No try/catch** - errors bubble to centralized middleware
- **No window.alert/confirm** - use inline confirmations or toast notifications
- **Linkable routes for all views** - tabbed pages use URL params, not local state (e.g., `/devtools/history` not `/devtools` with tab state)
- **Functional programming** - no classes, use hooks in React
- **Zod validation** - all route inputs validated via `lib/validation.js`
- **Command allowlist** - shell execution restricted to approved commands only
- **No hardcoded localhost** - use `window.location.hostname` for URLs; app accessed via Tailscale remotely
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
- Update `.changelog/v{major}.{minor}.x.md` when making changes (see Release Changelog Process below)
- commit code after each feature or bug fix

See `docs/VERSIONING.md` for details.

## Release Changelog Process

All release notes are maintained in `.changelog/v{major}.{minor}.x.md` files (e.g., `.changelog/v0.10.x.md`). Each minor version series has a single changelog file that accumulates changes throughout development.

### Starting a New Minor Version

When `dev` is bumped to a new minor version (e.g., 0.10.0), create a new changelog file:

```bash
# Copy previous version as template
cp .changelog/v0.9.x.md .changelog/v0.10.x.md
# Edit to clear content but keep structure
# Keep version as "v0.10.x" (literal x, not a placeholder)
```

### During Development

**Always update `.changelog/v0.10.x.md`** when you make changes:
- Add entries under appropriate emoji sections (🎉 Features, 🐛 Fixes, 🔧 Improvements, 🗑️ Removed)
- Keep the version as `v0.10.x` throughout development (don't change it to 0.10.1, 0.10.2, etc.)
- Group related changes together for clarity
- Explain the "why" not just the "what"

### Before Releasing to Main

Final review before merging `dev → main`:
- Ensure all changes are documented in `.changelog/v0.10.x.md`
- Add the release date (update "YYYY-MM-DD" to actual date)
- Polish descriptions for clarity
- Commit the changelog

### On Release (Automated)

When you merge to `main`, the GitHub Actions workflow automatically:
1. Reads `.changelog/v0.10.x.md`
2. Replaces all instances of `0.10.x` with actual version (e.g., `0.10.5`)
3. Creates the GitHub release with substituted changelog
4. Checks out dev branch
5. Renames `v0.10.x.md` → `v0.10.5.md` using `git mv` (preserves git history)
6. Commits the renamed file to dev: `"docs: archive changelog for v0.10.5 [skip ci]"`
7. Cherry-picks that commit to main
8. Bumps dev to next minor version (e.g., 0.11.0)

**Result:**
- Both `dev` and `main` have `.changelog/v0.10.5.md` matching the tagged release
- Git history shows: `v0.10.x.md` → `v0.10.5.md` (rename)
- You create `.changelog/v0.11.x.md` to start the next development cycle

See `.changelog/README.md` for detailed format and best practices.
