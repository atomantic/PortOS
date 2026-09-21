# Catalog Ingest

Ingest extracts review candidates from a source only when the user requests it.
Babble remains its separate, explicitly selected brainstorm-pruning workflow.
Extraction itself writes no ingredients; saving selected candidates is a separate action.

The `catalog-extract` prompt returns the existing `characters`, `places`,
`objects`, `ideas`, `scenes`, and `concepts` arrays, plus `relationships` with
`fromDraftId`, `toDraftId`, `kind`, and quoted `evidence`. Each entry has an
extraction-local `draftId`; optional `sourceIdentity` is a distinctive quoted
phrase, not a persisted entity ID. Consumers must keep these metadata fields
outside ingredient payloads. Relationship review/commit is an additive consumer
of this graph; legacy entry-only and Babble consumers remain usable.

The source title/kind and factual lens travel through every chunk. Factual
entries receive `factual`; real people additionally receive `real-person`.
The shared bible sanitizers retain rich character/place/object fields. The
prompt distinguishes ownership from use, preserves significant unnamed objects,
and excludes incidental generic props. Quotes are checked against the supplied
source; semantic support still needs the user's review.

## Context and calls

Planning resolves the stage's actual provider/model first, including explicit
overrides and runtime context limits. A fitting parent source uses exactly one
call even when ingestion previously stored child scraps. Otherwise the complete
parent text is split at natural boundaries, with at most two calls in flight.
The planner verifies every rendered prompt, including customized templates and
the creative policy. The exact rendered prompts and provider/model are pinned
through execution; automatic fallback spending is disabled.

Token estimates use the shared chars/4 heuristic, a 10% safety margin, and an
output reserve of one quarter of the window, capped at 8,000 tokens. Unknown
capacity uses the conservative 8,192-token context budget (2,048 output tokens).
These estimates are not a tokenizer guarantee. API calls receive the output
cap; CLI providers keep their own output controls. If overhead alone cannot
fit, planning fails before any generation. Nothing silently truncates the source
or switches to additional extraction passes.

The response's `plan` reports mode, route, window, reserve, and per-chunk source
offsets/input estimates. `stages` and socket progress use one row per actual
call, retaining the parent `scrapId` and shared `runId`. `coverage.status` is
`complete` or `partial`, with completed/total chunk counts and failed indexes.
A partial draft retains successful candidates and visibly identifies failed
parts. All-chunk failures return an error. Retry is a user action; selecting
more context/output capacity or a shorter source can address capacity failures.

Malformed/truncated JSON, missing arrays, invalid IDs/edges, unsupported kinds,
ungrounded quotes, relationship evidence above the 400-character commit limit, and provider output-limit stops are recoverable failures,
never successful empty drafts. Truly empty arrays are valid.

## Chunk reconciliation

Chunk IDs are remapped before edges are combined. Type/name equality alone
never merges candidates. Generic source phrases and determiner-only aliases
never authorize a merge. A source identity needs at least two distinguishing
words beyond the entry labels and grammatical words; otherwise it stays a
separate candidate. Only distinctive source identities or explicit,
unambiguous aliases can reconcile repeats; competing same-chunk candidates stay
separate. Supported fields/evidence are unioned, and a field conflict or cap
that would lose information leaves separate review candidates instead.
Relationships come solely from validated chunk outputs; no cross-chunk links
are invented. Aggregate candidate/edge overflow is reported, never truncated.
The later review consumer must reduce a batch above 200 entries or 1,000 edges
before committing it.

The stage ships through a seed migration that preserves customized installed
prompts. This is an extraction-only response change, not a persisted format or
federation envelope change.
