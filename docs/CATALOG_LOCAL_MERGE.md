# Local catalog consolidation

The catalog detail page offers **Local consolidation** for two explicitly selected,
same-type ingredients owned by this instance. Both records must already be
unlocked. A matching name is not evidence of identity; the operator selects the
source and confirms the reviewed result. The page being viewed is the survivor.

Consolidation unions lists and asks for a choice for every unequal populated
scalar, including fields inside array objects with the same stable ID. It keeps
both names discoverable, preserves images and attachments, and retains the complete
original histories and provenance in a local receipt. A second portrait becomes a
reference so it remains visible without replacing the survivor's portrait.

The source stays unchanged and live for peers. On this instance its stable ID
resolves to the survivor, and local list/search/facet results show one identity.
Exports preserve both original identities and their media. This is **not a
federated deletion or a cross-owner merge**. Consolidating a foreign-owned record
requires an owner-coordinated operation; this API refuses it.

Embedded project/canon copies are preserved as contextual records. A retained
source-ID canon snapshot cannot overwrite the consolidated catalog payload.
A subsequent explicit catalog edit can refresh matching embedded canon through
the existing projection path. Sheet rendering uses consolidated catalog data
rather than delegating to an older embedded variant. Existing image jobs attaching
to the old ID resolve to the survivor.

## API workflow

All paths are relative to `/api/catalog` and use the existing authenticated API.
No endpoint unlocks a record or performs generation.

1. `POST /ingredients/merge` with `sourceId`, `survivorId` and `dryRun: true`
   returns `proposed`, `conflicts`, `counts`, and `previewToken`. Each conflict
   names a JSON-pointer `path` and the `source` and `survivor` values.
2. Set `fieldChoices` to a map from those paths to `source` or `survivor` and
   request a fresh preview. For example, `{ "/name": "survivor" }` retains the
   survivor's display name. Do not reuse a token after changing choices.
3. Submit the same IDs and choices with `dryRun: false` and the reviewed
   `previewToken`. Apply checks the full record, media, link, relation and revision
   snapshot inside a database transaction. Any intervening change returns
   `409 CATALOG_MERGE_STALE`; obtain and review a new preview.
4. `GET /ingredients/:id/merge-history` returns paginated receipt summaries (`limit`, `offset`, and
   `nextOffset: null` when exhausted). `GET /ingredient-merges/:receiptId` loads
   one original snapshot on demand. Revision history also includes source revisions with their original
   `ingredientId`, so provenance stays visible and restore is still available.
5. `POST /ingredient-merges/:receiptId/recover` with `{}` restores the original
   identities and associations only if the applied state is still unchanged and
   both records remain locally owned and unlocked. It retains audit history and
   emits tombstones for added reference/media/relation links. It refuses to
   overwrite later edits, jobs, attachments, or locks. There is no force option.

An identity participating in an active consolidation cannot enter another one;
recover first. This prevents redirect chains and cycles. A receipt remains after
recovery. Source rows and active survivors cannot be deleted while a consolidation
is active. Legacy peer updates cannot rewrite the retained source.

## Rollout

This feature requires the server code and its additive boot schema (the local
`catalog_ingredient_merges` receipt table, resolver function and protective
trigger), plus the client build. The schema does not enqueue work or consolidate
records. A normal authorized deployment/restart is required before the endpoints
exist on a running instance. Code merge alone does not deploy it. Each subsequent
catalog consolidation is a separate explicit operator action.
