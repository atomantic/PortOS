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
| Product recommendations | Optional when a current POST or creative-feedback signal is available | Product action id plus local-day/run occurrence; Open | Feature-disabled signals disappear without deleting their local triage marker |
| Legacy Review alerts | Required as explicit triage | Stored Review item id; `review.triage` / Review | Never silently completed or deleted |
| Briefings, generic warnings, client errors, and uncorrelated notifications | Not admitted | No proven obligation contract | Remain in Review history/context |

Product recommendations are admitted once per current occurrence: POST uses the
configured local calendar day, while creative feedback uses one row per
reviewable commission run. The product source returns every pending run before
the queue's bounded read, and a full bound is reported as truncation rather
than an inbox-zero claim. Product read failures are reported as an unavailable
source; legacy metrics and proactive-alert endpoints keep their existing
compatibility projections. Optional Ask promotion is still available from Ask
and its API, but it is not required action admission. Routine task-ready/success
attention generation is not a queue producer; execution history and private
reports remain separate.

## Bell, previews, and delivery

The bell, Actions card, and Actions page share the same per-view queue snapshot.
The bell badge counts only unsnoozed required rows, never unread history or
optional recommendations. Partial source reads show lower-bound counts; failed
refreshes retain explicitly stale rows with Retry, never an inbox-zero claim.
Optional recommendations remain separately visible. Preview links select the
canonical row at `/review/<encoded-id>?view=today`.

Fresh dashboard layouts use one `actions` card. Saved widget IDs and geometry
are unchanged: `review-hub` wraps the queue, `daily-actions` filters product
recommendations, and `proactive-alerts` filters health, backup, and product rows.

Notification read/clear APIs affect event history only. Clearing a proven
notification-backed obligation hides its history record without deleting the
source marker; domain completion removes it through `removeByMetadata`.
Uncorrelated legacy records remain ordinary history with their existing clear
behavior. Producers attach canonical `metadata.actionId` only when the adapter
proves the source reference; title matching is never correlation.

Delivery claims live in the existing machine-local triage store, under a
`delivery:<canonical-id>` key plus occurrence, independent of text revision.
One marker stores a severity high-water mark, generation, and last delivered
generation per channel (toast, Telegram, scheduled reminder). Escalation
advances the generation without creating another action. Read, clear, snooze,
dismiss, reload, and additional tabs never reset that marker. An unavailable
queue/store cannot grant a delivery claim.

`POST /api/review/queue/delivery` accepts only the canonical ID. The server
re-reads the current unsnoozed queue, checks POST reminder opt-in and a matching
scheduled occurrence, then durably claims the toast. Daily recommendations do
not interrupt by default. Existing scheduling, feature, forwarding-type,
autonomy, and daily-budget gates still apply. Both Telegram transports share
the canonical claim; uncorrelated legacy forwards retain their old behavior.
Claims precede delivery: a lost response or failed transport can suppress a
nudge, but retrying cannot duplicate an interruption for that generation.

Completion and triage emit payload-free `review:queue:changed` invalidations,
alongside existing domain events. All subscribed surfaces refetch locally and
discard stale in-flight responses. POST completion, creative feedback, and CoS
approval therefore update other tabs without federating source payloads.
