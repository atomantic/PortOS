# Release vNEXT

Released: TBD

## Overview

TBD

## Added

- **Use a different Chrome variant for the PortOS-managed browser.** PortOS now reads a `chromePath` (and `macAppBundle` on macOS) from `data/browser-config.json`, so you can point it at Chrome Canary, Chromium, Brave, Edge, or any Chromium-based browser — separating the automation surface from your daily-driver Chrome. Setup (`./setup.sh` / `setup.ps1`) and update (`./update.sh` / `./update.ps1`) now offer to install and configure Chrome Canary automatically: on macOS via `brew install --cask google-chrome@canary`, on Windows via `winget install Google.Chrome.Canary`. The prompt is interactive-only (CI / non-TTY runs skip silently), idempotent (won't re-prompt once configured), and supports `PORTOS_USE_CANARY=1` for headless opt-in. The Browser page's Config panel exposes both fields for after-the-fact edits.

## Changed

- **Dashboard Quick Image widget** — now exposes **resolution** and **negative prompt** options (collapsible) alongside the prompt, and renders the result inline: async backends stream the diffusion loading animation (spinner / step counter / latent preview) and resolve to the final image, mirroring the Universe asset slots via the shared `MediaJobThumb`. Sync (external) backends show the completed image directly. The "Edit" hand-off now carries the chosen size + negative prompt into the full Image Gen page.

- **Universes table** — each row now shows a 48×48 thumbnail of the latest image from the universe's auto-managed media collection (the `Universe: <name>` bucket linked by `collection.universeId`). Rows without media fall back to a Globe placeholder; a broken file ref also degrades to the placeholder via `<img onError>`. Applies to both the desktop table and the mobile card layout.

- **Writers Room auto-collapses the header + library when you open a work.** Tapping a library item now collapses both the page header and the library so the editor gets the full screen — most useful on mobile, where the library is an inline block stacked above the editor. The header shrinks to a slim bar that hosts the "show library" control (reachable on mobile, where there was previously no expand affordance), and the library always re-appears whenever no work is selected so you're never stranded.

## Fixed

- **Tabbed sub-nav strips no longer drift vertically on mobile.** The horizontally-scrolling sub-nav tabs (Media Gen and every other page that uses the shared `TabPills` primitive) could be dragged diagonally/vertically on iOS, producing an uneven, wonky scroll. Both `TabPills` scroll containers now set `touch-action: pan-x` so touch gestures pan the strip horizontally while vertical drags pass through to normal page scrolling.
- **Chief of Staff pane overflow** — content panel collapses to a single `flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden` div so tall tab content scrolls inside the panel instead of expanding it. Event log rows in both `EventLog` and `TerminalCoSPanel` get `break-all` so long unbreakable tokens (URLs, hashes, paths) wrap inside the 320px sidebar instead of pushing the column wider visually.
- **Videos now load in the Media Gen preview on mobile.** Both the preview-modal (lightbox) `<video>` and the Video Gen page's inline result preview autoplayed unmuted, which iOS/Android block outside a direct user gesture — so the clip never started and the area showed only black ("not loading"). They now play `muted` (autoplay-eligible everywhere; controls let you unmute) and render the thumbnail as a `poster`, so the frame is visible immediately even while the clip buffers.
- **Video previews now play with sound on mobile.** Opening a video from Media Gen history previously stayed silent because the muted-autoplay baseline (needed so the clip loads at all on iOS/Android) was never upgraded to audible. The lightbox now unmutes and re-plays on open — the opening tap's user activation lets iOS grant audible playback — and falls back to muted if the browser blocks it, so the clip always runs and the controls can unmute it manually.
