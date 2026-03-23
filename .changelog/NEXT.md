# Unreleased Changes

## Added
- Claude Code changelog tracking: fetches GitHub Atom feed for new releases, caches with 1-hour TTL, surfaces new versions in daily briefing
- POST wordplay drill cache: pre-generates challenges on startup so drills load instantly from cache with background replenishment
- POST local scoring for deterministic drill types (bridge-word, compound-chain, verbal-fluency, story-recall) — instant results without LLM calls
- POST loading indicator with elapsed timer, progress bar, and cycling status messages replaces static spinner
- POST drill tutorial hints: compound chain shows example compounds, bridge word explains the goal, double-meaning and idiom-twist show example answers
- Ambient Dashboard Mode: fullscreen live status board at `/ambient` for wall-mounted displays — shows real-time clock, death clock countdown, today's calendar events, goal progress, and agent activity with auto-refresh, auto-hiding controls, and fullscreen toggle
- Agent options (Worktree+PR, /simplify, Review Loop) configurable per-app on both the Automation tab and CoS Schedule per-app overrides
- Review Loop agent option: runs PR review feedback loop after opening a PR until checks pass
- Nicotine tracking tab in MeatSpace with consumption logging, daily totals, rolling averages, custom product quick-add buttons, inline editing, and entry history
- Nicotine chart (7d/30d/90d bar chart) and nicotine vs heart rate correlation visualization
- Nicotine data integrated into health correlation endpoint (HR, resting HR alongside nicotine mg)
- Server-side nicotine service with daily log persistence, custom product management, and caching
- Date editing on alcohol and nicotine history entries (move items between dates)
- Nicotine sub-nav link in MeatSpace sidebar
- Telegram MCP Bridge mode: uses Claude Code's Telegram plugin for outbound notifications via direct Bot API HTTP calls, with inbound messages handled by Claude Code's natural language processing instead of rigid bot commands
- Settings toggle to switch between Manual Bot and Claude MCP Bridge integration methods
- Interactive storage backend chooser during setup: Docker PostgreSQL, Native PostgreSQL, or file-based JSON (deprecated) when Docker is unavailable

- Personal Goals dashboard widget: shows top-level goals with progress bars, category icons, horizon labels, and stall detection (14+ days idle) — replaces broken CoS task-based goal widget that never rendered

## Changed
- Release-check scheduled task now discovers the project's release process from CLAUDE.md, README.md, CONTRIBUTING.md, docs/, CI workflows, and changelog docs instead of hardcoding dev→main
- Exported `cleanupAgentWorktree` from `subAgentSpawner.js` with dedicated test file covering the openPR completion path (push, PR creation, failure preservation, auto-merge fallback)
- Exported `isTruthyMeta` from `subAgentSpawner.js` and `applyAppWorktreeDefault` from `cos.js`; tests now import production helpers instead of duplicating their logic inline
- Consolidated 5 duplicate `timeAgo`/`formatTimeAgo` implementations into a single `timeAgo()` in `utils/formatters.js`
- Deduplicated `stripCodeFences` from insightsService — now imports from shared `lib/aiProvider.js`
- Added `MINUTE` time constant to `lib/fileUtils.js` alongside existing `HOUR`/`DAY`
- Quick-add buttons for alcohol and nicotine now combine duplicate entries on the same date by incrementing count instead of stacking separate rows
- Extracted shared `dayOfWeek` utility and `DAY_LABELS` constant to meatspace constants (deduplicated from AlcoholTab)
- Health correlation endpoint now includes heart rate, resting heart rate, and nicotine data alongside existing HRV/alcohol/steps
- NicotineHealthCorrelation tooltip uses Tailwind classes instead of inline styles for consistency
- Extracted `recalcAlcoholTotal()` helper and reuse across logDrink, updateDrink, removeDrink
- AlcoholTab correlation date range wrapped in useMemo to prevent unnecessary API refetches
- Nicotine mg/unit form field uses placeholder instead of default value
- Nicotine page redesigned: compact stat bar, merged quick-add/custom entry card, collapsible custom form, table-based history, side-by-side charts
- Alcohol page summary compressed into a single compact stat bar row to maximize above-the-fold content

## Fixed
- Notifications crash on missing metadata: added optional chaining in `removeByMetadata()` and `exists()`
- Telegram memory approve/reject: wrapped in try/catch to prevent unhandled errors, clears inline keyboard buttons after action
- ETA duration estimates skewed by failed agents: track success-only durations separately, add `recalculate-durations` endpoint for retroactive rebuild from agent archive
- CoS orphan retry over-spawning: `resetOrphanedTasks()` was bypassing retry limits by blindly resetting in_progress tasks to pending — now routes through `handleOrphanedTask()` for consistent spawn counting, cooldown, and max-retry enforcement
- CoS scheduled improvement tasks (feature-ideas, etc.) never spawning: event listener mismatch (`tasks:user:added`/`tasks:cos:added` vs actual `tasks:changed` event), missing dequeue trigger after improvement check timer, and no improvement queuing after daemon restart until timer fires
- App icons in CoS schedule per-app override list rendering at natural image size instead of respecting the `size` prop
- Calendar day view current-time red line now updates every 60 seconds instead of only on page load
- Stokes Pick default nicotine amount corrected from 3mg to 5mg
- UTC timezone shift showing tomorrow's date in alcohol/nicotine forms — replaced `toISOString()` with local `localDateStr()` utility
- Server-side rolling averages and summary use local dates instead of UTC — fixes today showing 0mg despite logged entries
- Chart date range comparison uses local date strings instead of UTC Date objects — fixes today/yesterday missing from 7-day chart
- Empty entry objects no longer accumulate in daily-log.json after moving the last item from a date
- README screenshot labels corrected to match actual screenshot content (all 6 were mislabeled)
- Zod `.default(false)` on `archived`, `defaultUseWorktree`, and `defaultOpenPR` in `appSchema` caused `appUpdateSchema.partial()` to inject `false` for omitted fields, silently overwriting stored `true` values during partial updates

## Removed
- Dead code: `euclideanDistance`, `averageVectors`, `similarityMatrix` from `vectorMath.js` (unused outside tests)
- Dead code: `rootPath` from `fileUtils.js`, `getClient` from `db.js` (never imported)
