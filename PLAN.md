# PortOS — Development Plan

For project goals, see [GOALS.md](./GOALS.md). For completed work, see [DONE.md](./DONE.md).

---

## Next Up

1. **M34 P5-P7**: Digital Twin — Multi-modal capture, advanced testing, personas

## Backlog

- [ ] **God file decomposition** — cos.js done (→ cosState.js, cosAgents.js, cosReports.js, cosEvents.js; 31% reduction). Remaining: subAgentSpawner.js, digital-twin.js, routes/scaffold.js, routes/cos.js, client/api.js
- [ ] **Test coverage** — Critical gaps: cos.js, cosRunnerClient.js, agentActionExecutor.js (~29% service, ~12% route coverage)
- [ ] **M50 P9**: CoS Automation & Rules — Automated email classification, rule-based pre-filtering, email-to-task pipeline
- [ ] **M50 P10**: Auto-Send with AI Review Gate — Per-account trust level, second LLM reviews drafts. See [Messages Security](./docs/features/messages-security.md)

**Known low-severity:** pm2 ReDoS (GHSA-x5gf-qvw8-r2rm) — no upstream fix, not exploitable via PortOS routes.

---

## Depfree Audit — 2026-03-31 (Heavy Mode)

**Summary:** 50 unique dependencies across 4 packages. 30 Tier 1 (acceptable), 3 Tier 2 (audited & kept), 15 to remove, 2 kept (transitive — stays in lock file regardless). Estimated new owned code: ~1,205 lines across ~20 files.

**Prerequisite:** Run `npm install` in root, server, and client workspaces to sync lock files to newly pinned exact versions (lock files currently show `invalid` warnings).

### Dependencies to Remove

| Package | Location | Used Functions | Call Sites | Replacement | Complexity | Est. Lines |
|---------|----------|---------------|------------|-------------|------------|------------|
| `uuid` | server | `v4 as uuidv4` | 48 calls, 40 files | `crypto.randomUUID()` — create `server/lib/uuid.js` shim, update 40 imports | Trivial | ~5 |
| `axios` | server | `axios.create`, `.get/.post/.put/.delete`, `.interceptors.response.use` | 14 calls, 2 service files + 1 test | `server/lib/httpClient.js` — native fetch factory with timeout via `AbortSignal.timeout`, response interceptor inline in jira.js | Moderate | ~60 |
| `multer` | server | `multer()`, `multer.diskStorage()`, `fileFilter`, `limits` | 1 file (`routes/appleHealth.js`) | `server/lib/multipart.js` — stream multipart to tmp disk, size limit, MIME filter | Moderate | ~65 |
| `node-telegram-bot-api` | server | `new TelegramBot`, `getMe`, `onText`, `on`, `sendMessage`, `answerCallbackQuery`, `editMessageText`, `stopPolling` | 1 file (`services/telegram.js`) | `server/lib/telegramClient.js` — `fetch`-based polling loop, method wrappers, EventEmitter dispatch | Moderate | ~110 |
| `unzipper` | server | `Parse` (streaming ZIP parser), `.on('entry')`, `entry.pipe`, `entry.autodrain` | 1 file (`routes/appleHealth.js`) | `server/lib/zipStream.js` — minimal streaming ZIP parser via `zlib.createInflateRaw` + local-header parsing; emit entry events with `{ path, pipe, autodrain }` | Complex | ~175 |
| `supertest` | server (devDep) | `request(app).get/post/put/delete.send.expect` | ~172 calls, 9 test files | `server/tests/testHelper.js` — start HTTP server once per suite, return fetch-based `request()` wrapper | Moderate | ~45 |
| `geist` | client | Font files only (CSS `@font-face`) | 0 JS imports (CSS only) | Copy `GeistPixel-Square.woff2` + `GeistPixel-Grid.woff2` from `node_modules/geist/` to `client/public/fonts/`; update `index.css` url paths | Trivial | ~0 |
| `globals` | client (devDep) | `globals.browser`, `globals.node` | 1 file (`eslint.config.js`) | Inline explicit browser+node globals object directly in `eslint.config.js` (v16 is different major from transitive v14 via eslint → @eslint/eslintrc) | Trivial | ~30 |
| `react-markdown` | client | `ReactMarkdown` component with custom element renderers | 1 file (`components/cos/MarkdownOutput.jsx`) | Inline markdown parser in `MarkdownOutput.jsx` — regex pipeline for headings, bold, italic, code, lists, tables, links | Moderate | ~55 |
| `react-diff-viewer-continued` | client | `ReactDiffViewer` (splitView=false, useDarkTheme, hideLineNumbers, custom styles) | 1 file (`components/insights/CrossDomainTab.jsx`) | Inline character-diff component — own Myers diff algorithm, render spans with bg-green-900/bg-red-900 | Moderate | ~80 |
| `react-hot-toast` | client | `toast()`, `toast.success()`, `toast.error()`, `toast.dismiss()`, `<Toaster>` | 606 calls, 101 files | `client/src/components/ui/Toast.jsx` — React context + `useToast` hook + `<ToastContainer>` with queue, auto-dismiss, positioning | Moderate | ~100 |
| `@dnd-kit/core` | client | `DndContext`, `DragOverlay`, `useDraggable`, `useDroppable`, `PointerSensor`, `KeyboardSensor`, `useSensor`, `useSensors`, `closestCenter` | 4 files | `client/src/lib/dragDrop.jsx` — PointerSensor with 8px activation, KeyboardSensor, ARIA support, transform to CSS | Complex | ~130 |
| `@dnd-kit/sortable` | client | `SortableContext`, `useSortable`, `arrayMove`, `sortableKeyboardCoordinates`, `verticalListSortingStrategy` | 4 files | Part of `client/src/lib/dragDrop.jsx` — sortable overlay on owned drag system | Complex | ~80 |
| `@dnd-kit/utilities` | client | `CSS.Transform.toString()` | 4 files | Inline in lib: `const cssTransform = (t) => t ? \`translate3d(\${t.x}px,\${t.y}px,0) scaleX(\${t.scaleX}) scaleY(\${t.scaleY})\` : ''` | Trivial | ~3 |
| `recharts` | client | `LineChart`, `BarChart`, `ComposedChart`, `Line`, `Bar`, `XAxis`, `YAxis`, `CartesianGrid`, `Tooltip`, `Legend`, `ResponsiveContainer`, `ReferenceLine` | 9 files (all in `meatspace/`) | `client/src/lib/charts.jsx` — SVG-based chart primitives: linear scale, axes, grid, path generator, responsive wrapper via ResizeObserver | Complex | ~210 |

