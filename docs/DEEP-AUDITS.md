# Deep audits

Deep is an extended regular audit, independent of **File issues** or **Audit and fix** delivery. Quick remains unchanged.

Each Deep audit is exactly one agent run per selected check, which may take several hours (the policy text is `EXTENDED_AUDIT_INSTRUCTIONS` in `server/lib/auditWorkflow.js`); a batch of several checks runs them one after another.

Choose Deep for extra investigation of high-risk paths, deeper caller/dependency and failure-case tracing, and multiple worthwhile fixes where evidence supports them. Each run aims to finish useful investigation and its authorized delivery. It does not require every repository file, a fixed file batch, or four separate review invocations. Existing resource limits, tests, independent review and PR policy still apply. Deep never grants merge or deployment permission by itself.

The final summary reports what was investigated, findings/fixes, actual validation, delivery and remaining risks or untested areas. Partial coverage is valid: successful task completion means the run finished its useful work, not that the repository is certified defect-free. Missing or invalid assessments still produce the normal warning. Interrupted work retains the ordinary failure, cleanup and worktree recovery behavior.

New manual, scheduled and custom Deep launches persist `auditWorkflow: "extended-v1"`. This marker is assigned only at creation, never while loading or resuming an old record. Unsupported workflow versions and attempts to attach historical checkpoint IDs to extended runs are refused. Provider, model, effort and delivery pins remain separate.

## Historical evidence

Existing PostgreSQL ledgers from the retired certification workflow are retained. Historical certification runs cannot be resumed. New Deep audits use separate tasks and leave retained source work intact.

Quality run history is separate from tasks: deleting a task does not delete its batch record. Use **Archive run history** to hide an inactive run from the default Quality sidebar. **View archived runs** and **Restore run history** bring it back without resuming it. Evidence and findings remain stored. Runs with outstanding work cannot be archived.

The PR choice controls delivery only: drafts stay open for review, while the saved policy may allow merging. Selected checks execute sequentially within a batch regardless of that choice; it does not schedule rescans.
