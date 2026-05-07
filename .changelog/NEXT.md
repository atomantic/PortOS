- **Day-mode chip legibility**: Pastel chip text (Worktree, Simplify, BookLoom, model badge, BTW, "main", PR, Review, etc.) used 300/400/500 Tailwind tones designed for dark mode and were unreadable on cream/white day-mode themes (Phosphor Paper, Drafting Paper, Lumen Glass Day, Classic Noon). Added `[data-port-theme-mode="day"]` overrides that remap each hue to its 700-tone (yellow → 800) so chips keep their semantic color but read clearly on light backgrounds.
# Unreleased

## Added

### Writers Room — Read view + cross-linked storyboard

A new `?view=read` mode for the Writers Room editor renders prose with scene anchors, inline character/setting/object highlighting, and hover tooltips that show extracted profile details. Hovering a token in the prose rings the matching chip on its scene card and the matching row in the bible; clicking jumps the sidebar to the right tab. Hovering a scene card flashes the matching scene marker in the prose.

Scene cards now use a stronger visual treatment when active (accent ring + tint + faint glow), and "jump to scene" smoothly tweens the textarea (220ms easeInOutCubic) instead of snapping.

A new third extraction kind, **Objects**, extracts recurring symbolic items (the letter, the fedora) alongside Characters and Settings. Editable in a new Objects tab in the storyboard sidebar, with the same AI-fills-blanks merge rule as the other bibles.

### Reference Repos — track upstream code we borrow from

Each app in `data/apps.json` (including PortOS itself) can now declare a `referenceRepos` array of upstream repos it watches for adoptable changes. Each entry stores the repo URL (or local path), branch, free-text notes describing what features rely on it, and a `lastReviewedSha` checkpoint. A new `reference-watch` self-improvement task type runs weekly (off by default), fetches each ref into `data/cos/reference-repos/<refId>/`, computes commits since `lastReviewedSha`, and dispatches a CoS sub-agent that writes a propose-only `REFERENCE_REVIEW.md` (Adopt / Maybe / Skip) to the app's repo. Read-only — no auto-implementation.

REST surface is mounted at `/api/apps/:appId/reference-repos` with full CRUD plus `POST /:refId/check` (run a check now) and `POST /:refId/reviewed` (manually pin the reviewed SHA). 26 new tests covering the service + route layers.

### Multi-keyframe video interpolation (LTX-2)

The video gen route now accepts an arbitrary `keyframes` array (`[{ file, index }, ...]`, length 2-8) on `mode='fflf'` for ltx2-runtime models, replacing the implicit two-frame cap of the existing `sourceImageFile` + `lastImageFile` pair. The underlying `KeyframeInterpolationPipeline` already supported N anchors at arbitrary pixel-frame indices — PortOS just exposes it now.

This is the compositional primitive Writers Room storyboards need: anchor every shot's keyframe-0 to the same character still for cross-shot continuity, pin pose/framing at specific timecodes, or set N storyboard panels as keyframes inside one render. Validation rejects non-ascending or out-of-range indices before the spawn so a typo doesn't burn a 30-second model load. Multi-keyframe is incompatible with `chunks > 1` (chains anchor a single clip).

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
- App icon detection: ship `data.sample/apps.json` with PortOS's icon path pre-set to `client/public/portos-logo.png`, and harden `detectAppIcon()` to skip SVGs that embed external `<image href="…">` (the icon endpoint serves SVG with `default-src 'none'` CSP, so those embeds are blocked and the icon renders blank). Detector now also checks `apple-touch-icon.png` and `icon-{192,512}.png` so PWAs without a usable favicon still resolve to a high-res raster. Hit "Detect Icon" once on existing installs to repick.
