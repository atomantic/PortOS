## Added

- **M50 P7: Gmail API Sync** — Gmail integration via Google API (same OAuth as Calendar). Syncs inbox messages with full body extraction, thread grouping, label mapping, and starred/read status. Sends email via Gmail API with RFC 2822 formatting and reply threading. Archive/delete via API (no browser needed). HTML email rendering in sandboxed iframe. Compact message detail header. Gmail setup checklist in Config with OAuth and API enable controls.
- **M56: Telegram Bot Integration** — Telegram bot for external notifications and conversational commands. Configure bot token and chat ID in Settings. Forwards PortOS notifications (filterable by type) to Telegram with rate limiting. Bot commands: `/status`, `/goals`, `/agents`, `/checkin`, `/help`. Check-in responses are persisted for goal tracking.
- **M49 P1: Goal Todos & Progress Tracking** — Enhanced goal model with explicit progress percentage, todo sub-tasks (with priority and time estimates), velocity tracking (percent/month with trend), projected completion dates, and time tracking aggregates. Progress bar and todos visible in both goal list rows and detail panel.
- **M49 P2-P4: Goal Planning, Calendar & Check-ins** — Set target dates on goals, generate AI-powered phase plans (3-7 milestones with dates), edit/reorder/accept proposed phases. Schedule time blocks on Google Calendar based on preferred days, time slots, and session duration. Automated weekly goal check-ins via autonomous job: computes expected vs actual progress, determines on-track/behind/at-risk status, generates AI assessment and recommendations, sends Telegram notification. Google Calendar OAuth upgraded to read-write scope with upgrade detection.

- **POST Deep Routes & Elements Expansion** — POST section now uses deep-linkable routes (`/post/launcher`, `/post/memory`, `/post/history`, `/post/config`, `/post/memory/elements`) instead of internal state switching. Sidebar nav expanded to collapsible section with sub-pages. Added 16 missing elements (103-118, Lawrencium through Oganesson) to the periodic table and element map. New appendix verse set for memorizing the post-Lehrer elements. Fixed missing Mercury (Hg) in periodic table grid. Period 7 now shows all elements. Interactive periodic table with hover tooltips, click-to-highlight verse, search filter, mastery/category view toggle, and element category color coding.

## Changed

- **CoS feature-ideas task** — Agents now implement the next unchecked PLAN.md item instead of inventing features. When user clarification is needed, agents create a `.plan-questions.md` marker and a `plan_question` notification linking to the Documents tab. Added `{appId}` template variable for prompt linking.
- **CoS task prompt enhancement** — Enhance prompt now instructs the LLM to research the codebase (find relevant files, patterns, conventions), plan the approach, and produce a codebase-grounded prompt with specific file paths and implementation steps instead of generic advice

## Fixed

- **Self-build crash** — Fixed PortOS build button killing the server mid-build. `npm install` in `server/` triggered PM2's file watcher restart (SIGINT) which killed the build child process. Self-builds now skip server install (already running) and use `shell: true` for proper PATH resolution. Build error messages now include exit code, signal, and stdout/stderr output.

- **Apps page crash** — Fixed `Cannot access 'isNonPm2' before initialization` error caused by self-referencing variable declaration in Apps.jsx
- **Memory display truncation** — Show full memory text in CoS Memory tab and Telegram notifications instead of truncating to 100-200 characters
- **CoS task form clarity** — Renamed "Branch + PR" to "Worktree + PR" across task form, schedule tab, and app settings with descriptive tooltips explaining that unchecked means commits go directly to the default branch
