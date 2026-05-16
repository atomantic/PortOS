# Unreleased Changes

## Added

- **Universe Builder — per-category "Generate N more" variations.** Each category card now has a Generate dropdown (3 / 5 / 10 / custom up to 50) next to the existing Render / + Add buttons. The LLM is given the universe's bible context (logline, premise, style notes, influences, stylePrompt) plus the list of existing labels to skip, and returns N additional variations that get appended to the category. Locked items are unaffected — Generate is purely additive. Auto-saves when the universe is already persisted; otherwise hands you a "review then Save" toast. New endpoint: `POST /api/universe-builder/generate-variations`.

## Changed

- **Pipeline series arc — inline theme editing.** Theme pills on the Series Arc card are now directly editable: click a pill to rename, hover for the × to remove, click the dashed "+ Add theme" chip to append (up to 20 themes, 100 chars each — matching `ARC_LIMITS` on the server). Writes are optimistic with a single-flight save gate so a blur-then-click sequence can't double-persist against stale state. The redundant comma-separated themes input was removed from the "Edit arc" form; logline / summary / protagonist arc / shape still live there.

## Fixed

## Removed
