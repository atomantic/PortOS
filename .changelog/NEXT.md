# Unreleased Changes

## Added

- Submodules management page under Dev Tools — view status, check for updates, and update individual or all git submodules from the dashboard
- Update scripts (`update.sh`, `update.ps1`) now auto-update submodules (including slash-do) during PortOS updates
- Slash-do agent operations panel on app detail Overview tab — buttons for `/do:push`, `/do:review`, `/do:release`, `/do:better`, and `/do:better-swift` that queue CoS agent tasks with the full command instructions
- Multi-line task context now renders as a dedicated `### Task Context` section in agent prompts instead of inline
- Enter key submits the task add form (Shift+Enter for newline)

## Changed

- PM2 file watch restart delay set to 5 minutes to prevent rapid restarts during development
- Triggering agent operations (do:push, do:review, etc.) from the app overview page now navigates to the CoS agents page so the user can watch the agent run

## Fixed

- Branch actions on mobile — delete/merge confirmations now wrap to a separate row instead of overlapping, added 40px touch targets to all buttons, header controls wrap gracefully, commit dates hidden on small screens
- Agent error handling in AgentsTab — API failures no longer trigger success toasts or state refreshes
- Resume agent modal now prevents double-submission with loading state and disabled button
- Slash-do quick actions (`/do:push`, `/do:review`, etc.) no longer run in a worktree — they now execute on the app's active branch where they have the correct context
- Feature-ideas prompt included "you are working in a git worktree on a feature branch" even when worktree was not configured — worktree context is now only injected by `agentPromptBuilder` when actually using a worktree
- `app-improve-` task IDs were getting `task-` prefix added by `taskParser.js`, causing `updateTask` lookups to fail — tasks were never marked in_progress or completed after agent runs
- Recovered `app-improve-` agents after server restart now correctly infer `taskType: 'internal'` instead of `'user'`
- Extracted `hasKnownPrefix()` and `isInternalTaskId()` helpers to eliminate prefix check drift across 8 locations
- Screenshot and attachment uploads now clear after task form submission regardless of success or failure

## Removed
