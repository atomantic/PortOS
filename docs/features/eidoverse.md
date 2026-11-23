# Eidoverse Worlds integration

Eidoverse Worlds is an optional, disabled-by-default PortOS feature. It is not
vendored into PortOS and is not a git submodule. Choosing **Install & enable**
under **Settings → Features** is the explicit consent boundary that downloads,
installs, and enables the runtime; the ordinary feature toggle never installs it.
If Bun is not already available, the same action first runs Bun's official
platform installer under the PortOS service account on Windows, macOS, or Linux.

## Signal ownership

`server/services/eidoverseWorldSources.js` owns local reads, cancellation, Jira
fetching, and destination lookup. It passes snapshots to the pure
`server/lib/eidoverseWorldSignals.js` owner for bounded aggregates and stable
opaque IDs. `server/services/eidoverseWorldProjection.js` then plans world verbs
from those signals. World orchestration loads the collector only during explicit
projection; identity and travel consumers import the pure signal owner directly.
The collector and world service retain their historical helper exports.

## What PortOS installs

The installer keeps the two AGPL-3.0 projects as independent git checkouts. The
Worlds repository is selected per PortOS instance. The recommended default is
`https://github.com/atomantic/eidoverse-worlds` on branch `portos`; an instance
owner can enter another GitHub origin and branch before installing:

- `data/repos/{owner}/{repo}` — the selected Worlds repository and the checkout
  PortOS registers under **Apps**. Ordinary GitHub forks retain the
  `eidoverse-worlds` repository name.
- `data/repos/anima-research/eidoverse-video` — the upstream video/runtime
  checkout used by Worlds. A fork is not required unless changes to that
  repository itself become necessary.

PortOS runs `bun install --frozen-lockfile` in the Worlds root and client, then
writes an ignored `.env.portos` file that points Worlds at the video runtime and
at its durable world store. PortOS does not copy either project's source into
the PortOS repository, combine the codebases, or relicense them; each checkout
retains its own upstream license and git history.

After installation, **Worlds GitHub repository** and **Worlds runtime / tracking
branch** remain available on **Settings → Features**. **Recommended (portos)**
selects the recommended origin and branch; **Update source** applies the choice
in place. Branch changes require a clean checkout and refuse to overwrite local
commits absent from the target. Restart or update the managed app to load the
changed code. App updates honor the selected branch using the checkout-local
`portos.runtimeBranch` Git setting; clearing the field restores the origin default
branch on the next update. Existing saved choices are preserved. The managed-app
path, world data, and companion video origin remain unchanged.

The managed app's **Git** tab makes that two-repository topology explicit. It
shows the checked-out branch and revision for Worlds and Video, compares each
checkout with its configured origin, and—when Worlds points at an ordinary
GitHub fork—compares that fork with the canonical
`anima-research/eidoverse-worlds` upstream. A failed network comparison is
reported as unknown rather than as current.

**Sync fork only** fast-forwards the configured Worlds fork on GitHub without
changing either local checkout or restarting a process. PortOS never passes
`--force`, so a fork with its own incompatible commits is left untouched for
manual reconciliation. **Update both** pulls Worlds from its configured origin,
pulls the independent Video checkout from its own origin and branch, installs
Worlds' frozen Bun dependencies, and restarts only Eidoverse. Video is therefore
managed as a version-visible sidecar, not pinned as a PortOS submodule.

That topology is only visible to someone who goes looking for it, so freshness
is also reported where a user actually lives. Opening **Eidoverse** runs the
same repository-source check once per visit and, when a checkout or its fork is
behind something the update can pull it forward from, raises an advisory above
the world naming what is behind and offering the same one-click managed update.
Dismissing it silences that revision only — the next Eidoverse release raises it
again. The check is scoped to this page rather than added to the global PortOS
update banner because it costs a `git fetch` on both checkouts plus GitHub fork
metadata, which is not a price every screen should pay.

