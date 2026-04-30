# Next Release

## Added

- **Morse code trainer** in POST (`/post/morse`) — Koch-method Copy mode (listen → type, 90% accuracy unlocks the next letter) and a Send mode that decodes spacebar/touch keying into text. Native Web Audio (no new deps), Farnsworth timing, configurable WPM/tone, full reference card. Reachable from the POST launcher header, the sidebar, ⌘K, and voice (`ui_navigate "morse"`).

## Changed

- **Worktree policy** clarified in `CLAUDE.md`: TUI sessions edit the main repo directly; worktrees are reserved for unattended CoS sub-agents.
