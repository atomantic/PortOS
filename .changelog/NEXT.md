- **Day-mode chip legibility**: Pastel chip text (Worktree, Simplify, BookLoom, model badge, BTW, "main", PR, Review, etc.) used 300/400/500 Tailwind tones designed for dark mode and were unreadable on cream/white day-mode themes (Phosphor Paper, Drafting Paper, Lumen Glass Day, Classic Noon). Added `[data-port-theme-mode="day"]` overrides that remap each hue to its 700-tone (yellow → 800) so chips keep their semantic color but read clearly on light backgrounds.
# Unreleased

## Added

### Writers Room — Read view + cross-linked storyboard

A new `?view=read` mode for the Writers Room editor renders prose with scene anchors, inline character/setting/object highlighting, and hover tooltips that show extracted profile details. Hovering a token in the prose rings the matching chip on its scene card and the matching row in the bible; clicking jumps the sidebar to the right tab. Hovering a scene card flashes the matching scene marker in the prose.

Scene cards now use a stronger visual treatment when active (accent ring + tint + faint glow), and "jump to scene" smoothly tweens the textarea (220ms easeInOutCubic) instead of snapping.

A new third extraction kind, **Objects**, extracts recurring symbolic items (the letter, the fedora) alongside Characters and Settings. Editable in a new Objects tab in the storyboard sidebar, with the same AI-fills-blanks merge rule as the other bibles.

### Live render dock

A page-level run dock now slides up from the bottom of the Writers Room while image-gen jobs are queued or rendering. Each row shows the scene label, status, progress bar, ETA, and a per-job stop button; "Stop all" cancels every queued and in-flight render. The dock auto-hides one second after the last job completes.

## Changed

- The "Rendering N scenes…" inline banner inside the Boards tab has been removed; the new run dock subsumes it and is visible from any tab.
- `STORYBOARD_TAB` enum now includes `OBJECTS` between `WORLD` and `SCENES`.
- `ANALYSIS_KINDS` server enum now includes `'objects'`.
- App selectors throughout the UI (task add form, OpenClaw) now list apps alphabetically by name via the shared `AppContextPicker`, instead of preserving the underlying storage order.

## Fixed

- Stale-chunk auto-reload now covers Safari ("Importing a module script failed") and Firefox ("error loading dynamically imported module") in addition to Chrome — previously iOS Safari users hit a "Something went wrong" error after a rebuild and had to tap Refresh manually. Detection is shared between `lazyWithReload` (the primary path) and `ErrorBoundary` (safety net), with a one-reload-per-session guard against infinite loops.
- `ErrorBoundary` now uses theme-aware `text-port-text` / `text-port-text-muted` / `text-port-on-accent` instead of hardcoded `text-white` / `text-gray-400`, so the fallback UI is readable on light themes (Lumen Glass, etc).
