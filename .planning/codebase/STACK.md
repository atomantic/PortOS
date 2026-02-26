# Technology Stack

**Analysis Date:** 2026-02-26

## Languages

**Primary:**
- JavaScript (ES6 modules) - Across all server/client code
- JSX - React components in client code (`client/src/**/*.jsx`)

## Runtime

**Environment:**
- Node.js v22.21.1 (development; actual runtime flexible)
- npm v10.9.4

**Package Manager:**
- npm 10.9.4
- Lockfiles: `package-lock.json`, `server/package-lock.json`, `client/package-lock.json` (committed)

## Frameworks

**Backend:**
- Express.js ^4.21.2 - HTTP server and routing
- Socket.IO ^4.8.3 - Real-time bidirectional communication
- node-pty ^1.2.0-beta.10 - Terminal emulation and shell integration
- axios ^1.7.9 - HTTP client for external APIs
- ws ^8.18.0 - WebSocket library
- Zod ^3.24.1 - TypeScript-first schema validation

**Frontend:**
- React ^18.3.1 - UI framework
- React Router DOM ^7.1.1 - Client-side routing
- Vite ^6.0.6 - Build tool and dev server
- Tailwind CSS ^3.4.17 - Utility-first CSS framework
- PostCSS ^8.4.49 - CSS transformation
- Autoprefixer ^10.4.20 - CSS vendor prefixes

**3D Graphics & Terminal:**
- Three.js ^0.182.0 - WebGL 3D graphics
- @react-three/fiber ^8.18.0 - React renderer for Three.js
- @react-three/drei ^9.122.0 - Useful helpers for React Three
- @xterm/xterm ^6.0.0 - Terminal emulator (web)
- @xterm/addon-fit ^0.11.0 - XTerm fit addon
- @xterm/addon-web-links ^0.12.0 - XTerm web links addon

**UI Components & Interaction:**
- react-hot-toast ^2.6.0 - Toast notification system
- lucide-react ^0.562.0 - Icon library
- react-markdown ^10.1.0 - Markdown rendering
- recharts ^3.7.0 - React charting library
- geist ^1.7.0 - UI component library
- @dnd-kit/core ^6.3.1 - Drag-and-drop primitives
- @dnd-kit/sortable ^10.0.0 - Sortable drag-and-drop
- @dnd-kit/utilities ^3.2.2 - Drag-and-drop utilities
- fflate ^0.8.2 - JavaScript deflate compression
- socket.io-client ^4.8.3 - WebSocket client

**Development & Build:**
- Vite ^6.0.6 - Module bundler and dev server
- @vitejs/plugin-react ^4.3.4 - React plugin for Vite
- vitest ^4.0.16 - Unit test framework
- @vitest/coverage-v8 ^4.0.16 - Test coverage reporting
- supertest ^7.1.4 - HTTP assertion library

**Process Management:**
- PM2 ^5.4.3 - Application process manager (root and server deps)

**Utilities:**
- uuid ^11.0.3 - UUID generation
- cors ^2.8.5 - CORS middleware

## Key Dependencies

**Critical for AI Integration:**
- portos-ai-toolkit ^0.5.0 - Separate npm module for AI provider management, run tracking, and prompt templates
  - Located at `../portos-ai-toolkit` in development
  - Manages provider configuration (models, tiers, fallbacks)
  - Handles provider lifecycle and CLI execution

**External Service Integration:**
- axios - HTTP client for Jira, Moltbook, Moltworld APIs
- node-pty - Terminal spawning for shell commands and script execution
- ws - WebSocket connections for real-time features

**Validation & Error Handling:**
- Zod - Input validation for all Express routes
- Centralized error middleware in `server/lib/errorHandler.js`

## Configuration

**Environment:**
- Process environment variables via `ecosystem.config.cjs`:
  - `NODE_ENV`: 'development' (base)
  - `TZ`: 'UTC' (all timestamps in UTC)
  - `PORT`: 5554 (API), configurable per process
  - `HOST`: '0.0.0.0' (server), '127.0.0.1' (CDP/CoS)

**Build Configuration:**
- Vite config: `client/vite.config.js` (port 5555, API proxy to 5554)
- Tailwind config: `client/tailwind.config.js` (custom design tokens)
- PostCSS: `client/postcss.config.js` (Tailwind + Autoprefixer)
- Server test: `server/vitest.config.js` (30% coverage threshold)

**Asset Bundling:**
- Manual Vite chunks for vendor libraries:
  - `vendor-react`: React, React DOM, React Router
  - `vendor-realtime`: Socket.IO, React Hot Toast
  - `vendor-dnd`: @dnd-kit libraries
  - `vendor-icons`: lucide-react (largest)

## Platform Requirements

**Development:**
- Node.js v22.x (tested v22.21.1)
- npm v10.x
- Chrome/Chromium (for browser automation via CDP)
- Shell environment (bash/sh for command execution)

**Production:**
- Node.js runtime (same as development)
- PM2 for process orchestration (`ecosystem.config.cjs`)
- Chrome/Chromium (optional, for browser features)
- File system access for JSON data persistence

## Data Persistence

**Storage Method:**
- JSON files in `./data/` directory (not database)
- Key files:
  - `data/providers.json` - AI provider configurations
  - `data/runs/` - AI provider runs and results
  - `data/prompts/` - Prompt templates
  - `data/agents/` - Agent configurations
  - `data/jira.json` - JIRA instance configurations
  - `data/browser-config.json` - Browser CDP settings
  - `data/screenshots/` - Screenshots captured by agents
  - `data/apps.json` - Detected/monitored applications
  - `data/history.json` - Command history
  - `data/brain/` - Memory and learning data
  - `data/digital-twin/` - Identity and autobiography data

## Port Allocation

Defined in `ecosystem.config.cjs`:
- **5554**: Express API server (core PortOS backend)
- **5555**: Vite client dev server (React UI)
- **5556**: Chrome CDP (browser remote debugging)
- **5557**: Browser health check endpoint
- **5558**: Chief of Staff (CoS) agent runner
- **5559**: Autofixer API
- **5560**: Autofixer UI

---

*Stack analysis: 2026-02-26*
