# Review Queue Contract

The Review Hub's cross-domain queue is a live projection of producer-owned
records. It is not a durable universal task store, and it does not make an AI
provider call. Source records remain authoritative for mutations and detail
views.

## Response envelope

`GET /api/review/queue` without query parameters keeps the legacy full-list
response. `?limit=<1..100>` opts into the canonical envelope and a short-lived
snapshot:

```json
{
  "items": [],
  "total": 0,
  "totalsBySource": {},
  "sources": {},
  "nextCursor": null,
  "partial": false
}
```

The response also carries the compatibility `counts`, `generatedAt`, and row
fields already consumed by the Review Hub. `total` and each
`totalsBySource` value are `null` when a source failed or its bounded read was
truncated. `partial` is true in either case; an unavailable source must never
be represented as an empty, healthy inbox.

Each source descriptor includes `availability`, `available`, `error`,
`truncation`, `lowerBound`, `total`, and `shown`. A numeric lower bound counts
the unique rows collected from that source in the snapshot.

## Canonical rows

Rows retain the legacy `id`, `source`, `sourceLabel`, `title`, `summary`,
`timestamp`, `severity`, `drillTo`, and mutation fields. New consumers can use
the additive fields `sourceRef`, `actionKind`, `reason`, `nextAction`,
`priority`, `dueAt`, `revision`, `occurrence`, `required`,
`isRecommendation`, `operations`, and `availability`.

`operations` contains only semantic, allowlisted descriptors such as
`resolve`, `promote`, `review`, `investigate`, or `retry`; it never exposes a
producer URL or arbitrary command. The existing route-specific mutation
consumers remain the authority for executing those operations.

The queue may also include `triage` and `triageOperations`. `triage` contains
only `snoozedUntil`, `dismissed`, and `deliveryGeneration`; the latter is kept
separate from notification-read state for the delivery layer. `snooze` and
`unsnooze` change presentation only, while `dismiss` is advertised only for
`isRecommendation` rows. A triage mutation re-reads the source and rejects
unavailable sources or unsupported capabilities before writing the local
marker. Snoozes are limited to 30 days; the `snoozed` Actions view exposes
active snoozes so the user can restore one early.

Source-owned rows may also carry `sourceOwned: true` and `triageOnly: true`.
Generic Review completion rejects those rows; an explicit source operation
must revalidate the owning record at mutation time. A row with
`required: false` is a recommendation and remains available to its domain
without becoming an interruptive action.

Rows are deduplicated before totals and page slicing, then ordered by required
work, severity, overdue/due time, priority, and stable row ID. Optional
recommendations therefore remain below required work even when they are newer.

## Snapshot and producer extension points

The first paginated request reads each producer once and stores a process-local
snapshot for 30 seconds. `nextCursor` is opaque: pass it back unchanged, with
the same query, until it becomes `null`. An invalid, changed, or expired cursor
returns an explicit error so the caller can restart from the first page.

To add a producer, keep its source identity and mutation primitive in the
producer registry, map its raw record through the canonical row projection,
bound the upstream read, and report whether the bound was filled. Add a source
descriptor and operation to this document and cover the healthy, failed, and
truncated paths at the queue boundary. Do not add a second durable task store
or invoke an LLM as part of queue assembly.

## Action admission matrix

The queue admits an obligation only when its adapter has a stable reference and
a concrete human remedy or drill-down. Correlation uses source references and
metadata, never matching titles or prose. Two rows with the same proven
canonical reference are deduplicated; approval and feedback use different
action kinds and are never merged merely because they share a task or agent.

| Producer or bridge | Admission | Source reference and operation | History/context behavior |
| --- | --- | --- | --- |
| Brain inbox | Required when `needs_review` | Brain entry id; `brain.classify` / Done | Source remains authoritative |
| CoS approval store | Required when `awaitingApproval` | Task id; `task.approval` / Approve | Execution success does not create or complete an action |
| Message drafts | Required only for `pending_review` | Draft id; `message.approve` / Approve | Unsubmitted `draft` rows remain optional domain drafts |
| Memory approval | Required with `memoryId` | Memory id; `memory.approval` / Approve or Reject | Stale or already-resolved memory is a conflict/not-found, not a generic completion |
| Goal-fidelity hold | Required with agent/reference id | Agent id; `goal-fidelity.review` / Review | Remains pending until the source workflow resolves it |
| Plan question | Required with agent/app id and link | Agent/app id; `plan.question` / Review | The marker stays source-owned; generic warnings remain context |
| Paused automation | Required with series/run id and link | Series/run reference; `autopilot.resume` / Resume | Resume remains in the owning automation surface |
| Explicit content review | Required with report/reference id and link | Report or review id; `content.review` / Review | Private security and malware reports remain source-owned |
| Health and backup | Required only with a known human remedy | Alert or last-run identity; Investigate or Retry | No generic Complete operation |
| Legacy Review alerts | Required as explicit triage | Stored Review item id; `review.triage` / Review | Never silently completed or deleted |
| Briefings, generic warnings, client errors, and uncorrelated notifications | Not admitted | No proven obligation contract | Remain in Review history/context |

Optional Ask promotion is still available from Ask and its API, but it is not
required action admission. Routine task-ready/success attention generation is
not a queue producer; execution history and private reports remain separate.