### Dependencies Kept — Transitive (stays in lock file regardless)

| Package | Location | Kept Via | Notes |
|---------|----------|----------|-------|
| `cors` | server | `socket.io → cors@2.8.6` | Remove direct usage by inlining `Access-Control-*` headers in `index.js` and `routes/scaffold.js` — no supply chain gain from removing direct dep, but code ownership improves |
| `fflate` | client | `@react-three/drei → three-stdlib → fflate@0.6.10` and `→ maath → @types/three → fflate@0.8.2` | Replace direct usage in `components/meatspace/tabs/GenomeTab.jsx` with native `DecompressionStream` API — no lock file gain but eliminates direct dependency |

### Dependencies Kept (with rationale)

| Package | Tier | Reason Kept |
|---------|------|-------------|
| `express` | 1 | Foundational web framework |
| `googleapis` | 1 | Large official Google API client — infeasible to replace |
| `node-pty` | 1 | Native PTY addon — no pure-JS equivalent |
| `pg` | 1 | PostgreSQL driver — foundational, widely audited |
| `pm2` (root + server) | 1 | Process manager SDK used throughout server for app lifecycle |
| `portos-ai-toolkit` | 1 | Internal project toolkit |
| `socket.io` + `socket.io-client` | 1 | WebSocket framework — foundational, handles transport negotiation |
| `zod` | 1 | Validation — used on every route via `lib/validation.js`; replacing would require rewriting the entire validation layer |
| `vitest` + `@vitest/coverage-v8` | 1 | Test runner — build tooling |
| `sax` | 2 | Streaming XML parser — handles Apple Health exports (500MB+ files); Node has no native streaming XML parser; replacement would be 300+ lines of binary parsing |
| `ws` | 2 | WebSocket client — used for Chrome DevTools Protocol (CDP) in 3 service files and Moltworld relay; CDP protocol matching is complex; `socket.io` transitively depends on it anyway |
| `lucide-react` | 2 | 186 unique icons, 182 files — replacement would require 1,000–1,500 lines of SVG definitions; exceeds 300-line heavy-mode ceiling |
| `@react-three/drei` | 1 | Text, OrbitControls, Sparkles, Float, Html, MeshDistortMaterial, Grid, Stars — infeasible; each component alone is 200+ lines of Three.js |
| `@react-three/fiber` | 1 | React-Three.js integration — foundational for CyberCity 3D |
| `@xterm/xterm` + addons | 1 | Terminal emulator — no feasible browser-native replacement |
| `react` + `react-dom` | 1 | Foundational |
| `react-router-dom` | 1 | Routing — foundational |
| `three` | 1 | 3D rendering engine — core to CyberCity feature |
| `@dnd-kit/*` | 2 | Drag-drop: 4 files, ~250-line estimated replacement — borderline for heavy mode ceiling; accessibility (keyboard nav + ARIA) adds significant complexity. **Defer** unless removing 3D features reduces drei scope. |
| `recharts` | 2 | Charts: 9 files, ~210 lines of new chart primitives + updates to all 9 files — total replacement effort exceeds 300 lines when including per-file rewrites. **Defer** as its own focused project. |
| `eslint` + plugins + `tailwindcss` + `vite` | 1 | Build/lint tooling — org standard |
| `@eslint/js`, `@tailwindcss/postcss`, `@vitejs/plugin-react` | 1 | Build tooling |

### Replacement Tasks

