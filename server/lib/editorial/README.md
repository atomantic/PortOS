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
template change). The digest body is capped (`EDITORIAL_PRIOR_DIGEST_CHARS`) so it
rides in the budgeter's safety margin rather than reserving a slice of the usable
budget — which would needlessly truncate the first/only chunk that carries no
digest. `style.conformance` (tense/POV established earlier) and
`objects.unmotivated-interaction` (setup/payoff across chapters) opt in;
`prose.info-dumping` stays per-chunk (its problems are localized).

## Discovery rule

Before adding an editorial rule, check whether an existing registry entry covers
it. To add a new built-in check, append an entry to `EDITORIAL_CHECKS` in
`checkRegistry.js` (the fail-fast guards enforce shape, enum, and unique-id).

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
| `checkRegistry.js` | `EDITORIAL_CHECKS` array + fail-fast guards + lookup/state helpers (`getCheck`, `getCheckById`, `getAllChecks`, `listChecks`, `resolveCheckState`, `getEnabledChecks`, `resolveCheckConfig`). User-defined-check helpers (`buildCustomCheck`, `buildCustomCheckPrompt`, `readCustomCheckDefs`, `isCustomCheckId`, `isValidCustomCheckDef`). Ships two reference checks: `naming.dissimilar-names` (deterministic) and `prose.info-dumping` (LLM). |
| `index.js` | Barrel re-export of the above. |
