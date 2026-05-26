# Release vNEXT

Released: TBD

## Overview

TBD

## Added

- **Set your home location in Settings → General.** Enter a latitude and longitude and the voice assistant's weather command ("what's the weather?") reports conditions for where you are instead of a default city. Leave both fields blank to fall back to the default location.

## Changed

## Fixed

- **Federated media collections: a merged-away duplicate no longer survives on peers.** When a universe (or series) *merge* tombstones the loser's auto-collection, a receiving peer applies the universe tombstone first — and its cascade (`unlinkCollectionsForUniverse` / `unlinkCollectionsForSeries`) was stamping the linked collection's `updatedAt` to "now", which then defeated the collection's own (older) tombstone under Last-Writer-Wins and left a live duplicate "Universe: X" collection on the peer. The cascade unlink now **preserves `updatedAt`** (it's a derived side-effect of the owner's deletion, not a user edit), so the collection tombstone still wins and both machines converge to deleted. Items are never lost — they're always unioned on merge.

## Removed
