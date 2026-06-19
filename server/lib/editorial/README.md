# server/lib/editorial — editorial check registry

The backbone of the extensible editorial-review system (#1284, epic #1283): a
declarative registry of "editorial checks" that plug into the series pipeline.
Each check declares its scope, kind, default severity, a Zod config schema, an
optional gate, and a `run(ctx)` that returns findings shaped for the existing
`manuscriptReview` comment store. The runner that builds the shared `ctx`, runs
the enabled checks, and seeds findings lives at
`server/services/pipeline/editorial/checkRunner.js`.

This directory is **pure** (no side-effecting imports — only `zod` and the pure
`estimateTokens` budgeter). LLM-kind checks get their model caller through
`ctx.callStagedLLM` (or `ctx.callInlineLLM` for user-defined checks), and a
manuscript-consuming LLM check plans the corpus into provider-sized chunks
through `ctx.planManuscriptChunks` — all injected by the runner. Per-chunk
findings are merged first-wins (capped at the check's `maxFindings`) via
`editorialFindingKey`, so a long series is fully reviewed regardless of the
provider's context window (#1340).

Checks whose problems span chapters can opt into a **cross-chunk continuity
digest** (#1383): pass `crossChunkDigest: true` to `runManuscriptLlmCheck` and
each chunk after the first is prefixed with `editorialPriorFindingsDigest` of the
findings gathered so far (it rides INSIDE the manuscript var, so no prompt
template change). The digest body is capped (`EDITORIAL_PRIOR_DIGEST_CHARS`) and
**yields to manuscript coverage**: the runner's chunker reports each chunk's
`usableChars` budget, and the digest is prepended only when it fits the chunk's
spare room — so it never displaces manuscript text or overflows the provider
window (a chunk packed to the budget just runs without a digest).
`style.conformance` (tense/POV established earlier) and
`objects.unmotivated-interaction` (setup/payoff across chapters) opt in;
`prose.info-dumping` stays per-chunk (its problems are localized).

The findings digest carries prior *problems* forward but not clean prior *setup*
— a payoff in a later chunk can be mis-flagged "missing setup" when the earlier
chunk established it without producing a finding. A check can additionally opt
into a **cross-chunk clean-setup digest** (#1403): pass `crossChunkSetup: true`
(plus a per-check `setupFocus` string) to `runManuscriptLlmCheck`, and after each
non-final chunk one extra inline summarization call (`ctx.callStageScopedInlineLLM`,
tagged `EDITORIAL_SETUP_DIGEST_SOURCE`, built by `buildSetupDigestPrompt`) rolls a
short "setup so far" summary forward. The summary call is **stage-scoped** — it
resolves the same provider/model the check's stage is pinned to (not the active
provider), so manuscript text never routes to a different (e.g. cloud) provider
than the stage chose. The stored summary is capped to `EDITORIAL_SETUP_DIGEST_BODY_CHARS`
so a verbose summarizer response can't compound across chunks. `editorialSetupDigest` wraps it and prepends it to
later chunks alongside the findings digest — also yielding to spare budget, and
fitted *after* the findings digest so manuscript coverage and the findings digest
both win when budget is tight. A single-chunk (whole-fits) run never summarizes,
so it pays nothing. When the reverse-outline (#1349) or continuity-bible (#1305)
artifacts land, either could feed this context more cheaply than a per-chunk call.

## Discovery rule

Before adding an editorial rule, check whether an existing registry entry covers
it. To add a new built-in check, append an entry to `EDITORIAL_CHECKS` in
`checkRegistry.js` (the fail-fast guards enforce shape, enum, and unique-id).

Declare every input the check's `run(ctx)` reads in its `sources` array (a
non-empty subset of `EDITORIAL_SOURCES`: `manuscript`, `canon`,
`series.styleGuide`, `series.arc.tickingClock`, `series.arc.readerMap`,
`reverseOutline`, `reverseOutline.plotlines`, `editorialArcs`,
`series.characterArcs`). The staleness
runner fingerprints exactly those sources, so a finding goes stale only when
content the check actually analyzed drifts — declare too few and a finding stays
falsely fresh; a `manuscript` source must pair with `needsManuscript: true`, and
`reverseOutline` makes the runner fetch the cached reverse-outline (#1286) and
inject `ctx.reverseOutline` (the scenes array); `reverseOutline.plotlines` (#1310)
injects `ctx.reverseOutlinePlotlines` (the outline's plotline list) off that same
fetch, so the `plot.structure-momentum` check can reconcile dropped subplots
against the author's tagged threads. `editorialArcs` (#1295) makes the
runner fetch the series editorial aggregate and inject `ctx.editorialArcs` (the
detected per-character `{ name, arcDirection, issueCount, isProtagonist }`
projection — the coarse DETECTED arc signal) plus a derived
`ctx.editorialArcsComplete` boolean (true only when every analyzable issue is
analyzed and fresh), so a check can tell "absent because arc-less" from "absent
because not-yet-analyzed" under a partial coverage batch. `series.characterArcs`
(#1293) reads the AUTHORED per-character arcs off the already-loaded series
record (`series.characterArcs[]` — want/need, start → end state, transition
beats), which the `arc.transitions` check reconciles detected change moments
against. When a new check reads a
`ctx.series` field (or another artifact) that isn't yet a token, add the token to
`EDITORIAL_SOURCES` and a matching resolver in the runner's `SOURCE_RESOLVERS`.

## User-defined checks (#1346)

Users author their own LLM checks (name + prompt + scope) from the Editorial
Checks UI — no code change. A custom check's DEFINITION lives in settings
(`pipelineEditorialChecks.customChecks[]`); its enable/config override reuses the
SAME `checks[id]` slice the built-ins use. `buildCustomCheck(def)` synthesizes a
definition into the exact shape the registry/runner consume (an always-
manuscript-consuming LLM check, `id` prefixed `custom.`), so it flows through
`resolveCheckState` / `getEnabledChecks` / the runner identically to a built-in.
The fixed findings-JSON output contract is enforced by `buildCustomCheckPrompt`
(the user only describes WHAT to look for), and the model is called through the
runner-injected `ctx.callInlineLLM` (an inline-prompt sibling of
`ctx.callStagedLLM`, no shipped stage template). CRUD lives at
`POST/PATCH/DELETE /api/pipeline/editorial/custom-checks`.

| Module | Purpose |
|---|---|
| `checkRegistry.js` | `EDITORIAL_CHECKS` array + `EDITORIAL_SOURCES` (the per-check `sources` vocabulary the staleness runner fingerprints, #1387) + fail-fast guards + lookup/state helpers (`getCheck`, `getCheckById`, `getAllChecks`, `listChecks`, `resolveCheckState`, `getEnabledChecks`, `resolveCheckConfig`). User-defined-check helpers (`buildCustomCheck`, `buildCustomCheckPrompt`, `readCustomCheckDefs`, `isCustomCheckId`, `isValidCustomCheckDef`). Ships two reference checks: `naming.dissimilar-names` (deterministic) and `prose.info-dumping` (LLM). |
| `nameSimilarity.js` | Pure, dependency-free name-confusability primitives for `naming.dissimilar-names` (#1291): `normalizeName`, `vowelSkeleton`, `soundex` (phonetic key), `levenshtein` (edit distance), `nameSimilaritySignals` (the per-pair signal list, with option toggles), and `firstLetterHistogram` / `findFirstLetterClusters` (cast first-letter crowding). |
| `cliches.js` | Pure, dependency-free cliché + overwriting primitives for `prose.cliches` and `prose.modifier-stacking` (#1308): `CLICHE_PHRASES` (seed stock-simile/idiom list), `findCliches` (whole-word phrase scan with house-style allow/extra lists), and `findModifierStacking` (cumulative no-comma runs of 3+ stacked adjectives/adverbs). The LLM sibling `prose.dead-metaphor` handles the judgment cases (mixed/dead metaphor, novel clichés, purple prose). |
| `italicThoughts.js` | Pure, dependency-free italic-thought primitive for `prose.italic-thoughts` (#1300): `findItalicThoughts` (multi-word markdown `*…*` / `_…_` italic runs, dedup + word-count threshold so single-word emphasis, bold, and `snake_case` are skipped). The LLM siblings (`opening.wrong-start`, `prose.mirror-description`, `dialogue.pleasantries`, `prose.kill-your-darlings`) handle the judgment cases in the #1300 anti-pattern bundle. |
| `proseTics.js` | Pure, dependency-free copy-edit prose-tic primitives for the #1306 line-edit group: `tokenizeWords` / `splitSentences` (shared tokenization), `findFilterWords` (`prose.filter-words`), `findCrutchWords` (`prose.crutch-words`), `findAdverbs` (`prose.adverbs` — `-ly` adverbs + dialogue-tag adverbs), `findPassiveVoice` (`prose.passive-voice` — be-verb + past-participle heuristic), `findGestures` (`prose.repeated-gestures` — gesture tally + body-part autonomy), plus the seed `FILTER_WORDS` / `CRUTCH_WORDS` / `GESTURE_WORDS` lists. The LLM sibling `prose.telling-emotion` handles the named-emotion judgment case. |
| `repetition.js` | Pure, dependency-free word-echo & rhythm primitives for #1306: `findWordEchoes` (`prose.word-echoes` — distinctive word repeated within a window), `findRepeatedOpeners` (runs of sentences sharing an opener, "He… He… He…"), and `measureSentenceRhythm` (`prose.sentence-rhythm` — sentence-length variation). Reuses `tokenizeWords` / `splitSentences` from `proseTics.js`. |
| `index.js` | Barrel re-export of the above. |
