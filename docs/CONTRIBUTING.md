# Contributing Guide

## Development Setup

```bash
# Clone and install
git clone https://github.com/atomantic/PortOS.git
cd PortOS
npm run install:all

# Start development
npm run dev

# Or with PM2
pm2 start ecosystem.config.cjs
```

## Code Guidelines

### General

- Favor functional programming over classes
- Keep code DRY (Don't Repeat Yourself)
- Follow YAGNI (You Aren't Gonna Need It)

### Frontend (React)

- Use functional components and hooks
- Use Tailwind CSS for all styling
- **No `window.alert` or `window.confirm`** - Use inline confirmation components or toast notifications
- **Linkable routes for all views** - Tabbed pages, sub-pages, and forms should have distinct URL routes for bookmarking/sharing

### Routing Pattern

```jsx
// Good - linkable routes
/devtools/history
/devtools/runner
/devtools/processes

// Bad - state-based tabs (not linkable)
/devtools (with local state for active tab)
```

### Backend (Express)

- Use Zod for request validation
- No shell interpolation - use spawn with arg arrays
- Command execution uses allowlist for security

## Git Workflow

See [VERSIONING.md](./VERSIONING.md) for full details.

### Quick Reference

1. Work on `dev` branch
2. Push triggers CI → auto-bumps build number
3. Create PR `dev` → `main` for releases
4. Merge triggers release creation + version prep

### Commit Messages

Use conventional commit format:

```
feat: add new feature
fix: resolve bug
build: version/CI changes
docs: documentation updates
refactor: code restructuring
```

## Project Structure

```
PortOS/
├── client/           # React + Vite frontend (port 5554)
│   └── src/
│       ├── components/
│       ├── pages/
│       └── services/
├── server/           # Express.js API (port 5555)
│   ├── routes/
│   ├── services/
│   └── lib/
├── data/             # Runtime data (gitignored)
├── docs/             # Documentation
└── .github/workflows # CI/CD
```

## Testing

```bash
# Run server tests
cd server && npm test

# Watch mode
cd server && npm run test:watch
```

## API Documentation

See [API.md](./API.md) for the complete REST API and WebSocket event reference.
