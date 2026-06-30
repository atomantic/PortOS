## Added

- Shell page now has a **Fullscreen** button that promotes the terminal to a full-viewport overlay (above the sidebar), hiding the stacked header/tabs/quick-commands toolbars so the TUI gets the whole screen — a major mobile usability win where those toolbars previously ate most of the display. Fullscreen keeps a compact, horizontally-scrollable control bar (Exit, Ctrl+C, Paste, arrow/Enter keys) so you can still drive a TUI by thumb, and the Ctrl+C/Paste labels now collapse on small screens to save width.

## Fixed

- Catalog "Appears in" panel no longer renders dangling chips that deep-link to soft-deleted universe/series/creative-director targets — the detail page filters refs to live targets only (the orphan stays recoverable via the "Orphaned" album). Also fixed a stale resolver bug where soft-deleted Creative Director projects (#1564) wrongly resolved as live, and extended orphan-bucket detection so a deleted CD project's ex-cast surfaces as orphaned rather than unlinked. (#1812)