- [ ] **PREREQ: Sync lock files** — Run `npm install` in root, `server/`, and `client/` after pinning exact versions to eliminate `invalid` warnings in `npm ls`
- [ ] **`uuid`** — Add `server/lib/uuid.js` (`export const uuidv4 = () => crypto.randomUUID()`), update 40 import paths. Trivial. ~5 lines.
- [x] **`cors`** — Replaced `cors()` in scaffold.js generated templates with inline CORS middleware; removed `cors` from generated package.json deps. PortOS itself already used inline headers. Note: package remains in lock file via socket.io.
- [x] **`axios`** — Wrote `server/lib/httpClient.js` (fetch-based client factory, `AbortSignal.timeout`, self-signed TLS via `https.Agent`). Updated `services/jira.js`, `services/datadog.js`, `services/datadog.test.js`. Token-expiry interceptor inlined in jira.js.
- [x] **`multer`** — Wrote `server/lib/multipart.js` (streaming multipart parser, no memory buffering, size limit, MIME filter, req.file compatible). Updated `routes/appleHealth.js`.
- [ ] **`node-telegram-bot-api`** — Write `server/lib/telegramClient.js` (fetch-based Telegram Bot API wrapper: polling loop with offset, `getMe`, `sendMessage`, `editMessageText`, `answerCallbackQuery`, `stopPolling`, regex handler dispatch). Update `services/telegram.js`. ~110 lines.
- [x] **`unzipper`** — Wrote `server/lib/zipStream.js` (streaming ZIP parser: local file header reader, `zlib.createInflateRaw` decompressor, entry emitter with `{ path, pipe, autodrain }`). Updated `routes/appleHealth.js`. **Note:** validate with real Apple Health ZIP before production use.
- [ ] **`supertest`** — Write `server/tests/testHelper.js` (HTTP server lifecycle, fetch-based `request(app)` factory returning `.get/.post/.put/.delete` with `.send/.set`). Update 9 test files. ~45 lines.
- [ ] **`geist`** — Copy font files to `client/public/fonts/`. Update CSS `url()` paths in `client/src/index.css`. Remove package. ~0 logic lines.
- [ ] **`fflate`** (direct usage) — Replace `unzipSync` + `strFromU8` in `GenomeTab.jsx` with native `DecompressionStream` API (browser). Note: package stays in lock file via @react-three/drei.
- [ ] **`globals`** — Inline `globals.browser` + `globals.node` as explicit object in `client/eslint.config.js`. Remove package. ~30 lines.
- [ ] **`react-markdown`** — Write inline markdown parser in `MarkdownOutput.jsx`: regex pipeline for `# h1-6`, `**bold**`, `*italic*`, `` `code` ``, fenced code blocks, `- lists`, `| tables`, links, `> blockquotes`. ~55 lines.
- [ ] **`react-diff-viewer-continued`** — Write inline Myers diff in `CrossDomainTab.jsx`: own LCS diff algorithm (~50 lines) + render spans with add/remove/unchanged styling. ~80 lines.
- [ ] **`react-hot-toast`** — Write `client/src/components/ui/Toast.jsx`: `ToastContext`, `useToast` hook returning `{ success, error, info, dismiss }`, `<ToastContainer>` fixed bottom-right with queue management and auto-dismiss. Update `main.jsx` to use `<ToastContainer>`. Update 101 import sites from `react-hot-toast` → `./ui/Toast` (or relative path). ~100 lines new.
- [ ] **`@dnd-kit/*`** — **Deferred** (borderline 300-line ceiling with accessibility). Write `client/src/lib/dragDrop.jsx` only if dnd-kit shows supply chain issues or needs a major version bump.
- [ ] **`recharts`** — **Deferred** (total effort > 300 lines with 9-file rewrites). Write `client/src/lib/charts.jsx` as a focused future project.

---

## Future Ideas

- [x] **Chronotype-Aware Scheduling** — Genome sleep markers for peak-focus task scheduling
- **Identity Context Injection** — Per-task-type digital twin preamble toggle
- **Agent Confidence & Autonomy Levels** — Dynamic tiers based on success rates
- **Content Calendar** — Unified calendar across platforms
- [x] **Proactive Insight Alerts** — Brain connections, success drops, goal stalls, cost spikes
- **Goal Decomposition Engine** — Auto-decompose goals into task sequences
- **Knowledge Graph Visualization** — Extend BrainGraph 3D to full knowledge graph
- [x] **Time Capsule Snapshots** — Periodic versioned digital twin archives
- **Autobiography Prompt Chains** — LLM follow-ups building on prior answers
- **Legacy Export Format** — Identity as portable Markdown/PDF
- **Dashboard Customization** — Drag-and-drop widgets, named layouts
- **Workspace Contexts** — Project context syncing across shell, git, tasks
- **Inline Code Review Annotations** — One-click fix from self-improvement findings
- **Major Dependency Upgrades** — React 19, Zod 4, PM2 6, Vite 8
- [x] **Voice Capture for Brain** — Microphone + Web Speech API transcription
- [x] **RSS/Feed Ingestion** — Passive feed ingestion classified by interests
- [x] **Ambient Dashboard Mode** — Live status board for wall-mounted displays
- **Dynamic Skill Marketplace** — Self-generating skill templates from task patterns
