# Unreleased Changes

## Added
- AI-powered narrative summaries for JIRA weekly status reports (tries each API provider until one succeeds)

## Changed
- JIRA reports now filter to current user's tickets only via `currentUser()` JQL
- Status report UI simplified to personal weekly status format with copy-to-clipboard
- Ticket keys rendered as clickable JIRA links anywhere in report text

## Changed
- Pin all npm dependencies to exact versions across all packages (no more `^` or `~` ranges) to prevent supply chain attacks
- Heavy-mode dependency audit — 15 packages flagged for removal, full replacement plan saved to PLAN.md
- Replace `axios` with owned `server/lib/httpClient.js` (fetch-based, AbortSignal.timeout, self-signed TLS via https.Agent)
- Replace `multer` with owned `server/lib/multipart.js` (streaming multipart parser, no memory buffering, safe for 500MB+ files)
- Replace `unzipper` with owned `server/lib/zipStream.js` (streaming ZIP parser via zlib.createInflateRaw, DEFLATE + stored entries)
- Remove `cors` package from scaffold-generated project templates; generated code now uses inline CORS middleware

## Changed
- Replace `node-telegram-bot-api` with owned `server/lib/telegramClient.js` (fetch-based polling loop, all bot methods)
- Replace `supertest` with owned `server/lib/testHelper.js` (HTTP server lifecycle + fetch-based request wrapper; 9 test files updated)
- Replace `react-hot-toast` with owned `client/src/components/ui/Toast.jsx` (module-level store, Toaster component; 101 import sites updated)
- Replace `react-markdown` with inline regex block/inline parser in `MarkdownOutput.jsx` (h1–h6, bold, italic, code, tables, lists, links)
- Replace `react-diff-viewer-continued` with inline Myers LCS diff in `CrossDomainTab.jsx`; `InlineDiff` wrapped with `React.memo`
- Replace `fflate` direct usage with native `DecompressionStream` + inline EOCD ZIP parser in `GenomeTab.jsx`

## Changed
- God file decomposition: split `server/routes/cos.js` (1,464 lines) into 9 focused sub-modules (`cosStatusRoutes`, `cosTaskRoutes`, `cosAgentRoutes`, `cosReportRoutes`, `cosLearningRoutes`, `cosScheduleRoutes`, `cosJobRoutes`, `cosTemplateRoutes`, `cosInsightRoutes`)
- God file decomposition: split `server/routes/scaffold.js` (1,667 lines) into 4 template generators (`scaffoldVite`, `scaffoldExpress`, `scaffoldIOS`, `scaffoldPortOS`)
- God file decomposition: split `client/src/services/api.js` (2,016 lines) into 27 domain sub-modules with barrel re-export; no consumer imports changed
- Block npm postinstall scripts by default via `.npmrc` `ignore-scripts=true`; `install:all` explicitly rebuilds trusted packages (`esbuild`, `node-pty`)
- Move Digital Twin work to backlog; promote god file decomposition to Next Up in PLAN.md
- God file decomposition: split `server/services/digital-twin.js` (2,970 lines) into 10 focused modules (`digital-twin-constants`, `digital-twin-helpers`, `digital-twin-meta`, `digital-twin-documents`, `digital-twin-testing`, `digital-twin-enrichment`, `digital-twin-export`, `digital-twin-context`, `digital-twin-analysis`, `digital-twin-import`, `digital-twin-status`); `digital-twin.js` is now a thin barrel re-export

## Fixed
- Bug: `providerOverride` was incorrectly passed as model argument in `processEnrichmentAnswer`; corrected to `modelOverride`
- Dynamic `import()` of `safeJSONParse` inside `analyzeEnrichmentList` replaced with static top-level import
- `loadMeta()` was called inside per-document loop in `analyzeAssessment`; hoisted out to load once

## Changed
- `getDocuments()` now parallelizes all `stat()` calls with `Promise.all`
- `getAllTwinContent()` now parallelizes all `readFile()` calls with `Promise.all`
- Added `extractJSON()` and `ensureDocumentInMeta()` helpers to `digital-twin-helpers.js`; three duplicate document-push blocks in enrichment module replaced with helper calls

## Fixed
- JIRA report provider discovery now tries all available API providers instead of failing on first unreachable one
