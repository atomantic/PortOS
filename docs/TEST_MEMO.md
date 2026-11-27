# Test memo

PortOS can reuse a complete passing Vitest file verdict with the same
verified inputs. Failed, partial and name-filtered runs cannot record
full-file passes. Set `PORTOS_TEST_MEMO=off` to turn off reads and writes.
Set `PORTOS_TEST_MEMO_VERBOSE=1` to show reused files and their origins.

## What the key covers

The key covers suite content, local static and dynamic dependency closure,
runner and coverage configuration, lockfiles, Node/platform/architecture,
relevant environment, and known non-module file and tree inputs. Scoped
walks need a deterministic root and provable path filters. Tests that read
tracked membership include that membership as an input. Dirty and newly
added relevant files change the key. Unknown subprocesses, unbounded paths
and live-service or machine-local inputs fail closed.

Always-run guards execute when the plan requires them. Use
`// test-memo: never` near the input boundary for tests that require live
inputs the detector cannot capture. Smoke/full and browser project entries
preserve their own context and verdict-strength rules.

## Git fixtures

Use `// test-memo: git-fixture` only if every Git call runs in a temporary,
test-created repository. Initialize it before any command could discover
an enclosing checkout. Pass its directory explicitly through wrappers.
The key includes the verified executable and Git version plus effective
system/global configuration, includes and environment overrides. The marker
is a reviewed claim. Review every route to Git, including wrapper calls and
repository paths passed through arguments or environment variables. The
declaration checker inspects direct spawn calls for a literal Git program
with separate arguments and an explicit `cwd` or leading `-C`. It rejects
a directory that resolves to the checkout or home, or is spelled as a
relative or nullish value.

## Database suites

Trusted CI can reuse complete verdicts in a separate `db` lineage. Inputs
include DB config, schema setup and tracked suite dependencies. The
collection fixture's key includes eligible tracked paths, staged identities,
effective modes and working bytes. Use `npm run test:db` for live validation
against `portos_test`. The impact plan can also require a live restore probe.

## Store and seeding

The default writable store is `~/.portos/test-memo/`. Use
`PORTOS_TEST_MEMO_DIR` to isolate writes and `PORTOS_TEST_MEMO_READ_DIRS`
to add read-only inputs. Hosted CI can seed from a trusted upstream store.
Keep seeds read-only and write complete successes to the current run's
store. A missing, corrupt, incompatible or untrusted record executes the
suite. The report combines matching memo hits and executed verdicts for
the selected head.

## Related selection

[CI selection](GITHUB_ACTIONS.md#test-selection) finds affected suites.
Shards partition the planned files. Memo reuse applies within that set
while preserving shard or browser-project identity where it affects the
run. Its absence cannot reduce required coverage.
