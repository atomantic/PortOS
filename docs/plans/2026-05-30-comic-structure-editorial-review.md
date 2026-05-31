# Context

The editorial review feature (`POST /pipeline/series/:id/manuscript/completeness`) runs an AI developmental-editor pass over the drafted manuscript. It uses a single format-agnostic prompt (`data.reference/prompts/stages/pipeline-manuscript-completeness.md`) that tells the LLM to "read whichever format it is." For prose and teleplay this works fine.

For comic scripts, it misses a whole class of structural problem: pages where an author (or a previous AI stage) dumped all story content into the page-level description instead of breaking it into panel definitions. The example from issue page 49: ~6 paragraphs of scene content in the page header, a single empty `PANEL 1` block at the bottom, and `PAGE 50` after it. This is syntactically valid markdown but comics-production-invalid — the image generator and letterer work panel-by-panel, so a page with no real panels can't be rendered.

The current prompt has no instruction to check for this. Its five categories (`missing-content`, `arc-gap`, `character-gap`, `pacing`, `continuity`) are all narrative/story-level — none of them catch structural format violations.

## What needs to change

### 1. Update `pipeline-manuscript-completeness.md` — add a `comic-structure` category

Add a sixth category and a new section to "What to look for":

**`comic-structure`** — Pages in a comic script where all or most content lives in the page-level description rather than in panel definitions. Indicators: a page with 0 or 1 panels where the page description contains full scene content (action, dialogue, internal beats); a `PANEL N` block with no `Description:` field or only a placeholder; or a block of prose above the first panel that reads like scene content, not a layout note.

For `comic-structure` findings, the `suggestion` must be a **full panel-by-panel rewrite** of the malformed page — not advice like "add panels," but the actual structured content: `Panel 1 / Description: ... / Caption: ... / Dialogue: ...` etc. This is because the fix is applied as a find-and-replace (`anchorQuote` → `suggestion`), and prose advice is not directly usable.

Also update the prompt's framing paragraph (line 3) and the "The drafted manuscript" section (line 55) to make clear this applies equally to comic scripts, with the structural dimension added.

### 2. Update the output contract — add `comic-structure` to the category enum

The output contract currently lists:
```
"category": "missing-content|arc-gap|character-gap|pacing|continuity"
```

Extend to:
```
"category": "missing-content|arc-gap|character-gap|pacing|continuity|comic-structure"
```

And add the severity/suggestion rule for this category:
- Always `high` severity — a page with no panels cannot be rendered
- `suggestion` must be the full restructured page content (all panels with `Description:`, `Caption:`, `Dialogue:`, `SFX:` fields), not prose advice

### 3. No schema/code changes needed for the finding storage

`manuscriptReview.seedReviewFromFindings` stores `category` as a free string — no enum enforcement on the server side. The client category badge renderer in the manuscript review UI will just show "comic-structure" as a new badge. No route, service, or Zod schema changes required.

The fix application path (`acceptManuscriptFix`) uses `anchorQuote` (the malformed page text) as the `find` substring and `suggestion` as the replacement — this works exactly right for panel restructuring, since the `anchorQuote` will anchor to the page header block and the suggestion will be the properly structured replacement.

## Files to modify

| File | Change |
|------|--------|
| `data.reference/prompts/stages/pipeline-manuscript-completeness.md` | Add `comic-structure` category to "What to look for", update output contract enum + add per-category suggestion rule for comic-structure |

That is the only file to change — the fix is entirely prompt-side.

## Migration note

No migration needed. The prompt file is in `data.reference/prompts/stages/` — it is copied to `data/prompts/stages/` on first install by `scripts/setup-data.js`. Existing installs will keep their old copy. Per the CLAUDE.md convention, this needs a migration entry in `scripts/migrations/` to update the installed prompt when its hash matches the pre-change shipped version. This migration should be added alongside the prompt change.

## Verification

1. Open the series at `/pipeline/series/ser-c22c6c9e-3a02-43be-bc38-6cd2de82bd27/manuscript`
2. Run the editorial review
3. Confirm that page 49 (the page with all content in the page description and only an empty `PANEL 1`) surfaces a `comic-structure` finding with `severity: high`
4. Confirm the `suggestion` is a panel-by-panel rewrite of the page content, not prose advice
5. Accept the fix and confirm the page in the manuscript is updated to have proper `Panel N / Description: / Caption: / Dialogue: / SFX:` structure
