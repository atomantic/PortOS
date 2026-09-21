# System alerts report actionable failures

Memory occupancy and short CPU-load samples are usage telemetry, not health
failures. Machines routinely fill RAM with models and run their CPUs at capacity.
Keep those measurements and process rankings, but do not turn them into warnings,
critical colors, Review items, or degraded health. Memory threshold fields remain
accepted for compatibility with older clients; the current UI no longer offers
controls that have no effect.

The alert audit retains these signals:

- Disk capacity nearing exhaustion: free storage before writes fail.
- Errored processes, crash loops, or failed automatic restart: inspect logs and repair.
- Process count exceeding the operator's configured limit: inspect runaway processes.
- Unavailable app status, database/schema, forge access, or reviewer configuration:
  restore the failed dependency or configuration.
- Recent task failures or skipped task types: repair the provider/prompt/task setup.
- Stalled goals and overdue relationships/replies: make the corresponding personal decision.
- Explicit approvals, unresolved task blocks, and requested feedback: provide the input.

Successful automatic restarts remain activity logs, not unresolved health issues.
Token/session volume spikes remain usage statistics: neither demonstrates actual
unexpected spending, so they must not produce a cost alert.

CoS-created Brain commitments with a `cos.task` reference consult their task's
current state before entering the Review queue. Queued/running automation,
completed/cancelled tasks, and timed cooldowns do not require human review.
Pending approvals and unresolved blocks remain visible. Missing tasks remain
visible; a failed task read reports source unavailability. Personal commitments
and history are preserved. This read-time projection covers existing recovery
threads without deleting records or rewriting user-owned state.

Health anomalies offer **Mark resolved**. Acknowledgements persist in the existing
machine-local Review triage store as `health.resolved:<alert-id>` actions, with
resolution time as occurrence and an evidence hash as revision. This adds a key
namespace, not an on-disk format or schema. The latest acknowledgement wins, even
if concurrent writes finish out of order, and queue pruning preserves it.

For low-success and learning warnings, only dated outcomes strictly after the
correction time count. Five new outcomes are required before another run-based
alert can appear. Neither lifetime learning history nor scheduler policy is
reset. Other alerts compare stable source evidence, so a renamed title or another
day passing does not resurrect an acknowledged issue. Changed failure evidence
can raise a new alert.

Compact action previews distinguish unavailable sources from bounded reads.
Preview limits use neutral explanatory text; real failures name their source and
offer Retry. A filtered widget derives completeness from its own sources, not
from an unrelated source's cap. Counts remain explicitly lower bounds when the
relevant source is incomplete or another page contains relevant actions.
