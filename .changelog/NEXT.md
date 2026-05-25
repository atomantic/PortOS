# Release vNEXT

Released: TBD

## Overview

TBD

## Changed

- **Universes table** — each row now shows a 48×48 thumbnail of the latest image from the universe's auto-managed media collection (the `Universe: <name>` bucket linked by `collection.universeId`). Rows without media fall back to a Globe placeholder; a broken file ref also degrades to the placeholder via `<img onError>`. Applies to both the desktop table and the mobile card layout.
