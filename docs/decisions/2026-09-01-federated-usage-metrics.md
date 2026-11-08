# ADR: AI Usage Metrics Federate, On By Default

- **Date:** 2026-09-01
- **Status:** Accepted
- **Related:**
  [`server/services/peerUsage.js`](../../server/services/peerUsage.js),
  [`server/services/usage.js`](../../server/services/usage.js) (`buildUsageDigest`),
  [`server/services/dataSync.js`](../../server/services/dataSync.js) (`usage` category),
  ADR [privacy records machine-local](./2026-08-08-privacy-records-machine-local.md),
  ADR [federated visual prompts](./2026-08-20-federated-visual-prompts.md).

## Context

A single user commonly runs several PortOS installs federated as sync peers — a
desktop, a laptop, a headless render box. Every one of them records its own AI
usage into `data/usage.json`: sessions, messages, per-provider and per-model
token counts, prompt-cache tiers, and the estimated API cost the Usage page
reports.

Those counters were machine-local, so the Usage page answered "what did *this
box* spend?" — which is never the question. The question is what the **fleet**
spent, and answering it meant opening the page on each machine and adding the
numbers up by hand. Worse, the headless box that runs the most unattended
work is the one a user is least likely to open.

Two things made this non-trivial rather than "add a category and move on":

1. **Usage counters are cumulative aggregates.** Merging a peer's totals into
   the local file would double-count on the very next round trip — our own
   outbound snapshot would ship the inflated total straight back — and would
   corrupt this machine's own history irreversibly.
2. **Every sync category ships off by default.** Usage is only useful if it is
   already flowing when the user asks the question; a fleet total that requires
   per-peer opt-in on every machine is a feature nobody has turned on.

## Decision

**AI usage metrics federate as a snapshot sync category named `usage`, and it
is the one category that is ON by default.**

### Per-instance digests, never a merge

Each install publishes a *digest* of its own usage (`buildUsageDigest`) and
stores every peer's digest side by side in `data/peer-usage.json`, keyed by
origin instanceId. Nothing is ever summed into `data/usage.json`.

