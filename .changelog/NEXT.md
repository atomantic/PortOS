## Added

- Shell page now has a **Fullscreen** button that promotes the terminal to a full-viewport overlay (above the sidebar), hiding the stacked header/tabs/quick-commands toolbars so the TUI gets the whole screen — a major mobile usability win where those toolbars previously ate most of the display. Fullscreen keeps a compact, horizontally-scrollable control bar (Exit, Ctrl+C, Paste, arrow/Enter keys) so you can still drive a TUI by thumb, and the Ctrl+C/Paste labels now collapse on small screens to save width.
- OpenCode Ollama **TUI** provider for CoS tasks. The TUI completion workflow is now provider-aware: a slashdo-free TUI (OpenCode, which doesn't load Claude Code `/do:*` slash commands) gets a plain `git` + forge-CLI commit → push → open-PR-for-review → `.agent-done` sentinel handoff instead of `/do:pr` / `/do:push`, so an OpenCode TUI agent can actually complete an automated task. The manual path opens the PR/MR (GitHub `gh` or GitLab `glab`) for review without auto-merging. Ships `opencode-ollama-tui` to existing installs via migration 152. (#1814)

## Fixed

- Catalog "Appears in" panel no longer renders dangling chips that deep-link to soft-deleted universe/series/creative-director targets — the detail page filters refs to live targets only (the orphan stays recoverable via the "Orphaned" album). Also fixed a stale resolver bug where soft-deleted Creative Director projects (#1564) wrongly resolved as live, and extended orphan-bucket detection so a deleted CD project's ex-cast surfaces as orphaned rather than unlinked. (#1812)
