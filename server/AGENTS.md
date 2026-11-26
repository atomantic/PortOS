# Server conventions (`server/`)

Root instructions also apply.

## Validation and schema parity

- **Schema parity**: a new sanitizer, `createXxx` or payload field needs its Zod schema ([detail](../docs/INSTRUCTION_RULE_DETAIL.md#server-conventions)).
- Validate all JSON mutation bodies with the domain Zod schema and `validateRequest` ([schema placement](../docs/INSTRUCTION_RULE_DETAIL.md#server-schema-validation)). Keep the raw/multipart allowance shrinking.
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

Record writes sync only via `recordEvents.js`; peer-sync suites use `mockNoPeers()` / `mockNoPeerSync()` ([detail](../docs/INSTRUCTION_RULE_DETAIL.md#server-conventions)).

## Import scoping

Measure imports with `node scripts/lib/importReach.js <source>`. See [import scoping](../docs/INSTRUCTION_RULE_DETAIL.md#import-scoping).

- Import constants from their defining leaf and defer boot-only imports.
- Dynamic imports still affect CI selection. Use shared leaves, registered hooks or late-bound services to cut those edges.
- Use `import().then(...).catch(handler)` when outside an async scope.
- **Import growth is base-relative**: narrow or defer, or raise `EXISTING_SUITE_GROWTH_LIMIT` on purpose ([detail](../docs/INSTRUCTION_RULE_DETAIL.md#server-conventions)).
- Check for `vi.mock` before changing a barrel import specifier.

## Generated manifests

See [manifest maintenance](../docs/INSTRUCTION_RULE_DETAIL.md#generated-manifests).

- Derive cheap deterministic manifests on first use. Commit one only for expensive, nondeterministic or unavailable inputs.
- Key shipped manifests by file and semantic identity. Prove position invariance with `shiftSourceText`.


## Prompt templates

See [prompt and migration maintenance](../docs/INSTRUCTION_RULE_DETAIL.md#prompt-and-migration-maintenance).

- Run `node scripts/regen-shipped-prompt-hashes.js` after template edits. Keep historical hashes and migrations intact.
- Ship media model additions in `catalogDefaults.js` and updates through its compatibility chains.
- Use an unused migration number after dependencies. Keep shipped filenames stable and retire only through `RETIRED_MIGRATIONS`.
- Add new IDs to `data.reference/providers.json` and the toolkit sample. Decide compatibility for renames, removals and default changes.
- Freeze migration transforms with pure helpers and top-level purge markers. Put additive DDL in `ensureSchema`.
- After prompt-default edits, run `node scripts/regen-prompt-integrity-snapshot.js`. Take the base snapshot on conflict and regenerate.
- Classify new creative prompts in `server/lib/creativeLatitude.js` for visible IP latitude.