- Digests are replaced whole under an LWW stamp (`capturedAt`, sourced from
  `usage.json`'s `lastUpdated`), so re-applying a snapshot is a no-op.
- A node forwards the third-party digests it holds, so a chain (A↔B↔C)
  converges without A and C ever talking.
- A peer echoing a stale copy of *us* is ignored outright — this machine is the
  only authority on its own counters.
- Day buckets older than `DIGEST_DAILY_RETENTION_DAYS` (120) are folded into
  their month **for the wire only**. All-time totals stay exact; only old
  periods lose per-day granularity, which is all a fleet report needs.
- `reconciledRuns` never rides the wire: it is idempotency bookkeeping keyed by
  *local* run ids, meaningless on a peer and the largest field in the file.

### Default ON, and what "on by default" does not mean

`DEFAULT_SYNC_CATEGORIES.usage` is `true`, and `DEFAULT_ON_SYNC_CATEGORIES`
names the default-on set so the rest of the system can reason about it:

- `resolveEffectiveCategories` layers a peer's stored map **over** the defaults,
  so a peer record written before this category existed picks up the shipped
  default instead of reading as `undefined` (= off) forever. No migration needed.
  It is the single resolver, used by both the sync loop and the client-facing
  peer payload — two would drift, and the UI would show something the loop
  doesn't do.
- **A default reaches only a peer the user established here.** `handleAnnounce`
  auto-creates an inbound-only peer record for any host that can reach the port,
  with no approval step and (by default) no auth, so a default-ON category that
  applied there would mean announcing is enough to get a stranger's numbers
  pulled into this install's fleet report. `directions` is the discriminator, the
  same signal `peerAllowsOutbound` reads. An explicit stored `true` still wins:
  ticking the box for an inbound peer is a decision, not a default.
- The peer-level `syncEnabled` master switch predates default-on categories and
  means *"don't replicate my content to this peer"*. It therefore masks a peer
  down to the default-on set rather than silencing it entirely.
- `syncEnabled` is **derived** from the category map and also gates per-record
  outbound pushes (`peerAllowsOutbound`). A default-on category must never flip
  it on by itself, or adding one would silently widen what every existing peer
  is allowed to receive. `hasOptedInCategory` excludes the default-on set from
  that derivation, and `updatePeer` recomputes it on any category edit rather
  than honoring a caller-supplied value.
- The **settings UI** reads the configured map, not the masked one
  (`masterSwitch: false`) — masking there would render every box on a
  `syncEnabled: false` peer unchecked, and ticking one would silently reactivate
  every other category still true underneath it.
- The switches that still stop everything: turning the **category** off for a
  peer, or disabling the **peer** (`enabled: false`).

## The usage projection boundary

The [user-controlled federation ADR](./2026-09-19-user-controlled-federation.md)
permits personal records on their established sync channels. This usage channel
keeps a narrower aggregate projection because its purpose is fleet accounting.
It carries:

- provider ids and model ids (`anthropic`, `claude-opus-5`)
- session / message / token / cache counts and their day+month buckets
- the publishing instance's id and name — both of which peers already exchange
  during registration (`handleAnnounce`)
- provider accounting classifications, quota readings and daily hourly counts
- up to 200 observed limit-block provider/model ids and timestamps per origin;
  error messages and reset-hint prose are excluded
- a bounded projection of saved Codex image receipts: hashed output and session
  identities, timestamp, identity type, and the reported driver-token total.
  These pseudonymous hashes are linkable across instances and let the fleet
  deduplicate mirrored outputs; they are not anonymous aggregate counters.
  Each origin sends at most 10,000 receipts and reports truncation as partial.
  They travel only under the user-controlled `usage` sync category and remain
  in the peer usage snapshot until replaced or its origin is retired.
- An explicit, separate native-report read may exchange v4 accounting
  projections with an enabled, user-established, paired usage peer. It carries
  domain-separated hashes of native message/request/session-turn/response
  identities, measured counters, timestamps, numeric provider/model enums,
  conflict/finality flags and bounded source coverage. These are linkable
  pseudonymous accounting records, not anonymous aggregates. They are needed
  to deduplicate copied native files across the same selected account. Superseded
  for the Usage view: see the addendum on machine rollups below.
  The challenge-signed report is source/audience bound, at most 1 GiB, and
  accepted for five minutes (30 seconds of future clock allowance). It is
  never saved in the usage digest, forwarded, or exposed to the browser. The
  requester keeps the last verified report in its machine-local store (#15255)
  and shows it, labeled stale, only while that peer remains eligible.
  The browser receives only aggregate coverage and selected-account results.
  Usage category/direction controls remain in force, even with authentication
  otherwise disabled; unpaired legacy peers cannot use this new protocol.

It carries no prompts, no transcripts, no record contents, no file paths, and
nothing about the human. The rejected alternative — federating the raw
`usage.json` — would have shipped `reconciledRuns`, a list of local run ids;
still not PII, but machine-local bookkeeping with no meaning on a peer, so it is
excluded on both privacy and payload grounds.

## Consequences

- The Usage page gains an **Across Instances** section: one row per instance,
  priced over the same window by the same `buildUsageReport` the single-instance
  report uses, so per-instance and fleet figures can never disagree. It renders
  only once a peer digest has synced — a single-machine install sees no change.
- `data/peer-usage.json` is entirely derived, replicated state. A corrupt read
  self-heals on the next sync cycle rather than throwing on every poll, and the
  store is capped at 64 instances (oldest `capturedAt` evicted) so a peer
  forwarding a long tail of dead instance ids can't grow it without bound.
- Peer rows are as fresh as the last 60s sync cycle, so each row states when its
  digest was captured rather than implying it is live.
- `usage` is the first snapshot category that is **always dirty** — `saveUsage`
  rewrites `usage.json` on every AI run — where every other category rests on a
  rarely-moving checksum. The payload is bounded (120-day wire rollup, all-time
  `byProvider`/`byModel` dropped, no per-provider rows on fleet output), and
  since **#5759** the transfer is per-slot rather than whole-map: the category
  serves a **manifest** at `/api/sync/usage/manifest` — `{ instances: {
  <instanceId>: capturedAt }, tombstones }` — and that manifest, not the
  payload, is what the category's checksum hashes. A puller diffs the remote
  manifest against what it already holds and fetches only the advanced slots
  via `/api/sync/usage/snapshot?slots=…`, so one machine burning tokens moves
  one digest instead of N. Both legs degrade: a source peer too old to serve a
  manifest 404s it and the puller falls back to the whole snapshot, and a
  snapshot request with no `slots` serves everything — receivers merge per slot
  under LWW either way, so a full payload is always applied idempotently. See
  `server/lib/syncManifest.js` for the wire contract.
- **The per-peer toggle governs the INBOUND direction.** Snapshot sync is
  pull-only, and `/api/sync/:category/snapshot` carries no per-peer category
  authorization for *any* category — the receiver-side gap that per-record pulls
  closed in #3659 and snapshots have not. Turning **AI Usage Metrics** off for a
  peer stops us pulling and storing that peer's digest; it does not stop that
  peer pulling ours, and our snapshot also forwards the third-party digests we
  hold. That asymmetry was latent while every category defaulted off — a
  default-ON category is what makes it reachable — so the honest statement is
  that a usage digest is readable by anything that can already reach the API,
  under the same posture as every other snapshot category (see the Security
  Model's trust boundary in `AGENTS.md`). Closing it properly means authorizing
  the snapshot pull path per peer and per category — the general fix already
  filed as #3659, not a usage-specific one.
- A user who wants a machine's spend out of the federation entirely disables the
  peer (`enabled: false`), which stops every direction — checked in
  `hasAnySyncEnabled`, so it holds on the `peer:online` path too, not only in
  the polling loop.
- An instance that pays API rates rather than the viewer's subscriptions can be
  dropped from the Across Instances **combined total** via a per-row
  Subscriptions toggle. The row stays listed (the spend is still real). The
  choice is machine-local (`settings.usageApiBilledInstanceIds`) — it is this
  install's view of which fleet members ride the plans, not a property of the
  instance itself — and never rides the digest. Setting it on one machine does
  not change the total another machine shows.
- **Removing a peer retires its digest via a tombstone**, not a plain delete.
  Our snapshot forwards every digest we hold, so a surviving peer would hand a
  deleted row straight back on the next cycle and a decommissioned machine's
  spend would sit in the fleet total forever. The tombstone rides the same
  snapshot (`server/lib/tombstones.js`, keyed on `instanceId`) so the removal
  propagates; a digest captured *after* it supersedes it, so re-adding the
  machine later works.
- A peer's digest is **rebuilt to the known wire shape on arrival**, not stored
  as it came. The shape is fixed and shallow (day → provider → model), and this
  category's checksum uses `canonicalStringify` — a recursive JS function with a
  far smaller depth budget than native `JSON.stringify` — so a digest deep
  enough to pass `atomicWrite` but blow that recursion would otherwise 500 the
  snapshot endpoint for every peer, permanently and across restarts.

## Amendment (2026-09-03): subscription-quota readings ride the same category

A subscription is **one account across every federated instance**, but each
install can only read the quota panel of its own local CLI. So every
subscription card on the Usage page was a partial view of a shared allowance,
captioned with the CLI's own wording — "Local sessions only — does not include
other devices or claude.ai." That caption was accurate and useless: the
federation already carries this user's other devices.

**Each instance's last quota reading now rides the `usage` category alongside
its usage digest**, and the cards are unified before they render
([`server/lib/fleetQuotas.js`](../../server/lib/fleetQuotas.js)).

- **Two merge rules, because the halves mean different things.** `limits` (the
  meters) are account-wide — every machine reads the same server-side allowance,
  just at a different moment — so the FRESHEST reading per limit key wins;
  summing them would multiply one allowance by the number of machines that
  looked at it. `activity` (requests/sessions) is per-machine, which is exactly
  what the provider's caption is about, so those SUM. `metrics[]` is left local:
  its values are prose (`"3 renders · 24h"`), not addends.
- **A card this machine could not read is filled from a peer that could** — a
  logged-out CLI or a scrape still in flight stops reporting a failure once
  another instance has read the same account.
- **Only families this install has enabled get a card.** A peer running a
  provider we don't is that machine's business; a meter for a plan the viewer
  can't spend would be noise.
- **API-billed instances are excluded.** The existing per-row Subscriptions
  toggle already marks fleet members that pay API rates rather than riding the
  viewer's plans; those meter a different account, so folding their readings in
  would be a wrong number rather than a fuller one.
- **A single-machine install is unchanged, caption included.** With nothing to
  combine, claiming otherwise would be worse than the wording this replaces —
  so the local note says only that no other instance has reported yet.

Mechanically, the readings live in an in-memory stale-while-revalidate cache
(a reading costs a 10-20s CLI/TUI spawn), which cannot be federated: it dies
with the process, and this category's checksum is invalidated by FILE
fingerprints. So `services/providerQuotaShare.js` persists them to
`data/provider-quotas.json` — added to `USAGE_CHECKSUM_PATHS`, and folded into
the entry's `capturedAt` so a quota refresh with no new AI runs still advances
the slot a peer pulls. The write is skipped when a card's *claim* is unchanged
(comparing whole cards would rewrite the file on every page poll, since some
adapters stamp the clock on read).

Nothing here reads a provider: the AI Provider Usage Policy still holds, because
this only records and forwards what a user-triggered reading already produced.
Privacy is unchanged in kind — a quota card carries provider ids, percentages,
reset times and the publishing instance's name; no prompts, no transcripts, no
PII. The peer payload is rebuilt to the wire shape on arrival for the same
recursion-depth reason the usage digest is.

## Addendum: the cutover barrier is retired (#15279)

The usage cutover barrier (#15098) was a machine-local gate at the write and apply
boundaries for a planned ledger migration. #15271 overlays native history at read time
instead, so the ledger is never migrated and the barrier was removed unused. The usage
wire is the plain `{ instances, tombstones }` map. A payload that still carries a
`cutover` stamp comes from an older peer holding a fence or epoch, and is skipped whole.

## Addendum: native usage reports send machine rollups (#15252)

Paired peers are the owner's own trusted machines, so a read should reach all of
their retained usage and should only need to carry aggregates. Reconciling every
record across machines is retired for the Usage view.

- **What travels.** `/api/usage/native-report/v2` carries a version-5 report: the
  same coverage evidence as version 4, with per-day, per-model rollups in place of
  record lists. Each machine resolves its own partial, final and copied entries
  before rolling up. Rollup size follows days times models rather than records.
- **How machines combine.** The Usage view adds each machine's own total. Codex's
  account read stays once per account, and an operator selection still names its
  authority. For retained files, a selection only groups machines into a labelled
  sum. A missing report is named and is never zero.
- **What summing accepts.** No vendor documentation read for #15230 describes syncing
  these files between machines, so a transcript reaches a second machine only through
  a manual step such as a restored backup or a migrated home directory, and only those
  count twice. Overlap between real machines was not measured. Claude cloud sessions
  count against the plan but are not in a machine's transcripts unless teleported, so
  these totals can miss them. The Usage page says both.
- **What a read covers.** An explicit read uses the capture budgets for bytes, lines,
  entries and records, under one 45-second deadline shared by all providers. That fits
  inside the 60-second peer request deadline. A 1 GiB transfer bound remains as memory
  safety, not as a data limit.
- **Upgrade skew.** `/api/usage/native-report/v1` keeps answering version-4 record
  lists, and a collector asks for `v1` when `v2` answers 404 or 403. A version-4
  report keeps showing its totals, with model attribution
  `report-without-model-capability`.
- **Still explicit.** Nothing polls, runs at boot or calls a provider's model. Record
  lists remain in the standalone capture for the staged recovery (#15031), which
  keeps its own deduplicating matrix.

## Addendum: Claude Code transcript token history (per model, per day)

The `usage` category also carries an optional `claudeCode` field per instance: a
`{ updatedAt, days: { <YYYY-MM-DD>: { <model>: { messages, input, output,
cacheRead, cacheWrite } } } }` map derived from the Claude Code CLI's local
transcripts, so it covers sessions run outside PortOS. It exists so the Usage
page can total tokens per model across the fleet and price them at API rates
(`server/services/claudeCodeTranscriptUsage.js`, `getFleetClaudeCodeModels` in
`peerUsage.js`).

- **Additive and optional**, like `quotas`: an older peer drops the field and
  contributes nothing to that report; no schema-version bump.
- **Privacy:** model ids, UTC day buckets and token counts only — never prompts,
  project paths, session ids or transcript text. Peer-supplied maps are rebuilt to
  this fixed shape (day/model caps) before storage.
- **Persisted locally** in `data/claude-code-transcript-usage.json` (per-field max
  merge), so history survives the CLI pruning old transcripts. It is a derived
  local cache: it ships no `data.reference/` seed and needs no migration — it is
  rebuilt from the transcripts still on disk.
- **Freshness:** refreshed lazily when the report is read and by a 30-minute
  local file scan that starts after boot. No provider calls are made.
- `capturedAt` is the newest of usage / quotas / transcript `updatedAt`, so a
  transcript refresh alone still advances the slot peers pull.

## Addendum: native usage reports retired (#15272)

The native report exchange above is retired. Each machine's Usage report now
reads its own app histories into per-app daily stores (#15271), and paired peers
receive those counts inside the existing usage digest. `/api/usage/native-report/v1`
and `/v2`, the collection store and the native matrix are removed; an older peer
that still asks for them gets `403 PEER_SCOPE_FORBIDDEN` and shows that report as
missing.
