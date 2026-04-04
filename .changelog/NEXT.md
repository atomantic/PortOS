# Unreleased Changes

## Added

- Slash-do agent operations panel on app detail Overview tab — buttons for `/do:push`, `/do:review`, `/do:release`, `/do:better`, and `/do:better-swift` that queue CoS agent tasks with the full command instructions
- Multi-line task context now renders as a dedicated `### Task Context` section in agent prompts instead of inline

## Changed

## Fixed

- Slash-do quick actions (`/do:push`, `/do:review`, etc.) no longer run in a worktree — they now execute on the app's active branch where they have the correct context
- Feature-ideas prompt included "you are working in a git worktree on a feature branch" even when worktree was not configured — worktree context is now only injected by `agentPromptBuilder` when actually using a worktree
- `app-improve-` task IDs were getting `task-` prefix added by `taskParser.js`, causing `updateTask` lookups to fail — tasks were never marked in_progress or completed after agent runs
- Recovered `app-improve-` agents after server restart now correctly infer `taskType: 'internal'` instead of `'user'`
- Extracted `hasKnownPrefix()` and `isInternalTaskId()` helpers to eliminate prefix check drift across 8 locations

## Removed
