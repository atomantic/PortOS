# Release vNEXT

Released: TBD

## Overview

TBD

## Added

- **Use a different Chrome variant for the PortOS-managed browser.** PortOS now reads a `chromePath` (and `macAppBundle` on macOS) from `data/browser-config.json`, so you can point it at Chrome Canary, Chromium, Brave, Edge, or any Chromium-based browser — separating the automation surface from your daily-driver Chrome. Setup (`./setup.sh` / `setup.ps1`) and update (`./update.sh` / `./update.ps1`) now offer to install and configure Chrome Canary automatically: on macOS via `brew install --cask google-chrome@canary`, on Windows via `winget install Google.Chrome.Canary`. The prompt is interactive-only (CI / non-TTY runs skip silently), idempotent (won't re-prompt once configured), and supports `PORTOS_USE_CANARY=1` for headless opt-in. The Browser page's Config panel exposes both fields for after-the-fact edits.

## Changed

- **Universes table** — each row now shows a 48×48 thumbnail of the latest image from the universe's auto-managed media collection (the `Universe: <name>` bucket linked by `collection.universeId`). Rows without media fall back to a Globe placeholder; a broken file ref also degrades to the placeholder via `<img onError>`. Applies to both the desktop table and the mobile card layout.

## Fixed

- **Chief of Staff pane overflow** — content panel collapses to a single `flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden` div so tall tab content scrolls inside the panel instead of expanding it. Event log rows in both `EventLog` and `TerminalCoSPanel` get `break-all` so long unbreakable tokens (URLs, hashes, paths) wrap inside the 320px sidebar instead of pushing the column wider visually.
