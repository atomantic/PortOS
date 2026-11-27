# Test memo

PortOS can skip a whole Vitest suite file when the same inputs already produced a passing, complete verdict. Failed files and partial runs never produce reusable full verdicts. Cold runs execute eligible suites normally. Use `PORTOS_TEST_MEMO=off` to disable both reads and writes. Use `PORTOS_TEST_MEMO_VERBOSE=1` to see reused files and their origins.

## What the key covers

The key includes suite content and its local static and dynamic dependency closure, runner/coverage configuration, lockfiles and runtime identity (Node, platform, architecture and relevant environment). It includes explicitly discovered non-module file inputs and scoped tree reads. Test-path and checkout-path differences are normalized only when the detector can prove equivalence. Unbounded dynamic input, unknown subprocesses, live services and machine-local reads fail closed. A dirty or newly added relevant file changes the key.

### Directory trees

The detector distinguishes literal file reads, scoped walks with provable path filters and whole-checkout input. A deterministic tree root and finite filters may be hashed. For a variable segment, the prefix, suffix and actual path construction must bound which paths are read. Unknown filters or path construction cannot produce a narrow key. A test that depends on tracked membership must include that membership as an input, even when the contents of all existing files match.

### Never memoized

Database-backed tests and always-run guards cannot earn a memo. Use `// test-memo: never` for a suite whose inputs must remain live or cannot be captured, and keep the marker near the owning input boundary. A name-pattern run cannot record reusable full-file success. Full verdict reuse is allowed for the same inputs when the requested test set is a subset. Smoke/full and browser project entries still use their respective context and strength rules.

## Git fixtures

Use `// test-memo: git-fixture` only when every Git command runs in a test-created fixture repository under the temp directory. Initialize that repository before any Git operation that could otherwise discover a containing checkout. Pass the fixture directory explicitly to subprocesses or wrappers. Never send Git a real checkout, reuse inherited cwd, read worktree state as an input or use unknown shell programs under this declaration.

The key includes the effective Git executable/version and inheritable Git configuration, including system/global includes and configured environment overrides. Temporary repository-local configuration comes from the test itself. Unverified Git identity or a call the detector cannot prove to be fixture-scoped refuses memoization. The marker is a checkable assertion, not a bypass. Keep the checkout and fixture Git paths separate and use temporary repos for all transitive wrappers. `scripts/lib/testMemo/gitFixture.js` owns the detector.

## Store

The default local store is `~/.portos/test-memo/`. Set `PORTOS_TEST_MEMO_DIR` to isolate a run's writable store. `PORTOS_TEST_MEMO_READ_DIRS` can add read-only stores for seeded runs. Entries are keyed by the verified input closure and written after complete passing execution. Corrupt, missing or incompatible entries fall back to running the suite. A memo hit is evidence about the same keyed inputs. Verification of live behavior requires an actual run.

## Shards

Shard selection and memo filtering have different jobs. Shards partition suite ownership deterministically; the memo may skip a safe prior pass inside the owned set. Keep shard or browser-project identity where it affects the executed tests. See [CI test selection](CI_TEST_SELECTION.md) for the full, changed and integration plans.

## Related selection

Changed-input selection narrows suites using dependency reachability. Memo reuse validates an already-selected suite against a known passing input key. Full, changed and browser runs must preserve their selection guarantees when records are missing, incomplete or ineligible. Never-memoized structural guards still run when the configured plan requires them. See [pregate](PREGATE.md) for the local plan.

## CI seeding

Hosted runners can seed from a trusted upstream memo. Keep seeded directories read-only and record results for the current run in its writable store. Missing or untrusted seeds cost execution time. They cannot become passing results. Build the execution report from memo hits and actual test outcomes for the selected head. See [hosted CI](GITHUB_ACTIONS.md) for job and cache configuration.
