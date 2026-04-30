# Next Release

## Added

- **Morse code trainer** in POST (`/post/morse`) — Koch-method Copy mode (listen → type, 90% accuracy unlocks the next letter) and a Send mode that decodes spacebar/touch keying into text. Native Web Audio (no new deps), Farnsworth timing, configurable WPM/tone. Reachable from the POST launcher header, the sidebar, ⌘K, and voice (`ui_navigate "morse"`).
- **Morse trainer side widget** with a binary tree visualization that highlights the live keying path (DAH-left, DIT-right), three reference views (Tree / Length / List), a tap-anywhere practice key, and a real-time decoded log. Spacebar keying is intercepted in capture phase so it doesn't trigger the voice FAB push-to-talk hotkey while on the morse page.

## Changed

- **Worktree policy** clarified in `CLAUDE.md`: TUI sessions edit the main repo directly; worktrees are reserved for unattended CoS sub-agents.

## Fixed

- **CoS agents now reliably open PRs and request Copilot reviews when configured.** Previously, when both `openPR` and `reviewLoop` were enabled on a task, the worktree-cleanup logic's gate (`taskOpenPR && !taskReviewLoop`) skipped PR creation — falling through to auto-merge the agent's branch into main with no PR, no review, and contradictory wording in the agent prompt about whether it should open the PR itself. The cleanup now always opens the PR when `openPR` is set; when `reviewLoop` is also set, it requests a Copilot review on the new PR via the new `git.requestCopilotReview()` helper. The agent prompt is updated to consistently tell the agent the system handles PR creation and review requests.
