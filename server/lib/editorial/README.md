# server/lib/editorial — editorial check registry

The backbone of the extensible editorial-review system (#1284, epic #1283): a
declarative registry of "editorial checks" that plug into the series pipeline.
Each check declares its scope, kind, default severity, a Zod config schema, an
optional gate, and a `run(ctx)` that returns findings shaped for the existing
`manuscriptReview` comment store. The runner that builds the shared `ctx`, runs
the enabled checks, and seeds findings lives at
`server/services/pipeline/editorial/checkRunner.js`.

This directory is **pure** (no side-effecting imports). LLM-kind checks get
their model caller through `ctx.callStagedLLM`, injected by the runner.

## Discovery rule

Before adding an editorial rule, check whether an existing registry entry covers
it. To add a new check, append an entry to `EDITORIAL_CHECKS` in
`checkRegistry.js` (the fail-fast guards enforce shape, enum, and unique-id).

| Module | Purpose |
|---|---|
| `checkRegistry.js` | `EDITORIAL_CHECKS` array + fail-fast guards + lookup/state helpers (`getCheck`, `listChecks`, `resolveCheckState`, `getEnabledChecks`, `resolveCheckConfig`). Ships two reference checks: `naming.dissimilar-names` (deterministic) and `prose.info-dumping` (LLM). |
| `index.js` | Barrel re-export of the above. |
