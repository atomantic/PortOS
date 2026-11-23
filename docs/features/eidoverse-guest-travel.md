# Eidoverse federated guest travel

Wire contract and promote/inherit semantics for Eidoverse federated guest travel. Part of the [Eidoverse Worlds integration](./eidoverse.md).

## Federated guest travel

The Federation Terminal gives every connected, guest-capable peer a walk-in
visitor chamber. Chambers are infrastructure rather than sampled health signals,
so the live signal cap cannot silently omit a destination. Inspect a chamber
and choose **Teleport as guest**, or use the destination buttons above the world.
With an `objectInteraction: 1` renderer, approach a visible pod within three
metres and press **E**, or tap its action prompt. This works with labels hidden.
The local controls name the destination; the authored chamber uses an opaque
reference rather than writing machine names into the world log. Destination
changes refresh the projection while the page is open and its draft is saved.

Departure checks the saved peer and its current capabilities, admits a fresh
visitor identity, and opens that host's `/eidoverse/guest` page. Before navigation, PortOS
requires the departing renderer's `worldDeparture: 1` acknowledgement
when supported: presence and reconnect attempts stop, then the socket closes.
PortOS waits for a blank replacement frame before navigating in the same tab;
older renderers use that frame teardown as their compatibility path. Returning
through browser history restores the home frame. This moves the human visitor;
the install's resident CoS presence continues to belong to its home world.
The guest shell
loads its renderer without owner controls or private PortOS bootstrap requests,
including when the destination uses the optional instance password. An existing
Eidoverse browser login cannot replace the guest identity. **Leave world** returns
to the previous page. Admission links expire after 30 minutes.

Opening the guest page also sets a scoped, HttpOnly `portos_eidoverse_guest`
cookie holding the same ticket, because the renderer's asset and WebSocket
requests cannot carry the ticket header. On a password-protected destination it
admits that browser to the Eidoverse proxy only and opens no `/api` or `/data`
route. It stops working, and its open sockets close, when the visit expires or
ends or its originating peer is disabled.

Both ends need updated PortOS, Eidoverse enabled and running, and a renderer that
advertises `guestEntry: 1`; the host needs its resident CoS presence enabled to
admit visitors. Older runtimes remain unavailable for travel until updated.

For the Persistent Mind, enable **Allow guest travel and chat with federated
worlds** in its tool permissions. This is the separate `visitEidoversePeers` grant,
which defaults off and does not follow from local world-management permission.
The corresponding semantic MCP grant is available in API Access settings.

| Tool | Purpose |
| --- | --- |
| `eidoverse.destinations` | Discover connected registered guest worlds. |
| `eidoverse.visit` | Join a destination by its opaque `peerId`; returns a `visitId`. |
| `eidoverse.visit-chat` | Read live replies after a cursor; optional `text` sends one message. |
| `eidoverse.leave` | Disconnect the guest visit. |
| `eidoverse.chat` | Read the resident's live local chat (`readPortos`). |
| `eidoverse.say` | Reply locally as the resident (`manageEidoverse`, unchanged). |

Visits do not move the resident presence or give a visitor construction rights.
Guest chat starts with the visit, is bounded and cursor-based for the Mind, and
never automatically exports stored conversation history or private records.
Incoming chat makes no AI call and is never an instruction or permission grant.
The [guest-conversation ADR](../decisions/2026-09-05-eidoverse-guest-chat.md)
documents this narrowly scoped exception to the machine-local record policy.

