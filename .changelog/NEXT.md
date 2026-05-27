# Release vNEXT

Released: TBD

## Overview

TBD

## Added

- **Unified Story Builder** (`/story-builder`): a new guided page that walks a story from idea → universe aesthetic → plot arc → reader map → characters → issues → production as one linear flow. Each step is LLM-assisted with an AI-refinement affordance and ends with an explicit lock before the next unlocks; going back to revise an earlier step soft-flags the downstream locked steps as "stale" (integrity gate) so nothing silently drifts — without destroying their content. The builder is a thin conductor over the existing Universe / Series / Issue records (no data duplication); heavy per-issue production hands off to the existing Pipeline issue page. Reachable from the sidebar (Create → Story Builder), ⌘K, and voice. The intro screen supports two intake modes: **start from a seed idea**, or **import a finished work** (comic script / screenplay / novel / short story) — the importer reverse-engineers it into a universe, arc, characters, and issues, then drops you into the wizard to review and lock each stage. An **AI provider/model picker** at the top of the builder (and the import tab) drives every operation — idea expand, aesthetic, arc, reader map, character refine, and the import analysis — persisted on the session so one selection applies throughout. The **characters step generates a styled preview image per character** (world style fused with the character descriptor, via the same render path as the Universe Builder) and shows it alongside each character so you can eyeball that the world and character styles read correctly together.
- **Base style image (style probe)** on a universe: generate a canonical image from the raw style guide alone — style notes + the embrace/avoid influences as the positive/negative prompt, with no character or subject — to preview the world's base visual emphasis. Triggerable from both the Universe Builder (under the style/influences editor) and the Story Builder's Universe Aesthetic step; the result persists on the universe (`styleImageRefs`) so both surfaces share it.
- **Reader Map** on a series arc (`series.arc.readerMap`): a distinct audience-experience roadmap — hooks, payoffs, emotional beats, and cliffhangers across the arc — built on top of the Vonnegut story shape, separate from the protagonist arc. Generated and refined via the new Story Builder reader-map step (also preserved by arc regeneration).

## Changed

## Fixed

- Series detail page: when the Story Bible drawer is open, the Series Arc + Editorial Roadmap split and the inner text + 260px Themes panel split now respond to the actual content-area width instead of viewport width. Switched to Tailwind v4 container queries — Roadmap drops below Arc when the content area is < 1024px, and Themes stacks below the logline/summary column when the Arc card is < 672px, preventing the text column from being squeezed into an unreadable strip.

## Removed
