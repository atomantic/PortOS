# ADR: The Eidoverse foundation promote envelope may cross registered peers

- **Date:** 2026-09-18
- **Status:** Accepted
- **Related:** [machine-local privacy records](./2026-08-08-privacy-records-machine-local.md), [Eidoverse guest chat](./2026-09-05-eidoverse-guest-chat.md), [Eidoverse](../features/eidoverse.md), #7455, epic #7453, provenance edges #7461

## Context

#7455 shipped a receiver-pull transport at `GET /api/peer-sync/eidoverse-foundations`:
a full-sync peer pulls the promote candidates this install has promoted to its
shared `baseline` layer and inherits the ones that pass the accept-side gate.
Four places in the code — `server/lib/schemaVersions.js`,
`server/routes/peerSync.js`, `server/lib/eidoverseFoundations.js`, and
`server/services/eidoverseFoundationLedger.js` — cited "the machine-local
privacy ADR" as the authorization for this crossing. That ADR
(`2026-08-08-privacy-records-machine-local.md`) never mentions foundations; its
own "Scope of the rule this ADR states" section names exactly one carve-out
(federated visual prompts), and root `AGENTS.md` names three, none of them
this one. The transport shipped correct and carefully gated, but the decision
to let it cross was never recorded — this ADR is that record, written after
the fact from the gate the code already enforces.

## Decision

**An explicitly promoted Eidoverse foundation's promote envelope may cross to
an enabled, registered, outbound-enabled peer.** This is a fourth carve-out
alongside submitted image/video job bodies, lyrics/conditioning images, and
Eidoverse guest chat — each independently gated, none implying the others.

### What crosses

Only the promote envelope built by `packageFoundationCandidate()`
(`server/lib/eidoverseFoundations.js`) and validated against
`eidoverseFoundationCandidateSchema`:

- `kind`, `title`, `summary`, `contributionId`, `body`, `disclosure` — the
  promotable substance, capped and schema-validated.
- `candidateVersion`, `foundationId`, `fingerprint` — the content-addressed
  wire identity.
- `provenance` — an **opaque PortOS federation instance id**
  (`originInstanceId`, never a hostname or tailnet name), a coarse
  `authorKind` (`mind` | `cos` | `user`, never a display name), `createdAt`,
  `packagedAt`, `portosVersion`.
- `assay` — the agent-free resilience-assay verdict this envelope's body
  passed before it could be packaged.

An envelope crosses only when the foundation is BOTH promoted to `baseline`
**and** locally authored: `verifyFoundationCandidate()` runs the full gate —
envelope schema, fingerprint match, assay-evidence check, and
`federationSafetyFindings()` — on both the sending and the receiving side, and
a self-referential pull (an install re-offered its own inherited copy back to
its origin) is refused.

### What never crosses

- **`style`** — palette, motif, asset paths, placement, district, display
  aliases. `packageFoundationCandidate()` drops it outright at construction;
  `eidoverseFoundationCandidateSchema` has no field for it. A style-shaped key
  found inside `body` refuses the package rather than being silently stripped.
- **The local ledger** — the full `eidoverseFoundationRecordSchema` record,
  including `layer`, `promotedAt`, `inheritance`, and the stored `candidate`
  verbatim copy, stays in `data/eidoverseFoundations.json` and is never served.
- **Assay prose beyond the verdict shape** — only the fixed
  `foundationAssayEvidenceSchema` fields travel (`harness`, `contributionId`,
  `pass`, `disturbances`, `ranAt`, bounded `reasons`); no free-form assay
  transcript or resilience-harness log.
- **Disclosure notes beyond the envelope's own caps** — `disclosure` travels
  as declared on `foundationDisclosureSchema`, not as an open-ended text field.
- **Any record-bearing status/capability payload.** As with every other
  federation carve-out, this authorizes exactly the promote envelope in the
  pull response body — never a peer/status/capability response naming a
  foundation, its author, or its ledger state.
- **Machine identity, PII, or credential-shaped values.** `federationSafetyFindings()`
  walks the canonicalized envelope (minus its own fingerprint) and **refuses**
  the package outright — it does not redact — naming the offending JSON path.
  A redacted promote would leave the author believing they published what
  they wrote, so packaging fails closed instead.

### The gate

1. **Promotion is explicit.** `vernacular` (local-only) is the default layer
   for everything authored on an install; only `promoteEidoverseFoundation()`
   moves a foundation to `baseline`, and every promote re-runs ownership,
   the agent-free resilience assay, the style-leak scan, federation safety,
   and the content-addressed fingerprint from scratch — nothing rests on a
   stale stored verdict.
2. **`verifyFoundationCandidate()` runs on both ends** — envelope schema,
   fingerprint-matches-body, assay-evidence-still-valid, and
   `federationSafetyFindings()` — before a sender offers a candidate and
   again before a receiver stores an inherited copy.
3. **`federationSafetyFindings()` refuses rather than redacts.** Any finding
   fails the whole package; nothing partial ships.
4. **Registered, outbound-enabled peers only, and always enforced.** The route
   authorizes with `alwaysEnforce: true` rather than the warn-first
   authorization ramp older pull routes use — there is no existing sync
   history to protect on a brand-new endpoint, so only a peer this install has
   explicitly registered and enabled outbound sync for is ever served an
   offering.

### Direction and version contract

- **Pull-only.** A full-sync peer fetches `GET /api/peer-sync/eidoverse-foundations`;
  nothing pushes a foundation unsolicited.
- **`EIDOVERSE_FOUNDATION_CANDIDATE_VERSION`** (`server/lib/eidoverseFoundations.js`)
  pins the envelope's own shape, independent of the transport's schema
  category.
- **`PORTOS_SCHEMA_VERSIONS.eidoverseFoundations`** (`server/lib/schemaVersions.js`)
  gates the transport. It rides `NON_RECORD_SCHEMA_CATEGORIES` like
  `mediaLibrary`/`cosHistory`/`cosTasks` (receiver-pull, no push to gate), and
  a receiver **gently skips** a sender ahead of its own version rather than
  409-ing, because the envelope's vocabulary is still being extended — a v1
  receiver applying a v2 envelope would store a foundation it cannot interpret
  with no re-fetch path to later correct it.

## Compatibility

An install with the Eidoverse feature disabled offers and accepts nothing —
`buildEidoverseFoundationOffering()` returns an empty candidate list rather
than erroring. An older peer that predates this transport entirely simply
never calls the route; there is no negative interaction to guard.

## Revisiting

If a future slice widens the envelope (a richer provenance graph, #7461's
edges, author display names, or a freeform note field), it needs its own gate
change AND its own bump to `EIDOVERSE_FOUNDATION_CANDIDATE_VERSION` — this
ADR authorizes the fields enumerated above, not "whatever the envelope grows
into." A guard test
(`server/services/sharing/eidoverseFoundationsNeverFederatesStyle.test.js`)
fails loudly if `style`, the local ledger's local-only keys, or unbounded
assay/disclosure prose ever reaches a built offering.
