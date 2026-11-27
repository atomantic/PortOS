# Server conventions (`server/`)

Root instructions also apply.

## Validation and schema parity

- **Schema parity**: a new sanitizer, `createXxx` or payload field needs its Zod schema.
- Validate JSON mutation bodies with their domain Zod schema and `validateRequest`. Use `schema.partial()` for partial updates and shared fragments from `lib/sharedSchemas.js`. Keep the raw/multipart allowance shrinking.
- Validate the entire query on every method. Shared shapes live in `lib/queryValidation.js`.

## Offering models vs running them

**A caller that offers a model choice reads `getSelectableProviders()` / `listSelectableProviders()`; a caller that executes, accounts or writes reads `getAllProviders()` / `listProviders()`.** The selectable pair narrows `models` to the install's entitlement (`docs/MODEL_ACCESS.md`). Wrong either way fails silently: an unscoped picker offers models the account can't run; a scoped write persists a truncated catalog. Route payloads shaped by `presentProvider` are already scoped; direct service reads are not.

## Write serialization and throughput

- **Serialize writes that can race on a shared record server-side**, at the file level: every PATCH awaits the previous one before reading state. Client guards are unreliable. A `Map<recordId, Promise>` is not enough when records share one state file; use one tail per file. Example: `queueSeriesIssuesWrite` in `server/services/pipeline/issuesShared.js`.
- **High-frequency state writes batch.** A per-line `withStateLock → loadState → saveState` mutation (`appendAgentOutput` in `server/services/cos/cosAgentLifecycle.js`) is fine at human pace, not from PTY or tool-call streams: add an array variant (`appendAgentOutputLines`), flush on a ~250ms debounce, and drain the buffer in the producer's cleanup before the final state write.

## PostgreSQL parameters

**Use `toPgJson` (`server/lib/pgJson.js`) for PostgreSQL JSON parameters.**

## Async boundaries

- Catch async timer rejections. Log and continue unless the callback owns the failure verdict.
- Await async calls, catch them or use `void` when the callee owns rejections.
- Catch async Socket.IO handler rejections.
- Attach child listeners before awaiting anything.

## Tests and peer fan-out

Record writes sync only via `recordEvents.js`. Suites reaching `peerSync.js` or `sharing/index.js` mock instances with `mockNoPeers()` and peer sync with `mockNoPeerSync()`, both from `server/lib/mockPathsDataRoot.js`. Test auto-subscription with `registerSubscriptionAdapter()` and reset it with `__resetSubscriptionAdapter()`.

## Import scoping

Measure imports with `node scripts/lib/importReach.js <source>`.

- Import constants from their defining leaf and defer boot-only imports.
- Dynamic imports still affect CI selection. Use shared leaves, registered hooks or late-bound services to cut those edges.
- Use `import().then(...).catch(handler)` when outside an async scope.
- **Import growth is base-relative.** Narrow or defer imports. If the limit needs to grow, raise `EXISTING_SUITE_GROWTH_LIMIT` in the same change and name the module that needs it.
- Check for `vi.mock` before changing a barrel import specifier.

## Generated manifests

- Derive cheap deterministic manifests on first use. Commit one only for expensive, nondeterministic or unavailable inputs.
- Key shipped manifests by file and semantic identity. Prove position invariance with `shiftSourceText`.

## Prompt templates

- Run `node scripts/regen-shipped-prompt-hashes.js` after template edits. Keep historical hashes and migrations intact. The hash-based upgrade preserves customizations.
- Ship media models in `catalogDefaults.js`. For updates, match prior shipped values in `VIDEO_REGISTRY_UPGRADES` or the image backfill chain to preserve customizations.
- Use an unused migration number after dependencies. Keep shipped filenames stable and retire only through `RETIRED_MIGRATIONS`.
- Add new IDs to `data.reference/providers.json` and the toolkit sample. Decide compatibility for renames, removals and default changes.
- Freeze migration transforms with `_lib.js` primitives or pure helpers. Keep purge markers top-level and put additive DDL in `ensureSchema`.
- After prompt-default edits, run `node scripts/regen-prompt-integrity-snapshot.js`. Take the base snapshot on conflict and regenerate.
- Classify new creative prompts in `server/lib/creativeLatitude.js` for visible IP latitude.
