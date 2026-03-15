## Added

- **M50 P7: Gmail API Sync** — Gmail integration via Google API (same OAuth as Calendar). Syncs inbox messages with full body extraction, thread grouping, label mapping, and starred/read status. Sends email via Gmail API with RFC 2822 formatting and reply threading. Archive/delete via API (no browser needed). HTML email rendering in sandboxed iframe. Compact message detail header. Gmail setup checklist in Config with OAuth and API enable controls.
- **M56: Telegram Bot Integration** — Telegram bot for external notifications and conversational commands. Configure bot token and chat ID in Settings. Forwards PortOS notifications (filterable by type) to Telegram with rate limiting. Bot commands: `/status`, `/goals`, `/agents`, `/checkin`, `/help`. Check-in responses are persisted for goal tracking.
- **M49 P1: Goal Todos & Progress Tracking** — Enhanced goal model with explicit progress percentage, todo sub-tasks (with priority and time estimates), velocity tracking (percent/month with trend), projected completion dates, and time tracking aggregates. Progress bar and todos visible in both goal list rows and detail panel.
- **M49 P2-P4: Goal Planning, Calendar & Check-ins** — Set target dates on goals, generate AI-powered phase plans (3-7 milestones with dates), edit/reorder/accept proposed phases. Schedule time blocks on Google Calendar based on preferred days, time slots, and session duration. Automated weekly goal check-ins via autonomous job: computes expected vs actual progress, determines on-track/behind/at-risk status, generates AI assessment and recommendations, sends Telegram notification. Google Calendar OAuth upgraded to read-write scope with upgrade detection.

## Changed

- **CoS feature-ideas task** — Agents now implement the next unchecked PLAN.md item instead of inventing features. When user clarification is needed, agents create a `.plan-questions.md` marker and a `plan_question` notification linking to the Documents tab. Added `{appId}` template variable for prompt linking.

## Fixed

- **Apps page crash** — Fixed `Cannot access 'isNonPm2' before initialization` error caused by self-referencing variable declaration in Apps.jsx
- **Memory display truncation** — Show full memory text in CoS Memory tab and Telegram notifications instead of truncating to 100-200 characters