The advisory reports only drift an update can actually clear. The Video checkout
is cloned from a third party's *fork* of the canonical project, and PortOS can
read that fork but never push to it — so when it falls behind its own upstream,
neither `gh repo sync` nor a pull from its origin can move it, and an advisory
raised for that drift would never clear. PortOS therefore counts a fork toward
"update available" only when it is the application checkout's own fork, the
credential can push to it, and it has not diverged (`isForkSyncable` in
`server/services/managedAppRepositories.js`, surfaced to the client as each
source's `forkSyncable`). The drift is still reported on the app's **Git** tab,
where the card explains why no button there clears it.

## Runtime and data ownership

The managed app uses port `8940` and starts with the Bun executable found or
installed during setup:

```text
<bun> --env-file=.env.portos server/server.ts
```

Once installed and enabled, PortOS starts the runtime automatically at server
boot and when the feature is enabled. It waits for readiness, opens the host
bridge, reconnects the resident CoS presence when that presence is enabled, and
reconciles pending world-design updates. This startup never installs missing
dependencies, downloads assets, or calls an AI provider. A disabled feature does
not auto-start the runtime; manual app controls remain available. Start, stop,
logs, updates, and launch links remain visible on the normal managed-app screen.
Command-based Eidoverse launches use a 2 GB PM2 memory restart limit so the
loaded world and asset runtime can exceed the generic app limit of 500 MB.
Plain-HTTP managed apps
keep an `http://` launch URL even when PortOS itself is open over HTTPS, so the
Apps launch action works from a Tailscale MagicDNS session. Managed updates pull
both the selected Worlds checkout and its companion video runtime before using
Bun's frozen lockfile rather than npm.

When the feature is enabled, **Eidoverse** is the primary PortOS world surface.
Opening it starts the managed app when needed and embeds its web client in a
full-width PortOS page. The retired OpenWorld paths remain as compatibility
redirects to Eidoverse, so old bookmarks do not create a second world renderer.

Durable Eidoverse world logs live at `data/eidoverse/worlds`. This is
machine-local `file-primary` data: PortOS backups include it, but PortOS does
not federate it to peers. The git checkouts remain under `data/repos`, which is
the existing re-cloneable repository backup class.

## Private persistence and identity

This is a private world for one PortOS install. It is not a public Eidoverse
world and PortOS does not publish its world records or expose them through the
peer-sync record layer. Trusted machines may reach the instance through the
install's existing Tailscale boundary; the install remains the authority for
the world and its history.

PortOS-owned integration state is stored in
`data/eidoverse/portos-world.json`. It contains the selected world, the human
display name, the stable Persistent Mind/CoS identity and local role
observations, the projection recipe, and the last projection checkpoint.
The human name can be configured explicitly. If it is cleared, PortOS derives a
stable pseudonymous label from the persisted instance id without placing the
raw id or the machine's display name in the Eidoverse log.
The V1-to-V2 migration recognizes the old `instance-name` source marker and
retires only that automatic value; an explicitly configured name is preserved.
Because Eidoverse history is append-only, PortOS does not rewrite prior log
entries, but it no longer joins or projects with the retired machine name.
The browser receives that same identity in the Eidoverse launch URL, so a
reload or a second trusted machine does not create a new anonymous user.
The default installation uses Eidoverse's name-based join protocol with the
empty join-token setting; the URL supplies the durable world, name, and avatar
instead of inventing a browser-local account. If an operator later adds a
join-token policy in the independent Eidoverse runtime, that policy remains an
explicit runtime configuration rather than a secret stored in PortOS state.

The Eidoverse runtime remains responsible for its own append-only world log,
snapshot, roles, chat, poses, and assets under `data/eidoverse/worlds`. PortOS
joins through the runtime's public WebSocket protocol and never edits the
external checkout to seed content. On a fresh world, PortOS establishes the
configured human identity first so it can own the world, then reconnects the
stable CoS identity as an agent and grants it an owner role. Eidoverse reserves
terrain, sky, and role handoff for owners, so the persistent CoS must retain
that role to maintain the projected world and hand ownership to a renamed
human identity. Once the new identity owns the world, PortOS demotes the prior
identity to visitor so a rename does not leave a stale owner behind. PortOS
exposes that authority through the separate, disabled-by-default **Manage the
private Eidoverse world** grant in both the Persistent Mind controls and the
local Agent Tools (MCP) controls; generic PortOS write access does not imply it.
This makes both the human and CoS roles durable in the Eidoverse world rather
than browser-session conveniences.

## World Design V3: PortOS Commons

Commons arranges eight inward-facing halls around a grassy arrival park.
A broad circular promenade and short paths link rounded gathering terraces;
trees, planted beds, and timber seating soften the edges. The center stays
clear for pedestrian agents, Persistent Mind avatars, and human guests.
Buildings use Eidoverse's existing `comp.structure` grammar: tiled floors,
glass frontage, open archways, walls, and roofs, with native collision.
Large district landmarks sit on rooftop plinths behind the frontage. Their
measured bottom and animation clearance keep the entrance and physical sign
visible. Accent-edged paths and shallow entrance canopies connect each hall
to the promenade. These geometry changes reconcile through the existing V3
projection without resetting user overrides or visitor-authored objects.
A deterministic GLB adds walking surfaces, decorative seating, and physical
district signs through Eidoverse's ordinary content-addressed upload API.
Each install reuses the verified recipe-derived asset on later projections.

Library geometry summaries are measured once per resolved path and retained
in the asset locks. Placement compensates model-origin offsets and fits a
semantic size envelope; native structure anchors and the city surface retain
their authored coordinates. Desktop computers sit at the measured desk height.

The portable recipe resolves desks, retro terminals, crates, barrels, palms,
and streetlights from each install's own library. Furniture stays inside the
buildings or beside entrances. Arcade computers sit on individual desks, with the first eight workstations
inside the hall and overflow on its terrace. Other bounded live signals occupy
distinct bays beside the entrance aisle, sharing the existing 48-signal budget. Decorative furniture
has no floating label. Semantic landmarks and signals keep their optional
annotations, hidden at the start of each visit until the user activates the
Labels toolbar toggle or chooses a label mode in World controls.

V1 and V2 defaults remain immutable migration baselines. The V3 migration
preserves explicit overrides, aliases, and the last successfully applied
version. Changed asset slots invalidate their resolution fingerprints;
unchanged locks remain reusable. Existing managed identifiers stay stable,
obsolete trail markers are retired by normal reconciliation, and unrelated
visitor-built entities remain untouched. Failure compensation restores native
structure components through the existing component rollback path.

No Eidoverse framework change is required. Physical signs are authored scene geometry; camera-facing clickable labels are
a separate, optional renderer capability. Building room labels describe topology and do not render signs.

## Assets are a recipe, not a payload

PortOS does not bundle model packs. `server/lib/eidoverseWorldDesign.js` stores
small semantic slots such as `nexus`, `agent`, `memory`, and `peer`. Each slot
declares:

- preferred Eidoverse library paths;
- fallback search queries;
- semantic filename tokens used as ranking hints and whole-token exclusions;
- maximum bytes, GLB/animation expectations, and `library-only` source policy;
- a final known-library fallback.

On first projection after an install or recipe update, PortOS reads
`/library-list`, uses `/library-models` only for unresolved slots, rejects
content-addressed `store/<hash>` paths for portable defaults, verifies each
chosen `/library/...` asset, and ranks candidates deterministically. It then
persists the exact path, byte-size metadata, design/recipe/slot versions, per-slot
recipe fingerprint, strategy, catalog fingerprint, resolution time, and
default-versus-user source in `assetResolutions`. Normal projections reuse that
lock and do not repeat model searches. A later design release invalidates only
slots whose recipe fingerprint changed; unchanged paths and local overrides
remain pinned. Eidoverse owns and caches the bytes. A user may retain an
explicit install-local `store/...` model override, but that path is recorded as
an override and never becomes a shipped PortOS default.
Search results remain eligible when a library rename removes an old filename
token, and a safe catalog GLB is the final deterministic fallback after searches
are exhausted. Catalog entries without byte metadata remain usable with
`bytes: null`; a known over-budget size is still rejected.

## Versioning, updates, and recovery

`data/eidoverse/portos-world.json` schema V3 records
`selectedDesignVersion`, `lastAppliedDesignVersion`, `pendingDesignVersion`,
`userOverrides`, `assetRecipeVersion`, `assetResolutions`, `migrationReport`,
and the reconciliation checkpoint/error. The immutable V1 and V2 registries are
both retained in source.

Migration `323-eidoverse-world-design-v2.js` runs in the normal PortOS migration
pass used by `update.sh`, `update.ps1`, and ordinary server boot. It compares
every stored V1 leaf against the immutable V1 default: a default-matching leaf
inherits V2, while a genuinely customized leaf becomes a V2 user override.
Customized V1 source caps above the corresponding V2 cap are reset to the V2
default and their original values stay visible under unsupported overrides,
preventing an old lane-scale cap from starving the semantic districts.
V1's lane coordinates have no safe district translation, so a custom layout is
reported rather than silently applied. Missing state is a fresh V2 install;
invalid or newer schema state fails closed and remains pending for repair or a
PortOS update.

Migration `325-eidoverse-video-companion.js` backfills the canonical Video
checkout into older Eidoverse managed-app registrations. This lets those
installations use the same two-checkout managed update path after upgrading
PortOS without rewriting their selected Worlds origin or world data.

The offline migration never touches an external checkout or calls an AI
provider. It leaves V2 pending. After restart, a deterministic reconciler runs
only when the separately managed Eidoverse process is already online. It
preflights runtime build identity, the catalog, and every selected asset before
sending world operations. Reconciliation is staged: infrastructure and live
signals are created first, the managed environment follows, and only then are
obsolete V1 ids retired. Every acknowledged operation has an inverse derived
from the pre-update snapshot. A failed stage reconnects, applies those inverses
in reverse order, retains the old `lastAppliedDesignVersion`, and leaves a
resumable checkpoint. If Eidoverse is stopped or incompatible, PortOS leaves
the update pending and the page links directly to the managed app instead of
claiming the world is current.
A process restart during an applying or compensating stage marks that persisted
run as interrupted before boot reconciliation; the drawer then offers the same
explicit retry path as other failures. Retired owner-role cleanup is
best-effort and never blocks the current world: failed demotions retry up to
three projections, then age out with a generic manual-review warning. A later
clean run clears that warning, and a full reset clears all recovery state.

On a genuinely fresh world there is no previous atmosphere to protect, so the
dawn environment is applied first and the user does not wait in darkness while
the initial landmarks and signals stream in. The stricter order above remains
mandatory for every upgrade with a previously applied design.

The hosted page retains a loading curtain until the embedded renderer arrives,
then leaves the scene unobstructed. PortOS refresh, configuration, and standalone
launch actions live in the page header rather than over the renderer. District,
indicator-capacity, and reconciliation details stay in the World Design drawer,
where they remain available without covering Eidoverse's own chat and world tools.
**World controls** opens the shared tabbed drawer:

- **Experience** — durable identity and high-level design status;
- **Districts & Data** — source visibility, counts, current/stale state, direct
  PortOS routes, caps, and district resets;
- **Appearance & Assets** — dawn environment, selected size/source, local
  overrides, and the persisted asset recipe;
- **Updates & Advanced** — migration diff, checkpoints, apply/retry, asset
  re-resolution, and a two-step full reset.

The Persistent Mind and explicitly granted local CoS agents can use the
governed `eidoverse.status`, `eidoverse.project`, `eidoverse.augment`, and
`eidoverse.say` tools. `eidoverse.augment` accepts only bounded world verbs (for
example `spawn`, `place`, `comp`, `light`, `terrain`, `sky`, and `grant`); it
cannot execute arbitrary runtime behavior or modify the installed Eidoverse
source. Status requires bounded PortOS read access. Projection, augmentation,
and world chat retain the dedicated Eidoverse-management grant without widening
generic PortOS record-write authority.

**Bounded local scene inspection.** `eidoverse.inspect-scene` (provider alias
`eidoverse_inspect_scene`) requires `manageEidoverse` for minds and agents,
using the same local world-management authority as augmentation. It reads the
already admitted local connection; it never joins, starts the runtime, projects,
places objects, visits a peer, or adds a federation channel. If disconnected,
open/start the existing Eidoverse world through its normal controls first.

Input is exactly `{ anchor: [x, y, z], radius, limit? }`: three finite coordinates
in `[-10000,10000]`, spherical radius in `(0,100]`, integer limit `1..12`
(default `8`), no extra keys. Use a new semantic `requestId` for a fresh read;
replaying one returns its original result under the common dispatch contract.

Output is exactly:

```text
{
  availability: "current" | "unavailable" | "incomplete",
  sequence: integer | null,
  observedAt: ISO timestamp | null,
  complete: boolean,
  truncated: boolean,
  boundsComplete: boolean,
  unknownBounds: nonnegative integer,
  invalidEntities: nonnegative integer,
  entities: [{
    id: stable entity id,
    pos: [x,y,z], yaw: radians, scale: positive number,
    asset: normalized library model reference | null,
    portosManaged: boolean,
    bounds: {min:[x,y,z], max:[x,y,z]} | null,
    boundsState: "known" | "unknown"
  }]
}
```

`sequence` is the current authored log cut (including the snapshot's already
folded tail), then advances with contiguous live updates. `observedAt` records
when the response was assembled after draining received messages. Added, moved
and removed entities come from those updates, rather than the join handshake.
Sequence gaps, unknown spatial verbs and world resets invalidate completeness;
a new valid snapshot restores it. Closed/failed connections and snapshots without
a verifiable cut are unavailable. This is a point-in-time authored view, not a
reservation against later movement or construction.

Measured static model bounds become world AABBs by transforming all eight
corners with the authored position, yaw and scale. Known boxes intersecting the
sphere are returned even if their origin is outside it; entities with unknown
bounds are selected by their authored origin. Model summaries must be finite,
ordered, nondegenerate and within the coordinate range; transforms require a
finite yaw within ±2000π and scale in `(0,100]`. Malformed transforms and
parent-relative entities are omitted and counted in `invalidEntities`.

`complete` means every selectable entity in this query was enumerated.
`boundsComplete` additionally requires no invalid or unknown bounds **anywhere
in the retained world view**, because an unmeasured object outside the query
might extend into it. `unknownBounds` is that global count, not just returned
rows. An empty list with incomplete enumeration or unknown extents never
certifies an area clear. Even measured bounds describe authored model geometry,
not terrain, avatars or the full rendered scene. Procedural components, motion,
attachments, runtime behaviors and deterministic simulation are not evaluated;
their geometry remains unknown. Unsupported component/dynamic flags stay
conservative until a replacement spawn or fresh snapshot resolves them.

Inspection retains at most 2000 authored entities (more means `incomplete`),
fetches at most 16 unique model summaries per call with a shared two-second
budget, and reads at most 64 KiB per summary. Failed or oversized summaries stay
unknown. Whole result rows are capped at 3000 serialized characters, below the
mind's 4000-character semantic envelope budget; count or character clipping sets
`truncated: true` and `complete: false`. There is no pagination or clearance
certificate. Use smaller spatial queries to inspect candidate anchors.

Only `eidoverse/assets/models/...glb` library references and content-addressed
`store/<16..64 lowercase hex>.glb` references can appear as `asset`; all other
references become `null`. No raw component bags, record contents, chat, tickets,
actor identities, URLs, filesystem paths, error bodies or credentials are
exported. `portosManaged` reads only `comp.portos.managedBy === "portos"`;
keep those existing projected objects intact. A small synthetic workflow uses
five calls: status → inspect occupied anchor → inspect alternate anchor →
augment original objects → inspect the result. Inspection itself places nothing.

**Proposal vs consequence.** `eidoverse.augment` is a two-phase contract, not a
direct write: a mind's call is a *proposal* (structured verb+args intent), and
only the world's own ack determines the *consequence*. The result's
`operations` array carries one outcome per submitted operation — `accepted`
(landed exactly as proposed), `rewritten` (the world acknowledged it with
different committed args than proposed, e.g. a clamped value), or `refused`
(PortOS's own bounds check or the world itself rejected it, and nothing
landed) — each with `proposed`/`committed` payloads so a mind cannot narrate a
build that never happened. A world-level refusal stops the rest of that batch
from being sent, since later operations often reference an id an earlier one
was meant to create. `eidoverse.say` is simpler — it either resolves with
`committed: true` once the world acks the message, or the tool call fails
outright, so a failed send can never be mistaken for a sent one.

## Growth and automation

The world-design recipe and per-install asset lock are intentionally separate
from the current world log. As PortOS gains resources, the deterministic
projection runs when the hosted page opens and can also be run manually, from a
CoS task, or through the disabled-by-default autonomous job
`job-eidoverse-projection`. Enabling that job is an explicit install-local
choice; it performs no provider calls and only reflects resources that already
exist. The hosted page starts the managed runtime when it is opened; an
automated projection run expects that managed app to remain available, and
records a failed run instead of silently publishing stale or fabricated data.
CoS tasks can also augment the world with bounded authored landmarks or
messages, while recipe changes remain visible and editable in PortOS.

Disabling the feature hides the optional navigation entry but does not delete
repositories, unregister the app, stop a running process, block the direct
`/eidoverse` route, disable a separately configured projection job, or remove
world history. Destructive uninstall remains an explicit manual operation.

## Network boundary

This integration is intended for the same private, single-user Tailscale trust
boundary as PortOS. Eidoverse binds its server to the host network and permits
an empty join token; do not expose this configuration to the public internet.
An instance that needs a broader trust model should configure Eidoverse access
control in that project before starting it.

Eidoverse itself remains a plain-HTTP service on `:8940`. The embedded page
starts the on-demand PortOS host and loads the renderer at the **same origin**
as the PortOS UI — `${location.origin}/eidoverse-host/?…` — so a single-port
tailcat forward (`127.0.0.1:15555` → remote `:5555`) works. The main `:5555`
server reverse-proxies `/eidoverse-host` to loopback `:8940` (prefix stripped)
and, while the host is active, also forwards allowlisted absolute root routes
the renderer issues (`/ws`, `/version`, `/library/…`, `/node_modules/…`, …),
including the WebSocket upgrade for `/ws`. Both external repositories stay
unchanged. The host starts only when the page is opened, waits for the managed
app to answer before mounting the iframe, and returns an explicit unavailable
state when the runtime does not become ready.

Every PortOS entry point to the sequencer (the `/eidoverse-host` mount, the root
allowlist, both WebSocket upgrade listeners and the `:5563` bridge) passes one
admission check before anything is proxied. A cross-origin or DNS-rebound
browser request gets `403` whether or not a password is set. With the instance
password set, only an operator or agent session, or a live federated guest
ticket, is admitted; anything else gets `401`. Peer credentials and Basic auth
do not open the world. Open renderer sockets end when sessions are revoked or a
guest visit ends. The check covers PortOS's own listeners only, not direct
access to the sequencer's `:8940` port.

An optional legacy bridge on `:5563` still starts with the host (HTTPS when a
machine certificate is present) for ExternalLink / direct access on the box.
The iframe prefers the same-origin path; the single escape is a plain-HTTP page
in front of an HTTPS-only host certificate that does not cover the hostname
(loopback `:5553` / some Vite setups), where the iframe falls back to a direct
`:uiPort` load — scene renders, handshake stays dormant.

**World only / Open Eidoverse alone** opens `/eidoverse/solo` — a chromeless
PortOS route that mounts the **same** `/eidoverse-host/` iframe fullscreen
(outside the app sidebar). A top-level Safari tab aimed at `/eidoverse-host/`
can stick on the renderer splash; staying inside PortOS reuses the proven iframe
path through a single-port tailcat forward.

Projection protocol and asset preflight target the same runtime. The default
HTTP library origin is derived from `EIDOVERSE_WS_URL` by mapping `ws`/`wss` to
`http`/`https` on the same host and port. Deployments whose one Eidoverse runtime
publishes separate WebSocket and HTTP endpoints may set `EIDOVERSE_HTTP_URL`
explicitly; both values must identify that same runtime.

## PortOS bridge boundary

The hosted page, identity bridge, projection service, and CoS tools are explicit
PortOS adapters across the two projects' public protocols. They remain
deterministic and install-local: opening PortOS does not call an AI provider,
and no raw Eidoverse world log is copied to another machine by federation.


## Object labels, aliases, and the saved legend

PortOS emits a generic `comp.label` beside each owned object's `comp.portos`:
`{name, description?, visibility: 'nearby' | 'always' | 'inspect', offset?}`.
District and world landmarks use `always`, bounded by the renderer's range;
live indicators use `nearby`; walkway markers use `inspect`. Ordinary refresh
adds labels to existing worlds. One projector helper updates the label and the
saved object legend together, including stale retained indicators. Repeating an
unchanged projection emits no label verbs. Removed managed entities take their
labels with them; foreign entities and their labels are preserved.

**World controls → Districts & Data** shows the last successful projection by
district: semantic name, meaning, label mode, model path, and resolution reason.
Search matches and catalog/recipe fallbacks are explicitly called fallbacks.
A retained model whose path differs from the current resolution lock reports
unverified provenance. The link to **Appearance & Assets** uses the existing
asset override, refresh, and reset controls. The legend remains readable with
floating labels off and on older renderers. Agent-tool, scheduled-job, and boot projection results use the service's compact
response: operation summary, object count, and presence. The full legend remains
in saved projection state for the drawer.

Optional aliases name individual live indicators using stable opaque resource
keys, never private record IDs or titles. The configuration accepts at most 128
aliases, each plain text of at most 72 characters. Clear the field to restore
the generic label. Every alias field displays its opaque resource reference,
including when multiple objects share a display name. Aliases for absent objects
remain editable in **Saved aliases without a current object**, so users can free
slots without resetting a district or losing aliases during a temporary outage.
Saving an alias explicitly publishes that display text into
the private world's append-only history; removing it changes the current label,
not older history. Asset resets preserve aliases; district/all resets clear the
matching aliases. Migration 343 upgrades existing config to schema V3, preserving
custom recipes and asset locks, and initializes an empty alias map without
reading private records. No config seed or raw-data backfill ships. Older PortOS
versions reject the newer config schema rather than discarding the aliases.

## Renderer capabilities and frame contract V1

The external Worlds checkout remains the sole renderer. Its half of this
contract shipped in
[Worlds issue 5](https://github.com/atomantic/eidoverse-worlds/issues/5) and
[Worlds issue 7](https://github.com/atomantic/eidoverse-worlds/issues/7).
End-to-end label/picking/touch/keyboard acceptance requires that companion;
producer and frame-contract tests alone do not establish it, so
`scripts/eidoverse-frame-acceptance.mjs` drives the whole exchange against a
disposable synthetic world in a real browser. It is deliberately outside CI —
it needs the installed checkout, Bun, Playwright and a real Chrome — and it
never touches the install's own world under `data/eidoverse/worlds`.

`GET /version` advertises independently versioned capabilities alongside its
existing build identity:

```json
{"sha":"example-build","commitTime":"2026-01-01T00:00:00Z","capabilities":{"objectLabels":1,"portosNavigation":1,"labelPreferences":1}}
```

Missing, malformed, or unknown capability versions do not block projection.
The drawer shows an update/reload action when label support or the frame bridge
is unavailable. Updating the managed checkout preserves PortOS design settings,
explicit aliases, and asset overrides. The actual frame handshake takes
precedence over the server capability report, so a stale browser bundle cannot
pretend it supports the updated runtime.

After each iframe load, PortOS posts to its **exact hosted origin**:

```json
{"type":"portos:connect","version":1,"nonce":"fresh-opaque-session","capabilities":{"portosNavigation":1,"labelPreferences":1,"identityRenameRequest":1},"labelVisibility":"nearby"}
```

The renderer validates `event.source === parent` and the embedding PortOS origin,
then replies to that exact origin with `eidoverse:ready`, echoing `version` and
`nonce` and advertising its supported capabilities. The renderer must obtain
the expected parent origin from its trusted embedding configuration; accepting
an arbitrary opener as the parent is not sufficient.

**PortOS supplies that configuration.** The renderer reads it from
`GET /embed-config`, which PortOS answers itself rather than forwarding: on the
same-origin `/eidoverse-host` mount (and the root allowlist proxy) the
`parentOrigin` is the full browser `Host` including a non-5555 forward port
(e.g. `http://127.0.0.1:15555`); on the legacy `:5563` bridge it is the PortOS
page origin (hostname + API port), not the bridge port. The checkout's static
`EMBED_PARENT_ORIGIN` is deliberately left unset, because one install is
reachable as `localhost`, as a LAN address and as a MagicDNS name, and a single
configured origin could only ever match one of them — an unmatched origin leaves
the frame bridge silently dormant. A request whose `Host` is unusable resolves
to no embedder rather than to a repaired guess, since the browser compares
origins with `===` and a repair would be a silent mismatch at handshake time. Each later message carries
the same version and nonce. A reload invalidates the prior session. Unsupported
clients simply ignore the handshake and continue rendering.

For a user-triggered **Open in PortOS**, the renderer sends
`{type:'eidoverse:navigate', version:1, nonce, entityId, route}`. PortOS requires
all of: the current iframe window, its exact origin, the current nonce, a V1
navigation-capable handshake, an entity present in the saved projection legend,
and exact equality between the requested route and that object's known PortOS
section route. Only the fixed source-section routes (plus `/eidoverse`) are
allowed. URLs, query strings, encoded/relative paths, record payloads, and
unknown entities cannot navigate. No URL proxy is exposed.

When both sides advertise `identityRenameRequest: 1`, `/name <new name>` and
`/rename <new name>` in the home-world renderer send
`{type:'eidoverse:identity-rename', version:1, nonce, name}`. PortOS accepts the
request only from the current iframe window, exact hosted origin, and current
nonce, and only for a trimmed 1–64 character name without control characters.
The request stages the existing World Design human-name field and opens its
Experience tab; it cannot write configuration, change an actor id, or rename a
live session. **Save and project** uses the normal validated configuration path,
reconciles presence, and re-enters the world with the saved URL identity. Older
renderers keep the manual World Design flow. Standalone, authenticated, and
guest sessions retain their authoritative identity and receive guidance instead
of sending a host configuration request.

The Eidoverse framework leaves object labels off by default. PortOS explicitly enables
them through its trusted frame session only after the user enables Labels. Each
visit starts with `off`; an older stored always-on preference does not enable
an overlay. The toggle and World controls change only this visit's view.
Labels are positioned over their objects; clicking or tapping one opens its semantic
name and description, with Open in PortOS supplied only by our fork. The old detached
object dropdown and armed inspection buttons are removed.

Floating-label preference is browser-only: `nearby` respects authored modes,
`all-nearby` includes authored inspect-only objects within 60 metres,
and `off` hides floating labels while keeping selected-object details accessible.
PortOS sends `portos:label-preference` with `version`, `nonce`, and
`labelVisibility` only after the frame advertises V1 preference support. A
preference change never sends a world verb or rewrites configuration. The
renderer owns distance culling, object picking, and accessible selected details.

## Related guides

- [Federated guest travel](./eidoverse-guest-travel.md): the wire contract, promote gate, provenance graph, inheritance transport and creative toolkit.
- [Discovery and world controllers](./eidoverse-discovery.md): observation-first discovery and executable world controllers.
- **OpenWorld (retired):** the former `/city` and `/openworld` surface was removed; those URLs redirect to `/eidoverse` and any `data/city-snapshots.jsonl` is inert.
