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
