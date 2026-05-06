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
