# ADR: Legacy Export "Key Decisions" — Derive, Don't Add a First-Class Entity

- **Date:** 2026-06-19
- **Status:** Accepted
- **Related:** issue #901 (Legacy Export, open question #1), issue #1433
  (Legacy Export Phase 4), [`server/services/legacyExport.js`](../../server/services/legacyExport.js).

## Context

The Legacy Export bundle (#901) carries a **Key Decisions** section meant to
capture the consequential choices a person made over their life — part of the
"how you think", not just "what you built", that the Knowledge Legacy goal aims
to preserve.

Phase 1 derived that section from **completed goal milestones** only, because
PortOS has no first-class "life decision" record:

- `decisionLog.js` is CoS *task-scheduling* telemetry (which agent ran, why a
  task was picked) — operational, not autobiographical. It is the wrong store.
- A milestone marked `completedAt` is the closest existing signal of "a choice
  that was carried through", so v1 used it and the manifest documented the
  provenance (`source:` on the section descriptor).

Open question #1 from #901 asked whether to keep deriving or introduce a
first-class life-decisions entity (its own store, CRUD, sync category, UI).

## Decision

**Keep deriving — do NOT add a first-class life-decisions entity — but broaden
the derivation beyond completed milestones.**

The Key Decisions section is now derived from three existing signals, deduped
and ordered by date:

1. **Completed goals** — a goal carried to `status: 'completed'` is itself a
   decision that was seen through (Phase 1 only looked one level down, at
   milestones).
2. **Completed goal milestones** — the Phase 1 source, retained.
3. **Decision-bearing brain entries** — `ideas`/`journals`/`projects` records
   whose tags or title mark them as a decision (`decision`, `decided`,
   `choice`, `chose`, `pivot`). This pulls in the deliberate-choice notes a
   user already keeps in the Brain, without a new capture surface.

The section descriptor's `source:` string is updated to state this richer
provenance, so the bundle's manifest stays honest about where the data came
from.

## Rationale

- **YAGNI.** A first-class entity means a new store, sanitizer, Zod schema, sync
  category, migration, and UI — a multi-PR feature — to capture data the user is
  *already* recording as goals and brain notes. The marginal value over deriving
  does not justify a new top-level identity primitive.
- **No migration, no schema churn.** Broadening the derivation reads existing
  records through existing services; it ships in this PR with no on-disk change
  and nothing for other installs/peers to migrate.
- **Honest provenance.** The derived section is explicitly labelled as derived
  (in both the Markdown source-note and the manifest `source:`), so it never
  pretends to be a curated decision journal.
- **Reversible.** If a dedicated decisions entity is ever warranted, it can be
  added later and slotted in as a fourth (preferred) source ahead of the derived
  ones — the section descriptor already isolates the sourcing behind
  `collectDecisions(...)`.

## Consequences

- The Key Decisions section is richer (goals + milestones + tagged brain notes)
  without new storage.
- Users who want a specific choice to appear in their legacy bundle can tag a
  brain note `decision` (or name it accordingly) rather than needing a new UI.
- This ADR closes #901 open question #1. A future first-class entity remains an
  option but is explicitly out of scope.
