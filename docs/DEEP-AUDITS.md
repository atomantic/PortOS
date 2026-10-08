# Deep audits

Deep is an extended regular audit, independent of **File issues** or **Audit and fix** delivery. Quick remains unchanged.

Choose Deep for extra investigation of high-risk paths, deeper caller/dependency and failure-case tracing, and multiple worthwhile fixes where evidence supports them. Each run aims to finish useful investigation and its authorized delivery. It does not require every repository file, a fixed file batch, or four separate review invocations. Existing resource limits, tests, independent review and PR policy still apply. Deep never grants merge or deployment permission by itself.

The final summary reports what was investigated, findings/fixes, actual validation, delivery and remaining risks or untested areas. Partial coverage is valid: successful task completion means the run finished its useful work, not that the repository is certified defect-free. Missing or invalid assessments still produce the normal warning. Interrupted work retains the ordinary failure, cleanup and worktree recovery behavior.

New manual, scheduled and custom Deep launches persist `auditWorkflow: "extended-v1"`. This marker is assigned only at creation, never while loading or resuming an old record. Unsupported workflow versions and attempts to attach historical checkpoint IDs to extended runs are refused. Provider, model, effort and delivery pins remain separate.

## Historical evidence

Previous exhaustive Deep ledgers, source pins, findings and worktrees are preserved. They remain visibly historical and incomplete; new Deep runs neither reuse them nor credit their receipts. Normal resume of those certification runs is disabled on the server and in the Quality UI. Their authenticated ledger endpoint remains available at `GET /api/cos/schedule/deep-audits/:id`.

See [historical evidence format](DEEP-AUDITS-LEGACY.md) for the archived architecture. No data migration marks those ledgers complete or removes them. Starting a new Deep audit creates a separate ordinary audit task; it does not delete or repurpose retained source work.