**Vernacular labeling on a visit (#7459).** A guest visit reaches only what the
destination install chose to build in its own private world — its local
vernacular style and buildings — never the shared PortOS baseline population,
which has no visit surface of its own. Both entry points say so explicitly
rather than leaving a visitor to infer it: `eidoverse.visit`'s response
`guidance` tells a visiting Mind in the same turn it receives a `visitId`, and
the human guest shell (`client/src/pages/EidoverseGuest.jsx`) carries the same
line in its header. This is a labeling change only — nothing about what
crosses the federation layer changes: the vernacular/baseline ownership model
(below) already keeps a foundation's `style` and its whole local ledger out of
every peer exchange, and a guest visit was never a foundation-ledger read.

### Object controls

The Commons island extends into an irregular grassy shoreline, a sandy beach,
an eight-kilometre ocean horizon, and distant mountain islands. This is bounded
authored scenery, not an infinite terrain-streaming or swimming system. It uses
the same portable generated GLB as the city, without texture downloads or AI
calls. Renderers advertising `largeWorldColliders: 1` receive the larger scene
for the default terrain and district layout. Customized terrain or district
positions retain the compact city so scenery cannot cover authored buildings;
custom labels and assets remain supported. Older runtimes also retain the
compact city until upgraded. The renderer indexes
large landscape colliders once and uses their triangle BVH for local queries.

Worlds already supports `use {id, action}` and authored server-side behaviors.
The renderer's contextual control exposes a primary `comp.interaction` action
or a sole existing reaction. Switches can use a behavior to emit an ordinary
logged `light` or `comp` change; the world remains authoritative and late joiners
see the resulting state. PortOS pods use the validated frame bridge instead of
sending a world verb or embedding destination URLs in scene data. Keyboard
repeat, chat focus, overlays, distance, and occlusion suppress accidental use.
The renderer implementation and a toggle-lamp example live in the separate
Worlds repository. Controller support is tracked in
[Worlds #11](https://github.com/atomantic/eidoverse-worlds/issues/11).

### Agent-free resilience assay (promote-path pre-check)

Part of the [SwarmWorld-inspired stigmergic Eidoverse epic](https://github.com/atomantic/PortOS/issues/7453):
a world foundation should not promote from an instance's local vernacular into
the shared PortOS baseline just because it "worked" while its author mind was
still narrating it live. `server/services/eidoverseResilienceAssay.js` runs a
candidate contribution through a clean, agent-free sandbox before that
decision is made:

- `createSandbox()` is called fresh per scenario, so no state can leak in from
  a previous run or a live process handle.
- `buildProjectionPlan()` (`eidoverseWorldProjection.js`, already pure) loads
  once against the sandbox's initial state, standing in for "replay in a
  clean sandbox instance."
- The controller then replays through the fixed disturbance suite —
  `reconnect`, `restart-world-host`, `missing-optional-deps` — each with a
  warm-up run, the disturbance, and required recovery ticks.
- A controller `step()` (or `applyDisturbance()`) that returns a Promise is
  itself a failure: the assay is synchronous by contract, so an "agent-free"
  contribution cannot reach for a live network, disk, or provider call during
  replay.
- Every tick is checked against a built-in JSON-serializability invariant
  (a promoted foundation has to be loadable by a peer that never saw the
  authoring session) plus any contribution-supplied invariants.

`runResilienceAssay(contribution)` returns `{ contributionId, pass, scenarios,
projection, reasons }` with a readable reason per failure, naming the
disturbance and tick. `scripts/eidoverse-resilience-assay.js`
(`npm run eidoverse:assay`) is the CLI/CI entry point — with no arguments it
runs every reference contribution under
`server/services/eidoverseResilienceAssayFixtures/*.contribution.js`; given
module paths, it runs the assay against those instead and exits non-zero on
any failure. Two reference fixtures live beside the harness: a passing
`beaconRelay.contribution.js` and a deliberately-failing
`narratedOnly.failing.fixture.js` (named so the CLI's default fixture glob
skips it; only `eidoverseResilienceAssay.test.js` exercises it, proving the
harness catches the "author-mind-only" failure mode).

This harness is what the promote gate below runs:
`services/eidoverseFoundationLedger.js` replays a foundation through
`runResilienceAssay()` and refuses to package a promote candidate on a failing
verdict ([#7455](https://github.com/atomantic/PortOS/issues/7455)). Since #7625
the gate builds that contribution from the foundation's OWN body
(`server/lib/eidoverseFoundationSandbox.js`) rather than resolving one by id;
the CLI still sweeps the shipped fixtures through the registry in
`server/services/eidoverseResilienceContributions.js`.

### Local vernacular vs shared baseline, and the promote gate (#7455)

Federated instances are meant to keep their own style and buildings while
discoveries that help everyone find a path into a shared PortOS baseline. That
boundary is a data model, not a convention. `server/lib/eidoverseFoundations.js`
declares three ownership layers:

- **`runtime`** — the shared Eidoverse/PortOS framework. Upstream's to change; an
  instance never authors into it and never promotes it.
- **`baseline`** — the shared promoted-foundation population a peer can inherit.
- **`vernacular`** — this install's own artifacts. **The default for everything
  authored locally**, so nothing is shared by omission; promoting is an explicit
  act with a gate in front of it, never the absence of a "keep this private" flag.

A foundation is `{ body, style }` **by construction** rather than one bag with a
blocklist. `body` is the promotable substance (declared schema, affordance,
optional controller spec); `style` is the cosmetics that make this Commons look
like itself — palette, motif, asset paths, placement, district, display aliases.
Packaging carries `body` and drops `style` outright, which is what makes "a peer
inherits the foundation without the author's cosmetics overwriting its own style
layer" a property of the payload rather than a merge rule a receiver has to get
right. On top of that split there is an authoring check: an unambiguously
cosmetic key found *inside* `body` (`palette`, `motif`, `accent`, `color`,
`material`, `texture`, a label alias) **refuses** the package rather than being
silently trimmed, so "I put the palette in `body` and expected peers to get it"
gets named. Spatial and asset-binding keys (`pos`, `yaw`, `lib`, `districtId`)
are deliberately *not* on that list — they are exactly the substance of a
`district-template` foundation.

`data/eidoverse/foundations.json` (`server/services/eidoverseFoundationLedger.js`)
is the install-local ledger — machine-local like `portos-world.json` beside it,
never federated, no seed file and no migration, since an absent file is the empty
ledger every install starts from.

**The promote gate runs the assay against the foundation's OWN body; it never
accepts a verdict and never replays something the author merely named.**
`POST /api/eidoverse/world/foundations/:id/candidate` DERIVES the sandbox from
`body` through `server/lib/eidoverseFoundationSandbox.js` (#7625), replays it
through the agent-free harness above, and packages against the verdict it just
produced.

Until #7625 the binding was a single author-supplied string: `contributionId`
was free text, it resolved against the shipped fixture directory, and naming a
shipped fixture was *sufficient* to clear the gate. A local build could promote —
and be offered to every federated peer — on evidence that described the demo
fixture rather than the body inside the envelope. `contributionId` is now
**derived** (`controller:<definitionId>`, or `<kind>:<id>`) and is not accepted
on any authoring surface: not the route body, not `eidoverse.record`, not the
panel. A receiving peer re-derives it from the envelope's own `kind`/`body` and
refuses one whose evidence is about something else.

One derivation per declared kind, each refusing a body it cannot interpret —
which is the honest answer, because a declaration nobody but its author can
replay is not promotable:

| kind | what gets replayed |
| --- | --- |
| `controller` | the shipped definition named by `body.controller.definitionId`, run against **this install's** `body.controller.config` through the definition's own `configSchema`. Upstream's `exampleConfig` proves only that upstream's example survives. |
| `district-template` | the declared `body.placement` must reproduce from its own `{ layoutId, anchor, propCount, seed, facing }` via `generateDistrictTemplatePlacement()`, and the body is the harness's projection source — a template's consequence is its projection plan. |
| `schema` / `affordance` | the declarative interpreter: a clean world state is built from `body.schema`'s declared field types and every `body.affordance` verb is resolved against it each tick. An affordance recorded as prose (`{ inspect: 'reads the pulse count' }`) is refused; it has to declare `{ reads, writes }` over fields `body.schema` declares. |

The executable part stays shipped code in every case, so this adds no
arbitrary-code-execution surface — what varies is the declarative input the
install actually authored. A caller therefore cannot assert that its build survived its
author's absence; it can only ask for the check — the same proposal-versus-
consequence separation the construction tools got in #7454, applied to promotion.
A foundation that is re-authored loses both its candidate and its verdict, because
both described the previous body; a refused package likewise clears any candidate
packaged earlier, since the verdict that vouched for it no longer holds.

`server/services/eidoverseResilienceContributions.js` still resolves the shipped
fixtures **by id against a fixed directory** for the CLI and the harness's own
tests. It is no longer the promote path's resolver, and there is no longer an
endpoint or mind tool advertising its ids — `GET /api/eidoverse/world/contributions`
and `eidoverse.contributions` are gone, because a list of ids that were
sufficient to pass the gate was a list of ways around it. An author choosing a
`controller` behaviour reads `GET /api/eidoverse/world/controllers` /
`eidoverse.controllers`, which already project the shipped registry.

Four refusals stand between a local artifact and the shared baseline, and every
one returns a readable reason naming what to fix:

1. **Ownership** — only a `vernacular` foundation is promotable.
2. **Agent-free resilience** — the body must have a derivable sandbox at all, and
   the verdict must pass, cover the full disturbance suite, and be bound to the
   label this foundation's own `kind`/`body` derives (a passing verdict borrowed
   from another build is refused explicitly, on both the packaging and the
   receiving side).
3. **Style leak** — a vernacular style key inside `body`.
4. **Federation safety** — `server/lib/federationSafety.js` refuses the package
   when the candidate carries machine identity, network info, PII,
   credential-shaped values, or a credential-*named* field (`{ apiKey: … }`,
   which no value-shape scan can see), anywhere in its values **or its keys**.
   Nothing is redacted and shipped: a redacted promote would leave the author
   believing they published what they wrote.

The candidate envelope carries a content-addressed `fingerprint` (sha256 over the
canonicalized envelope), so `verifyFoundationCandidate()` is one gate seen from
both sides — the packaging side and a receiving peer's.

**Promoting publishes into this install's baseline population.**
`POST /api/eidoverse/world/foundations/:id/promote` re-packages first and
publishes the candidate it just produced, so promotion never rests on a stored
verdict — every gate above is re-run against the body as it stands. On a pass the
record moves to the `baseline` layer and takes a `promotedAt` stamp; its
`style` stays behind, because only the envelope crosses and the envelope has no
style layer at all. A refusal is a 200 with its reasons and moves nothing.
Re-authoring a promoted foundation returns it to `vernacular` and clears
`promotedAt`: the body that was published no longer exists on this install, and
keeping the stamp would also be a dead end, since the gate refuses to package a
`baseline` foundation.

**Withdrawing retracts a publication, and it reaches the peers that pulled it
(#7632).** `POST /api/eidoverse/world/foundations/:id/withdraw` de-promotes the
record — `vernacular`, `promotedAt` and `candidate` cleared, the body kept — and
records a **tombstone** for the fingerprint it had published. That tombstone
rides the peer offering, and a receiving install *deletes* its inherited copy
rather than merely ceasing to re-pull it. Re-authoring a promoted foundation
tombstones the replaced envelope for the same reason: it retracts a published
body, and before this it did so silently. Promotion used to be one-way, so a
foundation carrying something its author regretted — a personal detail the
regex-shaped federation-safety scan cannot recognize, a wrong attribution, a
body that turned out to be harmful — stayed on every install that had pulled it,
for good.

`DELETE /api/eidoverse/world/foundations/:id` removes a record outright, and
**withdraws it first if it was promoted** — so the most natural gesture an
author makes cannot orphan a peer's copy beyond recall. `?originInstanceId=`
addresses an INHERITED copy; a bare id always means this install's own work,
because the two id spaces legitimately overlap.

**What withdrawal does not promise.** A peer running a PortOS older than the
`tombstones` wrapper key (schema v3) gently skips the whole offering and keeps
its copy, saying so in its log. That is unavoidable by construction — retraction
is best-effort across versions, never a guarantee — and it is the right failure
mode: the old peer degrades to the previous add-only behavior instead of acting
on a wrapper it cannot fully read. Deleting a record whose tombstone has already
aged out of the capped list is likewise final.

**Where the user does this.** Eidoverse > World controls > **Foundations**
(`client/src/components/eidoverse/EidoverseFoundationsPanel.jsx`) lists every
foundation with its ownership-layer badge, records or re-authors one, runs the
assay, promotes, and renders each refusal reason verbatim beside the foundation
it refused. The expanded foundation is a `?foundation=<id>` search param, so a
refusal is linkable. The form has no contribution field: it seeds the `body` per
kind and, for a `controller`, fills it from a shipped definition read off
`GET /api/eidoverse/world/controllers` — an install that ships none says so
rather than offering an empty picker.

**The mind needs its own grant to promote.** `eidoverse.promote` (with the read
beside it, `eidoverse.foundations`) is gated on `manageEidoverse` **and** the
separate default-off `promoteEidoverseFoundations` grant, and is mind-scope only
— building in the local world is never permission to publish out of it, and an
ephemeral CoS task agent never gets the tool at all. The server runs the assay
itself, so a mind can ask for the check but can never assert a passing verdict.
Both tools return summaries (`summarizeFoundation`) rather than whole records:
the local style layer and the packaged envelope have no business riding into a
prompt.

A mind can also author, not just list and promote. `eidoverse.record` wraps the
same `recordEidoverseFoundation()` the HTTP route above uses, gated on
`manageEidoverse` alone (no promote grant needed — authoring stays local by
construction) and mind-scope only. `authorKind` is stamped `'mind'` server-side
regardless of what the call arguments claim, the same reason `layer` is never
caller-supplied — and, since #7625, the same reason `contributionId` is not
accepted either: a mind that could name what the gate replays could point it at a
shipped demo. `eidoverse.controllers` (`manageEidoverse`, read) is what a mind
reads first, for the `definitionId` values a `controller` body may name.

### Provenance graph and inheritance edges (#7461)

Every foundation carries queryable provenance: who authored it (an opaque
instance id + coarse `authorKind` — `mind` / `cos` / `user`, never a display
name) and its ordered lineage. `foundationLineage()`
(`server/lib/eidoverseFoundations.js`) derives that lineage — `authored` →
`assayed` → `packaged` → `promoted`, or `inherited` → `assayed` for a local
copy of a peer's — from fields the record already persists, so it costs no
extra storage and a ledger written before this existed still projects
correctly. `GET /api/eidoverse/world/foundations` returns it on every entry,
and the mind tools' `summarizeFoundation()` projection carries `provenance`,
`inheritance`, and `lineage` too — the same identity fields a candidate
envelope was already authorized to carry, now surfaced consistently
everywhere a foundation is read. `GET /api/eidoverse/world/foundations/:id`
names a locally-authored record by its plain id and an inherited copy by
`?originInstanceId=<origin>` (#7626): an inherited copy lives under a
separate ledger key precisely so it can share a human-readable id with a
local vernacular foundation without colliding, so the ORIGIN is what
disambiguates the two. The `peer:<origin>:<id>` storage key itself stays
internal and is never typed by a caller — `{ id, originInstanceId }` is the
grammar (`eidoverseFoundationTargetSchema`), and `foundationLedgerKey()` is the
one place it becomes a key.

**`recordEidoverseFoundationInheritance()`** (`eidoverseFoundationLedger.js`)
is the accept-side of a peer pull: given an already-verified candidate
envelope, the peer this install pulled it FROM, and this install's own
instance id, it re-runs the exact gate a peer runs on a candidate it was
handed — schema, content-addressed fingerprint, the embedded assay evidence,
and federation safety — and, on a pass, stores a `baseline` local copy
carrying an `inherited-from` edge (origin instance, source instance, the
envelope's fingerprint, and when it was pulled). It refuses a self-referential
pull (a peer handing back a foundation this install itself originated) and
never re-runs the resilience assay itself — replaying a peer's controller code
on the receiving install is exactly what the assay harness exists to keep off
every OTHER install.

The inherited copy is stored under `peer:<originInstanceId>:<foundationId>` —
deliberately disjoint from any id a local author could ever write — so it can
never shadow, collide with, or erase a same-id local vernacular foundation;
both simply coexist in the listing. An inherited foundation can never be
re-promoted from this install (`packageFoundationCandidate` refuses it by
name): promotion publishes only what this install itself authored, never a
relay of another install's work.

### Reading and adopting an inherited foundation (#7626)

Inheriting a peer's foundation used to store a row and nothing more: no
runtime on either install read a foundation's `body`, so the only way to use
what a peer contributed was a human reading raw JSON out of the Foundations
panel and retyping it — the "go read the author's transcript" path this whole
area exists to replace, and one that keeps no attribution. Two verbs close
that.

**Read one.** `eidoverse.foundation` (mind tool, `manageEidoverse`, read) and
`GET /api/eidoverse/world/foundations/:id` return `detailFoundation()` — every
field `summarizeFoundation()` carries, plus `body` and `disclosure`. The LIST
projection still omits both, deliberately: a list of whole bodies is kilobytes
of substance per entry riding into a prompt to answer a question about ids,
and which body to read is a decision made after the list. `style` is omitted
in both — it is this install's cosmetics and never leaves.

**Adopt.** `eidoverse.adopt` (mind tool, `manageEidoverse` **and**
`installEidoverseControllers`) and `POST
/api/eidoverse/world/foundations/:id/adopt` stand an INHERITED foundation up
as something that runs here. `planFoundationAdoption()` decides per kind:

| kind | what adopting does |
| --- | --- |
| `controller` | Installs the SHIPPED controller `body.controller.definitionId` names, with the envelope's `config`, **disarmed** and with `deliverEffects: false`. |
| `district-template` | **Refused** — nothing turns a template body into geometry yet (#7627). |
| `schema`, `affordance` | **Refused by name** — a declaration with no interpreter here is not adoptable, and saying so is the honest answer. |

A locally-authored foundation is refused too: its author already has every way
to install it, and adoption is specifically the path for a peer's work.

Adopting a controller can never execute a peer's bytes. The envelope names
*which of this install's own shipped controllers* to run and with what
settings; `installEidoverseController()` resolves that id against the fixed
local registry, exactly as an ordinary install does. The result lands disarmed
and silent, so arming it and letting it speak or build in the world stay
separate, local decisions rather than consequences of one tool call.

The resulting controller install carries a `derived-from` edge — origin
instance, foundation id, envelope fingerprint — in the same shape a derived
foundation uses. That edge SURVIVES a later re-install (it is preserved
alongside `installedBy` / `installedAt`), which is what makes adoption the
provenance-keeping way to re-use a peer's contribution as against retyping the
body, which keeps nothing and is refused as republishing (#7631). An adopt
whose install id is already taken by a controller derived from something else
is refused rather than overwriting a controller already running here.

### The peer pull/inherit transport (#7455)

Authorized to cross the federation layer by the
[federated Eidoverse foundations ADR](../decisions/2026-09-18-federated-eidoverse-foundations.md).
`server/services/sharing/peerEidoverseFoundationSync.js` is the wire between
the two gates above. It owns no policy of its own — which foundations an
install offers is `listPromotedFoundationCandidates()` in the ledger, and
which it accepts is `recordEidoverseFoundationInheritance()`. It owns the
payload wrapper, the version gate, the caps and the sweep.

**Outbound.** `GET /api/peer-sync/eidoverse-foundations` advertises
`{ schemaVersion, listHash, candidates: [...], tombstones: [...] }`. The
`candidates` are exactly the foundations this install PROMOTED and AUTHORED:

- `layer === 'baseline'` — a merely *packaged* candidate is a dry run ("would
  this pass?"), not a publication, and is never served.
- `!inheritance` — `baseline` also covers a local copy of a peer's foundation,
  so an inherited record is excluded rather than relayed. That matches the
  ledger's existing refusal to re-package an inherited record: a peer that
  wants a third install's foundation pulls it from the install that authored it.
- the stored envelope must still pass `verifyFoundationCandidate()`.
  `foundations.json` is a file a human can edit, and refuse-never-redact
  applies outbound as well as inbound, so a candidate that no longer passes is
  withheld from the offering and logged.
- the fingerprint must not be tombstoned. Promoting clears a fingerprint's
  tombstone, so the two lists cannot normally disagree; a hand-edited ledger can
  make them, and an offering that both published and retracted one fingerprint
  would resolve differently on every receiver. The retraction wins.

`tombstones` is `[{ fingerprint, deletedAt }]` — a content-addressed name and an
instant, never any of the body. It caps on its **own** budget, never against
`OFFERING_ENTRY_CAP`: sharing one cap would let a large promoted population
silently truncate the retractions, which is the one trade this must never make.
Both lists feed the `listHash`, so a withdrawal with no other change still
breaks a receiver's unchanged short-circuit instead of waiting for the next
forced re-pull.

Unlike the older peer-pull routes, this one does not ride the warn-first
authorization ramp: it passes `alwaysEnforce`, so only a registered,
outbound-enabled peer ever reads it. The ramp exists so a peer mid-upgrade
does not lose sync it already had, and a brand-new endpoint has no such
history to protect.

**Inbound.** `syncEidoverseFoundationsFromPeer()` runs for peers the user
flagged `fullSync`, on the same 60-second sweep as the media-library,
CoS-history and CoS-task sweeps (`services/sharing/index.js`). It byte-caps
the response, validates the wrapper, gently skips a sender whose
`schemaVersion` is ahead of local (the ledger has no re-fetch path that would
correct a mis-applied envelope later), short-circuits on an unchanged
`listHash`, and hands every remaining candidate to
`recordEidoverseFoundationInheritance()` — which re-runs the *entire*
accept-side gate and writes nothing on a refusal. A candidate whose
fingerprint this install already holds is skipped, so the periodic forced
re-pull (there so a local deletion self-heals) never rewrites `inheritedAt`
on an unchanged copy.

The sweep applies the peer's **retractions first**, before it reads what this
install holds: a fingerprint the same offering re-publishes is then re-verified
through the whole accept-side gate on its way back in, rather than surviving in
place unchecked. A retraction authorizes dropping only a record this install
pulled from *that same peer* (`inheritance.sourceInstanceId`) — a fingerprint is
public inside the federation the moment it is offered, so it identifies a record
but authorizes nothing, and without the scope any registered peer could retract
a third install's work by naming it. A tombstone for a fingerprint this install
does not hold is a silent no-op. Peer tombstones are not persisted: this install
never re-offers an inherited record, and the sender keeps advertising the
tombstone while its candidate stays absent, so storing them would only let a
peer crowd out this install's own retractions.

Both directions are gated on the `eidoverse` instance feature: an install with
Eidoverse turned off neither offers nor accumulates.

**Compatibility.** The envelope's `candidateVersion` is **v3** as of #7625. The
bump is semantic rather than structural: a pre-v3 envelope's assay evidence was
recorded against a contribution its author named, with no required relationship
to the body travelling beside it, so there is nothing to upgrade — the accept
side refuses v1 and v2 outright with that reason rather than inheriting on
them. Migration `scripts/migrations/397-eidoverse-foundation-derived-assay.js`
does the local half: it re-derives every record's binding label, drops the
verdicts the old replay produced, and returns an unreplayable `baseline`
foundation to `vernacular` with `promotedAt: null` — exactly what the ledger
already does when a body is re-authored, for exactly the same reason.

`PORTOS_SCHEMA_VERSIONS.eidoverseFoundations` (v3) is the
transport contract, registered in `NON_RECORD_SCHEMA_CATEGORIES` because this
is a receiver-pull category with no push to gate — a foundation is not a
peer-subscribable record kind. It is deliberately separate from the envelope's
own `candidateVersion`, which pins one envelope's shape and is hashed into its
fingerprint: a change to the envelope bumps both, a change to the wrapper or
the caps bumps only the category. v3 (#7632) added `tombstones` to the wrapper
and moved only the category, because a tombstone names a candidate by the
fingerprint it already had and no envelope field changed. A v2 sender omits the
key and a v3 receiver reads that as "nothing to retract"; a v2 **receiver**
gently skips a v3 offering and therefore keeps a copy it should have dropped.

### Creative toolkit for minds (#7459, wired end-to-end in #7627)

Authoring a foundation from a blank `body`/`style` is a lot to invent from
scratch every time. `server/lib/eidoverseCreativeToolkit.js` is a small,
documented, closed vocabulary a mind reaches for instead: named **materials**
and **motifs** (cosmetics — install-local `style`, the same class of value
`styleLeakFindings` refuses inside a `body`) and named **generative placement
layouts** (`radial-ring`, `grid-plot`, `arc-row`, `grove-cluster` — structure,
safe as `body`). `eidoverse.creative-catalog` (`manageEidoverse`, read) lists
all three, including each material's `colorHex` — a palette id whose value a
mind cannot see is not a usable catalog entry. Nothing here calls an AI
provider; every layout is deterministic and seeded
(`generateDistrictTemplatePlacement`), so the same `{layoutId, anchor, seed}`
reproduces the same geometry on replay or on a peer that later inherits the
promoted foundation.

Two tools use a chosen layout, both read-only (they compute; they do not write
to the world or the foundation ledger):

- **`eidoverse.place-layout`** (`manageEidoverse`) calls
  `buildDistrictTemplateAugmentOperations()` and returns ready-to-submit
  `eidoverse.augment` `spawn` operations for the *live* scene (asset-path
  validity is still checked where `eidoverse.augment` lands them). The same
  `{layoutId, anchor, seed}` yields byte-identical operations every call.
- **`eidoverse.draft-foundation`** (`manageEidoverse`) calls
  `buildDistrictTemplateFoundationDraft()` and returns an
  `eidoverseFoundationInputSchema`-shaped `district-template` input — the
  generative substance (layout id, anchor, seed, resulting positions) in
  `body`, the material/motif cosmetics in `style` — ready to pass straight to
  `eidoverse.record`. Drafting composes nothing itself; recording still lands
  on the local `vernacular` layer, matching every other authored foundation,
  and publishing to the shared baseline remains the separate, explicit
  `eidoverse.promote` act above.

**`eidoverse.record` derives, never trusts, a `district-template`'s
placement.** When a recorded `district-template`'s `body` carries
`{layoutId, anchor}` (with an optional `seed`), `recordEidoverseFoundation()`
(`services/eidoverseFoundationLedger.js`) replays
`generateDistrictTemplatePlacement()` server-side and stores the result as
`body.placement` — REPLACING any placement the caller supplied, not merging
it. That is what makes the replay claim above hold for a hand-assembled
`eidoverse.record` call too, not only for one built from
`eidoverse.draft-foundation`'s output, and it is why the same `district-template`
is comparable and replayable on an older or newer install that later inherits
it (#7625).
