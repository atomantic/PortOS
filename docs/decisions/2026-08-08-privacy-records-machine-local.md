# ADR: Privacy Center Records Are Currently Machine-Local

- **Date:** 2026-08-08
- **Status:** Amended 2026-09-19 by [user-controlled federation](./2026-09-19-user-controlled-federation.md). The current storage implementation remains local-only; the blanket prohibition on personal-data federation is superseded.
- **Related:** issue #2148 (closes the federation half; household subjects split
  out), epic #2138,
  [design record](../plans/2026-07-04-privacy-center-pii-vault-broker-optout.md),
  [`server/lib/vaultCrypto.js`](../../server/lib/vaultCrypto.js),
  [`server/services/sharing/peerSync.js`](../../server/services/sharing/peerSync.js),
  [`docs/STORAGE.md`](../STORAGE.md),
  ADR [tribe + universe-runs local](./2026-06-26-tribe-and-universe-runs-local.md) (#1724),
  ADR [federated visual prompts](./2026-08-20-federated-visual-prompts.md) (#4682).

## Context

The Privacy Center (epic #2138) shipped Phases 1–8: an AES-256-GCM encrypted PII
vault, a trusted-organization registry with per-field holdings, a
change-of-address inventory, and an unbroker-style data-broker opt-out engine.
All nine tables (`privacy_subjects`, `privacy_vault_records`, `privacy_consents`, `privacy_orgs`,
`privacy_org_holdings`, `privacy_change_events`, `privacy_brokers`,
`privacy_broker_cases`) are `db-primary` PostgreSQL and machine-local.

Federation was deliberately excluded from v1 and parked in #2148, whose proposal
was: copy the same `PRIVACY_VAULT_KEY` to every peer, sync
`privacy_vault_records` with the ciphertext travelling as-is, and sync orgs +
holdings as **plain** records. This ADR resolves that parked question.

## What federating them would actually mean today

Three properties of the current federation layer make the parked proposal unsafe
as written:

1. **The pull path carries no peer identity.**
   `GET /api/peer-sync/record?kind=&id=` calls `getRecordPayloadForPeer(kind, id)`
   with no notion of *who* is asking. The `peerAllowsOutbound` / `peerHasCategory`
   checks gate only the **push** direction
   (`server/services/sharing/peerSyncPush.js`). Adding a privacy kind to
   `PEER_SUBSCRIBABLE_KINDS` would therefore not create a *subscription* — it
   would create a read anyone who can reach the port can perform. When the
   optional instance password is off (the default posture), that is every host
   on the tailnet.

2. **The record-sharing registry examined for this decision covered creative work.** This is not an inventory of all federation channels: Brain also syncs personal records. At the time, `PEER_SUBSCRIBABLE_KINDS` was
   `universe, series, mediaCollection, author, artist, album, track,
   creativeDirectorProject, moodBoard, writersRoomWork, writersRoomFolder,
   writersRoomExercise, musicVideoProject, commissionFeedback,
   creativeCommission` — zero PII, zero credentials. The transport's trust
   posture (`peerHttpClient.js` sets `rejectUnauthorized: false`, commented
   "Tailnet is the trust boundary") was chosen for that data class. Between two
   tailnet nodes WireGuard already provides mutual authentication and
   confidentiality, so the un-validated TLS layer is redundant rather than
   dangerous — but `peerRequiresTailscale()` (`server/services/instances.js`)
   shows a peer may equally be a plain LAN IP or a non-tailnet DNS host, where
   nothing authenticates the far end.

3. **Ciphertext-only sync still leaks a PII fingerprint.** `masked_value` is a
   precomputed **plaintext** column by design (`•••, Portland, OR`,
   `j•••@example.com`, `••••1234`). A "ciphertext travels as-is" sync ships the
   whole mask set. Separately, `privacy_orgs` is the user's banks, employers,
   medical providers and insurers, and `privacy_broker_cases.evidence`
   holds `listing_urls` — the map of where the user is exposed. The parked
   proposal would have synced those as plain records.

A shared `PRIVACY_VAULT_KEY` also converts the at-rest guarantee from "one
machine's `.env`" to "N machines' `.env` files," which is precisely the blast
radius the encryption layer exists to bound.

## Decision

**Privacy Center records currently remain machine-local.** The following
implementation boundaries remain in place; they do not prohibit a future
user-requested sync design between machines the user owns/controls:

- No privacy kind is added to `PEER_SUBSCRIBABLE_KINDS`.
- No privacy category is added to `dataSync`'s `CATEGORIES`.
- No privacy table gains a `sync_sequence` cursor or `deleted`/`deleted_at`
  tombstone. Deletes stay hard deletes.
- No privacy category is added to `PORTOS_SCHEMA_VERSIONS` — there is no wire
  contract to version, because there is no wire.

A guard test (`server/services/sharing/privacyNeverFederates.test.js`) enforces
the first two so the boundary fails loudly rather than eroding.

### Scope after the 2026-09-19 clarification

The [user-controlled federation ADR](./2026-09-19-user-controlled-federation.md)
supersedes the interpretation that all personal or private data must remain on
one machine. This decision documents the Privacy Center's current local-only
implementation, not a universal restriction on the user's own network.
Brain's established sync of personal records, including threads derived from
private trackers, is permitted.

Other stores also currently have explicit local-only implementations:

| Path | What it holds | Guard |
|---|---|---|
| `privacy_*` tables | the PII vault, orgs, holdings, broker cases | `privacyNeverFederates.test.js` |
| `beeper_*` tables | mirrored conversation bodies and attachment metadata | `beeperNeverFederates.test.js` |
| `ai_connections` / `ai_*_bindings` | this machine's endpoints and credential material | `providerGraphNeverFederates.test.js` |
| `data/jev/` (#7689) | trained project heads, training corpora, cached encoder outputs | `jevNeverFederates.test.js` |

Those guards describe current support and remain unchanged. In particular,
`data/jev/` can contain private repository history; model weights are not an
anonymization step. That matters when choosing an audience, but it is not a
reason to reject a future explicit sync design for the user's own machines.
Credentials remain machine-local, and adding support to any of these stores
requires a scoped implementation rather than simply deleting its guard.

### Historical rationale: HTTPS + the instance password

This section records the original tradeoff, not additional prerequisites on
user-controlled federation after the 2026-09-19 clarification.

This was seriously considered, and the machinery for it already exists: the
optional instance password (`server/services/auth.js` + `server/services/authGate.js`)
gates all of `/api/*` including `/api/peer-sync/*`; per-peer Basic credentials
are stored on the peer record and attached to every outbound hop by
`peerFetch` (`server/lib/peerHttpClient.js`); and `GET /api/auth/status` is
always-public, so a peer probe can *detect* whether the far end requires auth
and refuse to send otherwise.

It was rejected for the vault because the cost/benefit is poor, not because it
is unimplementable:

- **The benefit is thin.** Durability is already covered — the DB is in the
  backup, and `PRIVACY_VAULT_KEY` lives in `.env`. The opt-out ledger is
  single-writer by design (#2148 flagged this itself); replicating it invites
  two peers to double-submit opt-outs against the same broker, which is worse
  than not syncing. The genuine multi-machine want — "see my vault on the
  laptop" — is satisfied by restoring a backup and copying one key, a
  deliberate, auditable, one-time act.
- **The cost is a permanent widening of the highest-value target in the
  install.** The instance password is a single credential granting the *entire*
  API (shell, agents, providers), not a scoped capability. Making an SSN vault
  reachable over any network path, behind any single shared secret, trades a
  hard guarantee ("this data has never left this machine") for a soft one
  ("this data is protected as well as our weakest peer's password"). For PII
  specifically, the hard guarantee is worth more than the convenience.
- **Precedent.** `tribe_people` — a personal relationship/CRM graph — is already
  intentionally machine-local (ADR #1724), mirroring `memorySync.js`'s
  "relationship data is instance-local" boundary. An identity vault holding
  SSN, passport, driver's licence and financial-account numbers is a strictly
  stronger case than the one already decided.

The transport-hardening idea is worth keeping on its own merits, independent of
privacy data: adding per-peer identity + category authorization to the pull path
benefits **every** federated kind. That is tracked separately (see Consequences)
and is explicitly *not* a precondition for revisiting this decision — it is a
fix for the creative-data federation that already exists.

## Consequences of the original implementation

- The Privacy Center is single-machine. The UI and docs should state this as a
  current sync limitation; this is not a claim that user-directed backups or
  other explicit transfers can never carry those contents.
- A user wanting the vault on a second machine restores from backup and copies
  `PRIVACY_VAULT_KEY` by hand. This is documented, not automated — a manual key
  copy is deliberate. User-configured continuous replication can also express
  consent; it is simply not implemented for this store.
- Household subjects (the other half of #2148) is unaffected: it is a
  same-machine, multi-subject feature with no federation dependency, and is
  split into **#3658**.
- Per-peer authorization on the peer-sync pull path is filed separately as
  **#3659** — a general federation fix benefiting every federated kind, not a
  privacy prerequisite. It is version-gated so an older peer that does not
  present identity degrades gracefully rather than losing sync.
- `AGENTS.md`'s Security Model previously stated that PortOS "intentionally
  omits authentication … HTTPS." Both exist as opt-in, off-by-default features,
  and the stale wording actively misleads anyone reasoning about what a peer
  channel can guarantee. Corrected as part of this change.

## Revisiting

A future Privacy Center sync design should address its actual storage and
workflow constraints: encryption-key ownership, masks and plaintext projections,
record identity and deletion, compatibility, and avoiding duplicate broker
submissions. The user's explicit selection of their own machines can authorize
continuous replication. The [2026-09-19 decision](./2026-09-19-user-controlled-federation.md)
removes the earlier blanket veto and its requirement to prove a backup could
not serve the user's need; it does not change any runtime guard or transport.
