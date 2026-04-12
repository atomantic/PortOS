## Added

- **Test coverage** for 7 previously untested modules: `commandSecurity`, `httpClient`, `platform`, `memoryBM25`, `notifications`, `search`, and `taskSchedule` — 171 new tests covering command validation, output redaction, HTTP client factory, BM25 memory indexing, notification CRUD, fan-out search, and task scheduling logic
- **Xcode Multi-Platform template** — new "Xcode Multi-Platform" app template scaffolds a SwiftUI project with iOS, macOS, and watchOS targets via XcodeGen
  - Generic `deploy.sh` with `--ios`, `--macos`, `--watch`, `--all` flags for TestFlight deployment
  - Generic `take_screenshots.sh` and `take_screenshots_macos.sh` for App Store screenshot automation
  - UI test target with `ScreenshotTests.swift` stubs for XCUITest-based screenshot capture
  - Shared module for cross-platform code, macOS entitlements, watchOS companion app
- **Xcode script health check** — PortOS now detects missing management scripts (deploy, screenshots) in Xcode-managed apps and surfaces a banner in the app detail overview with one-click install
- Deploy panel now includes `--watch` (watchOS) flag option
- **Obsidian Notes Manager** in Brain section — browse, search, edit, and create notes in Obsidian vaults synced via iCloud
  - Auto-detects Obsidian vaults from iCloud directory
  - Vault browser with folder tree, search, tags panel, and markdown preview with wikilink navigation
  - Inline note editor with Cmd+S save, backlinks panel, and frontmatter properties view
  - Full-text search with context snippets and relevance ranking
  - Link graph endpoint for vault-wide wikilink visualization
- **LLM Wiki** — a dedicated Wiki page for managing an LLM-maintained knowledge base in Obsidian
  - Overview tab with page-type stats (sources, entities, concepts, comparisons, synthesis, queries), recent activity feed, and health report display
  - Browse tab with folder-tree navigation for both wiki pages and raw sources, inline note viewer/editor with metadata sidebar (frontmatter, tags, wikilinks, backlinks)
  - Full-text search tab with relevance ranking, context snippets, and one-click navigation to results
  - Interactive knowledge graph tab with color-coded node clusters by page type, zoom/pan, and click-to-navigate
  - Activity log tab parsing the wiki's chronological log into a structured timeline
  - Wiki schema (`WIKI.md`) defining page types, frontmatter conventions, and ingest/query/lint workflows
  - Weekly CoS maintenance job (`job-wiki-maintenance`) that audits the wiki for contradictions, orphans, missing cross-references, outdated claims, and generates a lint report
  - Obsidian attachment folder auto-configured to `raw/assets/` for Web Clipper image downloads
- **Disk usage monitoring** on dashboard — system health endpoint now reports root filesystem disk usage (total/used/free/percent) with warning at 85% and critical alert at 95%; SystemHealthWidget displays a new Disk card with progress bar alongside Memory, CPU, Processes, and Apps
- **CyberCity v2 improvement plan** — 19 concrete ideas across 3 effort tiers for transforming CyberCity from decorative scene to living systems dashboard, including system health atmosphere, productivity district, goal monuments, chronotype energy overlay, and knowledge district

## Fixed

- **Simplify agent summary visibility** — completed agents that ran with `/simplify` now extract and display a separate "Task Summary" showing what the agent accomplished, so the original work summary is no longer buried under the simplify review output

- **Memory dedup — duplicate approval requests** — memory extractor now checks existing active and pending memories (via vector similarity + text prefix matching) before proposing new ones, and the LLM classification prompt now includes existing memories so it avoids re-proposing semantically equivalent knowledge

- **Xcode `deploy.sh` template — altool upload check false-positive** — generated deploy scripts grepped altool output for plain `ERROR: ` to detect upload failures, but altool's multipart uploader logs every transient retry as `ERROR: [ContentDelivery.Uploader.X] WILL RETRY PART N. Checksums do not match.` On flaky/slow networks the script killed deploys mid-recovery. Switched to Apple's definitive failure markers only: `UPLOAD FAILED|Validation failed \(|ERROR ITMS-|product-errors`. Affects iOS, macOS, and watchOS upload sections in `xcodeScripts.js`.
- Submodule status API (`/api/git/submodules/status`) always returned empty array — `stdout.trim()` was stripping the leading space status character from `git submodule status` output, causing the regex parser to fail
- CoS agents page crash: pipe characters (`|`) in task descriptions triggered infinite loop in markdown parser — non-table pipes now treated as normal text with safety fallback
- CoS agents API returned full output arrays (600KB+) for all agents in listing — output now stripped from listing response and loaded on demand
- **Resume Agent modal not dismissing** — clicking "Queue Resume Task" successfully queued the task but left the modal open; modal now closes on successful submit
- **Pending task edit form unresponsive** — save/cancel buttons on the edit form for pending tasks did not respond to taps; dnd-kit's sortable wrapper interfered with pointer events inside sortable items. Sorting is now disabled while editing, pointer events are stopped from propagating through the edit form, and button touch targets are enlarged to 40px minimum height
- **Broken worktree detection** — worktree cleanup now verifies `rev-parse --show-toplevel` matches the expected worktree path before trusting `git status`; prevents broken worktrees (missing `.git` file) from resolving to a parent repo and incorrectly blocking removal
- **Agent prompt missing commit step** — agent instructions now explicitly include "commit and push" in the numbered steps and the simplify section reinforces committing after review, preventing agents from completing work without pushing changes
- **Memory classifier — LM Studio no-model-loaded failures** — memory classification calls to LM Studio failed with `400 "No models loaded"` when the server had no model in memory. The classifier now discovers downloaded LLMs via `GET /api/v0/models`, auto-loads the configured model (or first available LLM) via `POST /api/v1/models/load`, and retries with the actually-loaded model id — mirroring the existing embedding auto-load path in `memoryEmbeddings.js`
- **Browser CDP downloads reverting to `~/Downloads`** — `Browser.setDownloadBehavior` is DevTools-session-scoped in Chrome: the instant the WebSocket that issued the command closes, Chrome tears down the session's `BrowserHandler` and the download directory reverts to the profile default. The previous implementation opened a WS, sent the command, and closed it immediately after the ack — so the managed download dir was only in effect for milliseconds and real downloads landed in `~/Downloads`. `browser/server.js` now keeps a persistent keep-alive WebSocket open for the lifetime of the process, with automatic reconnect if Chrome restarts, proper error detection on the command response, and clean teardown on shutdown
