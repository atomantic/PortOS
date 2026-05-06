# Unreleased

## Added

### Image Cleaner (Dev Tools)

New `/devtools/image-clean` page strips C2PA provenance metadata and median-filters pixel-level noise from `gpt-image-1` / Codex output. Drag-and-drop or browse-to-upload PNG/JPEG/WebP images (up to 50MB), pick a cleaning level (`light` = median(1), `aggressive` = median(3) + sharpen), and download the re-encoded result. Side-by-side before/after preview with size delta, dimensions, format, and a "C2PA stripped" badge when the source PNG carried a `caBX` chunk. Backed by a new `POST /api/image-clean` route powered by `sharp`, with magic-byte format sniffing so client-supplied MIME types aren't trusted. Reachable via `⌘K` and voice (`ui_navigate`) through new `nav.devtools.image-clean` manifest entry.

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
