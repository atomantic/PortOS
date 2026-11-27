# Local pregate

Run `npm run pregate` before every push and again after rebasing. Use
`node scripts/pregate.js` directly from a Windows shell if cmd cannot locate
the repository's `exec.cmd` shim. Hosted checks remain required.
See [GitHub Actions](GITHUB_ACTIONS.md).

## Focused and full runs

| Command | Runs |
| --- | --- |
| `npm run pregate` | Hidden-content scan, structural guards, lint and focused unit tests from the committed, staged, unstaged and untracked diff |
| `node scripts/pregate.js --guards-only` | Early structural checks |
| `node scripts/pregate.js --plan-only` | Show the plan without validating dependencies or executing checks |
| `npm run pregate -- --full` | Early checks and CI's planned server, client, smoke, build, browser and database stages locally |

The focused plan selects changed suites, sibling tests, bounded selectors
within two static, dynamic or mock import hops, and suites that name changed
non-module inputs. The receipt reports remaining coverage for hosted CI.
Exercise the changed behavior at its public boundary when the selector has
no matching test. The [test memo](TEST_MEMO.md) can reuse verified file passes.

Full mode uses CI's job environment and unit shard partition sequentially.
The browser stage uses the smoke profile and requires its local prerequisites.
The DB stage runs last and alone against `portos_test`. CI-only native checks,
missing prerequisites and explicit `--skip-db`, `--skip-browser`,
`--skip-build` and `--skip-smoke` are reported as skipped.

## Dependencies and receipt

Pregate checks all three installed workspaces against their lockfiles before
lint and tests. A linked worktree can continue with a warning for version-only
drift when its branch and working tree leave manifests and lockfiles untouched.
Dependency edits with drift, drift in an owned install, and missing or unreadable
evidence stop validation. Pregate can link a missing worktree dependency
tree from the primary checkout. Install development dependencies in the
owning workspace or in a separate clone. Never run npm install or npm ci
through a linked dependency tree.

The summary and `.cache/pregate/report.json` record base and HEAD SHAs,
the validated tree, `validationMode`, stages, guard timings and skipped
coverage. The pre/post snapshots must agree. A changing tree produces
`treeStable: false` and fails validation. Guard checks above the local
2.5-second target are named in the timing output. The hosted enforcement
pass has [its own budget](GITHUB_ACTIONS.md#guard-selection-and-registration).

## Interrupting pregate

On POSIX, Ctrl-C or SIGTERM reaches the active stage's process group.
Pregate gives it five seconds, then terminates and verifies the remaining
children before writing an incomplete receipt with `passed: false`. It also
checks for children after each completed stage. In Windows shells with
`NoDefaultCurrentDirectoryInExePath=1`, use the direct Node command above.

The test launcher separately verifies settlement of its owned workers.
An unknown settlement fails the run and retains its temporary root for
later cleanup. In hosted CI, bounded process categories can be recorded
in `processes.json` via `PORTOS_TEST_PROCESS_DIAGNOSTICS_PATH`.
