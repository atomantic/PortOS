# Deep audits

Deep is an audit depth, independent of **File issues** or **Audit and fix** delivery. Quick remains the default and retains its broad scan followed by a bounded investigation.

## Run and resume

In an app's **Quality** tab, choose the categories, delivery policy, provider/model and **Audit depth → Deep**, then Run now. A launch performs one assigned pass, not the whole audit. A partial checkpoint stops the maintenance run. **Resume Deep audit** starts another invocation using the same coverage ledger. It may finish the current pass before moving to the next. Failed Deep tasks are parked rather than automatically retried. Boot and reading status do not launch work.

An app's **Automation** tab also exposes depth separately from delivery. An explicitly configured schedule can start a Deep audit; a partial task then parks and blocks further automatic dispatch for that app/category. Use Run Now to resume explicitly. Its app/category/delivery identity keeps the same ledger across those invocations. Custom agent jobs accept `taskMetadata.auditDepth: "deep"` and an optional `deepAuditId` for an explicitly selected checkpoint. A custom job without an audit category uses the code-quality coverage category. Different apps, categories and delivery modes cannot share a checkpoint.

Manual runs show discovery, reviewed units, satisfied/required pass requirements, blockers, pending candidates and delivery separately. Incomplete Deep runs remain in history even beyond the ordinary finished-run cap. The full local ledger and derived progress are available through authenticated `GET /api/cos/schedule/deep-audits/:id`; manual IDs are the maintenance step IDs, and scheduled/custom IDs are returned in the agent's `result.deepAudit.id`. Normal maintenance start/stop/resume endpoints remain the launch controls; start accepts `auditDepth: "quick" | "deep"`.

## Coverage and completion

The server pins a clean Git revision, tracked paths and blob IDs, inventory hash, detected capabilities, explicit exclusions, category prompt version, Deep contract version and effective task prompt hash. It inventories root files, code, tests, docs and configuration rather than filtering to popular source suffixes. Initialized submodules are recursively inventoried at their recorded commits. An unexpanded submodule blocks completion. Ignored runtime assets are outside the source inventory; required runtime evidence that cannot be obtained must remain blocked.

The initial units are category × source directory/subsystem × normal, failure, and concurrency/recovery scenarios. This is a minimum, not a claim that those three scenarios exhaust every workflow. Agents can add concrete workflows or entry-point scenarios through `additionalUnits`; additions increase the denominator and require the same passes. They cannot delete inventoried units.

Every required unit needs evidence from:

1. Static inspection, accounting for every file in that unit.
2. End-to-end tracing, recording entry, exit and the intervening path.
3. Adversarial investigation, recording scenario, expected behavior and observed outcome.
4. An independent challenge invocation, bound to the preceding evidence and attributed to a different server-issued agent identity.

Statuses are derived from receipts: pending, scanned, traced, validated, reviewed, blocked, or inapplicable with a reason. Inapplicability needs source references and pass-specific explanations, including independent confirmation. A scan count, quality score, successful process, first fix or five findings cannot complete discovery. Required units and passes must be accounted for and candidates triaged. The findings register retains confirmed, rejected, duplicate, deferred and resolved candidates separately from small remediation PRs.

Fix delivery also requires a post-fix pass against a clean, exact tested revision. All current post-fix receipts must bind to that revision; evidence from different revisions cannot combine into completion. A resolved finding names that tested revision and its fix/test evidence; changing the validation revision requires re-attesting prior resolutions. Discovery, remediation and delivery have separate outcomes: deferred fixes keep remediation incomplete. Actual execution and verification results settle delivery after evidence ingestion. Existing PR policy still governs delivery; selecting Deep does not authorize merging or deploying.

## Persistence and limitations

`deep_audit_ledgers` is machine-local PostgreSQL state. A row lock serializes checkpoint merges, and server-assigned attempt IDs plus report hashes make completion replay idempotent. The DB stores evidence, candidates, assignments and invalidated history. It is covered by PostgreSQL backup and does not federate. Additive, idempotent schema initialization provisions the table on upgrades and fresh installs; there is no seed or legacy data transform.

Agents atomically replace their checkpoint files after units, under `data/cos/deep-audit-checkpoints/`, outside source worktrees. Finalization imports them on success, failure or interruption before worktree cleanup. The JSON file preserves progress during an invocation; the UI's persisted counters advance when finalization imports it. Missing or malformed reports remain partial. The files contain private audit evidence and must not be committed. They are retained with CoS data for recovery; database receipts remain authoritative after import.

Source, inventory, capabilities, exclusions or prompt changes conservatively invalidate current evidence and retain it as historical. This first version invalidates the full generation rather than trying to prove which dependencies were unaffected. That includes resuming against a changed HEAD after an interrupted fix; the earlier discovery remains readable but does not certify the new source. Preserve and use the retained worktree/branch when recovering incomplete remediation.

Evidence is **agent-reported, source-verified**. The server checks assignment, scope, source blob identities, required evidence fields, ordering, separate invocation identity and exact revision bindings. It cannot prove that a natural-language trace is truthful or that a reported command actually ran. Independent challenge is a distinct invocation, not a guarantee of a different provider/model. Existing test and PR review requirements remain necessary. Deep mode may take many explicitly resumed invocations; it has no automatic repeat-until-perfect loop and launches no additional categories on its own.
