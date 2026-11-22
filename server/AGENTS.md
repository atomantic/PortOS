# Server conventions (`server/`)

These apply to Express/service/model code; the root `AGENTS.md` rules always apply. Rules marked *enforced* have a tree-wide test that names the offender; unless noted, it has no allowlist.

## Validation and schema parity

- **Schema parity**: a new sanitizer, `createXxx` or payload field needs its Zod schema ([detail](../docs/INSTRUCTION_RULE_DETAIL.md#server-conventions)).
- **A POST/PUT/PATCH handler reading `req.body` validates it with a schema** (`validateRequest(schema, req.body ?? {})`, schema in the route family's domain `server/lib/*Validation.js` file, which is the only home for a schema; a fragment two domains need lives in `sharedSchemas.js`), not a hand-rolled check. *Enforced:* `server/test/guards/runtime/routeValidationConventions.test.js` over `server/routes/`, `lib/aiToolkit/routes/` (schemas in `lib/aiToolkit/validation.js`) and `cos-runner/index.js` (`requestSchemas.js`). Its `ALLOWED_UNVALIDATED` list (raw-binary and multipart bodies) may only shrink; never add a JSON-body handler (#9950).
- **A handler reading `req.query` validates the whole query object** on any method (`validateRequest(schema, req.query)` or `validate` / `parseBody` / `safeParse` / `Schema.parse` on it or a name assigned from it; one field or `req.params` doesn't count, nor does `parsePagination`). Shared lenient shapes (pagination, flags) live in `lib/queryValidation.js`; the same test has no allowlist for query reads (#10024, #16428).

## Offering models vs running them

**A caller that offers a model choice reads `getSelectableProviders()` / `listSelectableProviders()`; a caller that executes, accounts or writes reads `getAllProviders()` / `listProviders()`.** The selectable pair narrows `models` to the install's entitlement (`docs/MODEL_ACCESS.md`). Wrong either way fails silently: an unscoped picker offers models the account can't run; a scoped write persists a truncated catalog. Route payloads shaped by `presentProvider` are already scoped; direct service reads are not.

## Write serialization and throughput

- **Serialize writes that can race on a shared record server-side**, at the file level: every PATCH awaits the previous one before reading state. Client guards are unreliable. A `Map<recordId, Promise>` is not enough when records share one state file; use one tail per file. Example: `queueSeriesIssuesWrite` in `server/services/pipeline/issuesShared.js`.
- **High-frequency state writes batch.** A per-line `withStateLock → loadState → saveState` mutation (`appendAgentOutput` in `server/services/cos/cosAgentLifecycle.js`) is fine at human pace, not from PTY or tool-call streams: add an array variant (`appendAgentOutputLines`), flush on a ~250ms debounce, and drain the buffer in the producer's cleanup before the final state write.

## PostgreSQL parameters

**Serialize a `json`/`jsonb` parameter with `toPgJson` (`server/lib/pgJson.js`), never bare `JSON.stringify`**; Postgres rejects a lone surrogate or NUL, so the write throws and the record is lost (#12815; *Enforced:* `server/test/guards/runtime/pgJsonConventions.test.js`) ([why](../docs/INSTRUCTION_RULE_DETAIL.md#server-conventions)).

## Async boundaries

- **An `async` timer callback owns its rejections**: every `await` inside `setTimeout(async …)` / `setInterval(async …)` has an enclosing `try`/`catch` or a `.catch(…)`, because an unhandled rejection is fatal on Node ≥15 (#5668). Log and continue unless the callback owns a failure verdict. *Enforced:* `server/test/guards/runtime/timerCallbackConventions.test.js` (example: `services/mediaJobQueue/execution.js` watchdog).
- **A statement-level call to an `async` function is `await`ed, ends in `.catch(…)`, or starts with `void`** (`void` = it owns its rejections); a bare call's rejection becomes an `unhandledRejection` that `autoFixer` turns into an AI task (#12978). *Enforced:* `server/test/guards/runtime/floatingAsyncConventions.test.js`.
- **An `async` Socket.IO handler owns its rejections** the same way (whole-body `try`/`catch` as in `voice.js`, or `.catch` on the awaited chain as in `logs.js`); an escaped rejection terminates the process (#5661). *Enforced:* `server/sockets/asyncHandlerGuard.test.js`.
- **Attach child listeners before any `await`** ([detail](../docs/INSTRUCTION_RULE_DETAIL.md#server-conventions)). *Enforced:* `server/test/guards/runtime/childListenerOrderConventions.test.js`.

## Tests and peer fan-out

Record writes sync only via `recordEvents.js`; peer-sync suites use `mockNoPeers()` / `mockNoPeerSync()` ([detail](../docs/INSTRUCTION_RULE_DETAIL.md#server-conventions)).

## Import scoping

Every suite reaching a module instantiates its whole closure. `server/lib/importScoping.test.js` holds the base-relative growth guard and the architectural boundary tests, with no per-edge rows to update when you narrow or move a module; measure fan-out with `node scripts/lib/importReach.js <repo-relative source>`.

- **Don't drag a subtree in for one constant.** Import from the declaring module (`CHECK_SCOPES` from `server/lib/editorial/checkInfra/taxonomy.js`, not the `checkRegistry.js` barrel), and `await import()` a dependency only a boot/rare path needs (`ensureSchemaImpl()` composes DDL that way).
- **A lazy `import()` cuts instantiation, not CI selection**: `vitest related` follows dynamic imports too (#12285). To cut selection, move the needed piece into a leaf both sides import (`services/readinessSignal.js`), or have the heavy service register a callback at boot (`initAutoFixer()` → `services/provider/providerRecoveryHooks.js`). Cut edges are pinned in `SELECTION_CUTS`; a suite that `vi.mock`ed the heavy module registers test doubles instead.
- **Outside an async scope, defer with `import('./x.js').then(…).catch(handler)`** (how `services/promptRunner.js` defers `tuiPromptRunner.js`), ideally inside an existing predicate gate (`runner.js` defers `ollamaAgentContext.js` in the `isOllamaBackedProvider` ternary).
- **Import growth is base-relative**: narrow or defer, or raise `EXISTING_SUITE_GROWTH_LIMIT` on purpose ([detail](../docs/INSTRUCTION_RULE_DETAIL.md#server-conventions)).
- **Never narrow an import around a barrel a suite mocks**: `vi.mock('./cos.js')` intercepts the specifier, so re-pointing a caller at `./cosTaskStore.js` silently bypasses the double. Grep for `vi.mock` of the module first; a lazy `await import()` has no such hazard.

## Generated manifests

- **Derive at first use before committing a manifest.** Deterministic, cheap, shipped-input inventories are computed in memory behind a per-process cache (`server/lib/apiRouteGraph.js`, `socketEventInventory.js`). Commit one only when derivation is slow, nondeterministic or needs inputs an install lacks (`promptStageCallSites.generated.json`).
- **A checked-in manifest is addressed by content, never position**: key each record by declaring file plus semantic identity, never `foo.js:412` (churns and conflicts on unrelated edits). Positional detail may stay in memory (`routeDeclarationKey` in `server/lib/apiRouteGraph.js`).
- **Prove it with `shiftSourceText`** (`scripts/lib/positionInvariance.js`): shift the inputs, regenerate, require byte-identical output. `server/test/guards/repo/generatedManifests.test.js` backstops the tree by scanning tracked `*.generated.json` for position-shaped keys and failing when a `scripts/*.js` writing one has no sibling test importing `positionInvariance.js`.

## Prompt templates

- **A prompt template edit needs no migration.** After changing a `data.reference/prompts/{stages,_partials,skills}/*.md` body, run `node scripts/regen-shipped-prompt-hashes.js`: it retires the outgoing hash into `data.reference/prompts/shipped-hashes.json`, and `reconcileShippedPrompts` (`scripts/migrations/shippedPromptHashes.js`, run after every migration pass) upgrades installed copies on a retired hash and leaves customized ones alone. `server/test/guards/repo/shippedPromptHashes.test.js` fails on a missed regen, a dropped hash or a new `makePromptReplaceMigration`; never re-point the few prompt-hash migrations left. `makeSeedMigration` only copies missing files.
- **A migration's number orders it; its filename identifies it.** Pick an unused number after its dependencies. The applied-list keys on filenames, so historical collisions stay intact. Renaming or deleting a shipped migration can re-run or drop it on installs, so `server/test/guards/repo/migrationFilenames.test.js` fails on it. Retire via its reviewed `RETIRED_MIGRATIONS` list.
- **Add model IDs to the shipped provider catalog.** Additive changes in `data.reference/providers.json` reach installed presets at startup after migrations, honoring `removedModels` and explicit preset narrowing. Keep the aiToolkit sample catalog in sync. A model rename, retirement, or default change needs its own compatibility decision.
- **A new migration is a frozen snapshot of its transform**: it imports `_lib.js` primitives, `server/lib` pure helpers or a frozen copy, never `server/services`; declares no local copy of a `_lib.js` helper; and writes any `purge: true` marker as a top-level property of the default export. Additive DDL needs no migration (`ensureSchema`); log-only stubs fail. *Enforced:* `server/test/guards/repo/migrationConventions.test.js`.
- **Prompt-default changes: edit the body, then run `node scripts/regen-prompt-integrity-snapshot.js`**. The snapshot (`services/taskPromptDefaults/integrity.snapshot.json`) owns the version numbers (`versions.js` re-exports them), so the regen bumps the version and retires the old hash so other installs upgrade stored defaults (`promptMatchesShippedDefault`); never hand-edit one. After a snapshot rebase conflict, take the base side and rerun it. Retired bodies live only in git history; never paste one back as recognition data (the literal in `taskPromptDefaults/retiredPromptFixtures.js` is a test fixture). No migration is needed: `readSchedule()` in `services/taskScheduleStore.js` upgrades uncustomized stored prompts (`data/cos/task-schedule.json`) on next load, and `server/test/guards/repo/promptBumpMigrations.test.js` fails on a new prompt-bump migration.
- **Creative prompts get the IP-latitude clause by classification, not by wrapping call sites.** Classify a new creative stage in `server/lib/creativeLatitude.js` (its header lists the two chokepoints, the token reserve and the shown-never-hidden contract, #11317); `creativeLatitude.test.js` and `server/test/guards/modules/creativeLatitude.sources.test.js` fail on unclassified entries.
