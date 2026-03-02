# Unreleased Changes

## Added

- **Editable Documents**: App document pages (PLAN.md, CLAUDE.md, GOALS.md) under the Documents tab can now be edited in-place with a monospace textarea editor
- **Git Commit on Save**: Saving a document automatically stages the file, commits it to the app's git repo, and shows the commit hash in a toast notification
- **Create Missing Documents**: Missing documents show "Create" buttons that open the editor for new file creation
- **No-Change Detection**: Saving without actual changes shows an info toast instead of creating an empty commit
- **App Processes Tab**: Each app's detail view now has a "Processes" tab showing only that app's PM2 processes with live logs, restart/stop/start controls
- **Reusable ProcessesTab**: Extracted process management UI into a shared component used by both the DevTools Processes page and app detail views
- **Live Activity Log**: Update and Standardize PM2 operations now show real-time step progress via socket streaming instead of just a spinner
- **Apps Sidebar Dashboard Link**: Apps sidebar section now includes a Dashboard link at top for quick access to the apps list
- **GSD Phase Cards**: Expandable phase cards replace the minimal dot-timeline, showing sub-plans with task checklists, verification status/scores, research content, and summary metadata
- **GSD Phase Actions**: Plan/Execute/Verify buttons on each phase create CoS agent tasks with one click — also shown as a prominent "Next Action" banner at the top
- **GSD Project Header**: Dashboard header with progress bars (phases completed, phases planned), config badges, milestone status, and quick actions (Refresh, Claude Code, New Milestone)
- **GSD Documents Panel**: View and edit `.planning/` documents (PROJECT, ROADMAP, STATE, CONCERNS, RETROSPECTIVE, MILESTONES) with markdown rendering and git commit on save
- **Deep-linkable GSD Views**: Phase expansion and document selection persist in URL params (`?phase=03-apple-health-integration&doc=ROADMAP.md`)
- **AI thought evaluation**: Brain classifier adds commentary, insights, and connections about each captured thought — surfacing questions worth exploring and suggested next steps
- **Slop cleanup**: Raw brain dumps are automatically cleaned up — grammar fixed, shorthand expanded, restructured for clarity while preserving original meaning and voice
- **CyberCity Drop In Mode**: Street-level 3rd-person exploration with a cyberpunk wireframe avatar — walk around the city with WASD, sprint with Shift, mouse look via pointer lock, approach buildings to see expanded holographic panels, press E to enter. Toggle between orbital and street view via HUD button or Tab hotkey

## Changed

- **npm workspaces**: Root `package.json` declares `client` and `server` as workspaces — single `npm install` installs all deps, single root `package-lock.json` covers everything
- **Removed duplicate deps from root**: `express`, `portos-ai-toolkit`, `@tailwindcss/postcss`, `@vitejs/plugin-react`, and `vite` now only live in the sub-packages where they're actually used
- **Simplified CI**: Both CI jobs use `npm ci` instead of `npm run install:all`, workspace flags (`-w server`, `-w client`) replace `working-directory`
- **Simplified setup**: `setup.sh` and `install:all` script reduced to single `npm install` call
- **Clean start**: `npm start` now deletes existing PM2 processes before starting, ensuring fresh state with latest build assets
- **Alphabetical app tabs**: App detail tabs are now alphabetically ordered (Automation, Documents, Git, GSD, Processes, Tasks)
- **Shell session options**: `shell:start` socket event now accepts optional `cwd` and `initialCommand` parameters, enabling pre-configured terminal sessions via URL params (`/shell?cwd=/path&cmd=claude`)

## Fixed

- **Clear Failed Runs**: Fixed "Only filter=failed is supported" error when clicking Clear Failed on the DevTools Runs page — client was sending wrong query parameter
- **CoS Productivity Tab**: Auto-recalculate productivity data from agent history on first visit instead of showing empty state when `productivity.json` hasn't been generated yet
- **Update with stopped PM2 processes**: Clicking Update on an app whose PM2 processes aren't running no longer crashes — restart failures are captured per-process and reported as warnings while the update still succeeds
- **Phase file parsing**: Backend was looking for hardcoded `PLAN.md` and `VERIFICATION.md` but actual files use prefixed naming — phases now correctly scan for `*-PLAN.md`, `*-VERIFICATION.md`, `*-RESEARCH.md`, and `*-SUMMARY.md` files
- **Multi-plan phases**: Phases with multiple sub-plans are now properly parsed as arrays instead of returning null
- **Claude Code button**: "Open Claude Code" on GSD page now opens a web terminal at `/shell` with Claude Code running in the app directory
- **Brain classifier model selection**: CLI providers now receive `--model` flag so the configured model is actually used — previously defaulting to a slower model, causing classification to time out
- **Retry classification runs async**: "Retry AI" now works like initial capture — sets status to `classifying`, returns immediately, runs AI in background
- **Stuck classification recovery**: On server startup, any inbox entries left in `classifying` status are automatically reset to `needs_review`
- **Route body destructuring**: Brain routes no longer crash when `req.body` is undefined
- **AI call logging**: Brain service logs when AI calls start and how long they take for easier debugging
- **HMR route errors**: Decline hot-module replacement on the route tree so Vite does a full reload instead of leaving React Router in a broken state on nested paths
- **CyberCity lightning sound**: Fixed `createWaveShaperNode is not a function` crash — correct Web Audio API method is `createWaveShaper()`

## Removed
