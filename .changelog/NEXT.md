## Security

- **Vision-test endpoint no longer reads arbitrary files** — `POST /api/providers/:id/test-vision` took `imagePath` straight from the request body, so a `../` traversal or absolute path could have any readable file base64-encoded and forwarded to the configured external vision provider. The image loader now allowlists `imagePath` to a real image basename under `data/screenshots` (via the canonical `resolveScreenshot` path resolver), rejecting traversal and absolute-path escapes before any file is read or forwarded. (#1820)

## Added

- **Creative Director auto-compose** — the Overview tab's Auto-cast control now has a `+ treatment` toggle (shown only before a treatment exists): with it on, once the director seeds the cast from the catalog it autonomously writes a first-pass treatment + scene plan grounded in that cast, instead of stopping at cast seeding. Director-first — the autonomous treatment is a starting point you keep editing on the same board, and it never clobbers an existing treatment. (#1817)
- Shell page now has a **Fullscreen** button that promotes the terminal to a full-viewport overlay (above the sidebar), hiding the stacked header/tabs/quick-commands toolbars so the TUI gets the whole screen — a major mobile usability win where those toolbars previously ate most of the display. Fullscreen keeps a compact, horizontally-scrollable control bar (Exit, Ctrl+C, Paste, arrow/Enter keys) so you can still drive a TUI by thumb, and the Ctrl+C/Paste labels now collapse on small screens to save width.
- OpenCode Ollama **TUI** provider for CoS tasks. The TUI completion workflow is now provider-aware: a slashdo-free TUI (OpenCode, which doesn't load Claude Code `/do:*` slash commands) gets a plain `git` + forge-CLI commit → push → open-PR-for-review → `.agent-done` sentinel handoff instead of `/do:pr` / `/do:push`, so an OpenCode TUI agent can actually complete an automated task. The manual path opens the PR/MR (GitHub `gh` or GitLab `glab`) for review without auto-merging. Ships `opencode-ollama-tui` to existing installs via migration 152. (#1814)

## Windows updater

- **[issue-1811] Windows update no longer aborts on a successful `git pull`** — the PowerShell updater (`update.ps1`) was treating normal git/npm progress messages (which those tools print to stderr, e.g. "From https://github.com/…") as fatal errors and stopping the update partway through. The updater now distinguishes real failures (by exit code) from routine status output, so updates run to completion on Windows. (#1811)

## Fixed

- Catalog "Appears in" panel no longer renders dangling chips that deep-link to soft-deleted universe/series/creative-director targets — the detail page filters refs to live targets only (the orphan stays recoverable via the "Orphaned" album). Also fixed a stale resolver bug where soft-deleted Creative Director projects (#1564) wrongly resolved as live, and extended orphan-bucket detection so a deleted CD project's ex-cast surfaces as orphaned rather than unlinked. (#1812)
