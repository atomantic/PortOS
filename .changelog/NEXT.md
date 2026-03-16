## Added

- **M50 P7: Gmail API Sync** — Gmail integration via Google API (same OAuth as Calendar). Syncs inbox messages with full body extraction, thread grouping, label mapping, and starred/read status. Sends email via Gmail API with RFC 2822 formatting and reply threading. Archive/delete via API (no browser needed). HTML email rendering in sandboxed iframe. Compact message detail header. Gmail setup checklist in Config with OAuth and API enable controls.
- **M56: Telegram Bot Integration** — Telegram bot for external notifications and conversational commands. Configure bot token and chat ID in Settings. Forwards PortOS notifications (filterable by type) to Telegram with rate limiting. Bot commands: `/status`, `/goals`, `/agents`, `/checkin`, `/help`. Check-in responses are persisted for goal tracking.
- **M49 P1: Goal Todos & Progress Tracking** — Enhanced goal model with explicit progress percentage, todo sub-tasks (with priority and time estimates), velocity tracking (percent/month with trend), projected completion dates, and time tracking aggregates. Progress bar and todos visible in both goal list rows and detail panel.
- **M49 P2-P4: Goal Planning, Calendar & Check-ins** — Set target dates on goals, generate AI-powered phase plans (3-7 milestones with dates), edit/reorder/accept proposed phases. Schedule time blocks on Google Calendar based on preferred days, time slots, and session duration. Automated weekly goal check-ins via autonomous job: computes expected vs actual progress, determines on-track/behind/at-risk status, generates AI assessment and recommendations, sends Telegram notification. Google Calendar OAuth upgraded to read-write scope with upgrade detection.

- **POST Deep Routes & Elements Expansion** — POST section now uses deep-linkable routes (`/post/launcher`, `/post/memory`, `/post/history`, `/post/config`, `/post/memory/elements`) instead of internal state switching. Sidebar nav expanded to collapsible section with sub-pages. Added 16 missing elements (103-118, Lawrencium through Oganesson) to the periodic table and element map. New appendix verse set for memorizing the post-Lehrer elements. Fixed missing Mercury (Hg) in periodic table grid. Period 7 now shows all elements. Interactive periodic table with hover tooltips, click-to-highlight verse, search filter, mastery/category view toggle, and element category color coding.

- **App Icon Detection** — Apps can now display their actual project icon (favicon, Xcode AppIcon, etc.) instead of generic SVG icons. Auto-detects icons from well-known paths during app import and config refresh. Supports Xcode/iOS AppIcon.appiconset, web favicons, logos, and common icon locations. Icon served via `GET /api/apps/:id/icon` with fallback to SVG icons. Bulk "Detect Icons" button on Apps page. Apps sorted alphabetically on both Dashboard and Apps pages. App icons shown in Apps list rows.

- **Review Briefing Fullscreen** — Daily Briefing section in Review Hub now has a fullscreen toggle button and increased default content height for better readability

- **Database Management UI** — Switch between Docker and native PostgreSQL from Settings > Database. Shows live status of both backends with connection health, memory count, database size, and table count. Migrate data between backends with one click. Export database, install/setup native PostgreSQL, and fix stale PID files — all from the UI with real-time progress via WebSocket

- **Settings Sub-Tabs** — Settings page split into routed tabs: Backup (`/settings/backup`), Database (`/settings/database`), Telegram (`/settings/telegram`). Sidebar nav now shows Settings as a collapsible section with sub-pages

- **Instance Sync Toggle & Probe Backoff** — Per-peer sync enable/disable toggle (independent of polling). Failing probes now use exponential backoff (30s → 1m → 5m → 15m → 1h → 24h max) instead of hammering offline peers every 30 seconds. Backoff resets when peer comes back online. UI shows consecutive failure count, next probe time, and sync disabled status

## Changed

- **Native PostgreSQL uses system pg** — Native mode now reuses the existing system PostgreSQL on port 5432 (e.g., Homebrew service) instead of running a separate instance on port 5561. `setup-native` detects an already-running pg, creates the portos user/database, and applies the schema. No dedicated data directory or manual startup needed. Docker mode unchanged on port 5561. Sync between backends is zero-downtime since they run on different ports simultaneously.

- **CoS feature-ideas task** — Agents now implement the next unchecked PLAN.md item instead of inventing features. When user clarification is needed, agents create a `.plan-questions.md` marker and a `plan_question` notification linking to the Documents tab. Added `{appId}` template variable for prompt linking.
- **CoS task prompt enhancement** — Enhance prompt now instructs the LLM to research the codebase (find relevant files, patterns, conventions), plan the approach, and produce a codebase-grounded prompt with specific file paths and implementation steps instead of generic advice

## Fixed

- **Database sync/migrate failures** — Fixed `start_native` in db.sh crashing when native PostgreSQL was already running (pg_ctl "another server might be running" error). Rewrote sync route to use a temporary port (5562) for the target backend so the active database never goes down during sync — eliminates pool errors and connection drops

- **Self-build crash** — Fixed PortOS build button killing the server mid-build. `npm install` in `server/` triggered PM2's file watcher restart (SIGINT) which killed the build child process. Self-builds now skip server install (already running) and use `shell: true` for proper PATH resolution. Build error messages now include exit code, signal, and stdout/stderr output.

- **Apps page crash** — Fixed `Cannot access 'isNonPm2' before initialization` error caused by self-referencing variable declaration in Apps.jsx
- **Memory display truncation** — Show full memory text in CoS Memory tab and Telegram notifications instead of truncating to 100-200 characters
- **CoS task form clarity** — Renamed "Branch + PR" to "Worktree + PR" across task form, schedule tab, and app settings with descriptive tooltips explaining that unchecked means commits go directly to the default branch
