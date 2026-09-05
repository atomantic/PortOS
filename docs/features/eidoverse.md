# Eidoverse Worlds integration

Eidoverse Worlds is an optional, disabled-by-default PortOS feature. It is not
vendored into PortOS and is not a git submodule. Choosing **Install & enable**
under **Settings → Features** is the explicit consent boundary that downloads,
installs, and enables the runtime; the ordinary feature toggle never installs it.
If Bun is not already available, the same action first runs Bun's official
platform installer under the PortOS service account on Windows, macOS, or Linux.

## What PortOS installs

The installer keeps the two AGPL-3.0 projects as independent git checkouts. The
Worlds repository is selected per PortOS instance; the canonical upstream is
the default, while an instance owner can enter their own fork before installing:

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

After installation, the **Worlds GitHub repository** field remains available on
**Settings → Features**. Updating it changes the installed checkout's `origin`
in place, so the managed-app path, local working tree, and world data stay
untouched. The companion video checkout remains on its upstream repository.

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

Installation does not start the server. Start, stop, logs, updates, and launch
links remain visible on the normal managed-app screen. Plain-HTTP managed apps
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

## World Design V2: Luminous Systems Garden

PortOS ships a versioned world-design recipe, not a one-instance scene. World
Design V2 replaces V1's numbered resource lanes with eight stable semantic
districts:

| District | PortOS meaning |
|---|---|
| PortOS Nexus | Aggregate health, operations, and feature affordances |
| App Terraces | Managed apps and their coarse runtime state |
| Agent Foundry | Active agents and bounded CoS task summaries |
| Goal Observatory | Goals and current-sprint Jira summaries |
| Memory Grove | Category and graph aggregates, never memory bodies |
| Data Vault | Bounded PostgreSQL and file-domain summaries |
| Federation Harbor | Coarse peer availability summaries |
| Activity River | Productivity and recent activity aggregates |

The authored environment is part of the design contract: deep slate/indigo
terrain, a warm dawn `skymesh`, three deliberate lights, restrained fog, and a
sparse wind-reactive field. District anchors have distinct silhouettes and
accent colors. Abstract metrics no longer use generic car meshes. Entity
position is derived from stable source id plus district anchor, so source array
reordering does not move the world around. Goal progress lifts its constellation
beacons, while activity summaries follow a shallow, stable river bend.

The central Nexus light follows aggregate health: cyan is healthy, amber needs
attention, and red is an error. The corresponding health beacon also changes
shape, elevation, and motion, so the status remains legible without color.

Every projected record is normalized to a bounded `WorldSignal` component. It
contains a one-way stable resource key, generic safe label, controlled
status/severity/freshness values, district, PortOS route, disclosure class, and
a shallow set of numeric/boolean metrics. Nested collections become counts and
arbitrary strings are discarded. Apps become a few status-count pylons rather
than one anonymous rack per app; storage becomes two aggregate landmarks plus
bounded anomaly markers; Jira becomes current-work status counts. PortOS never
places raw journal/memory bodies, database or file names, task prompts, ticket
titles, machine/peer identities, or federation records in the Eidoverse log.
The default per-family caps sum below the hard global ceiling, and a user-edited
recipe still cannot materialize more than 48 live PortOS signals.
When authored caps would exceed that ceiling, PortOS allocates one signal per
included current-or-stale source before filling additional slots in
deterministic rounds. The drawer reports the exact per-source omissions instead
of showing a populated source count beside an unexplained empty district.

Only ids under `portos-design-v2-*` and the retired V1
`portos-projection-*` namespace are reconciled. Unrelated Eidoverse entities are
never moved or removed. A temporarily unavailable PortOS source preserves its
last-good entities; a confirmed empty source retires that source's managed
entities. The eight district landmarks, luminous connector nodes, and three
authored lights are infrastructure rather than live records.

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
lazily opens a PortOS-owned HTTP/WebSocket bridge on `:5563` that forwards to
`127.0.0.1:8940`; when a machine certificate is present it serves HTTPS using
the same certificate as `:5555`, which is what avoids browser mixed-content
rejection. Both external repositories stay unchanged. The bridge starts only
when the page is opened, waits for the managed app to answer before mounting the
iframe, and returns an explicit unavailable state when the runtime does not
become ready.

The page embeds through that bridge whenever the bridge's scheme matches the
page's, because the bridge is also what arms the renderer's frame bridge (see
below). The single exception is a plain-HTTP page in front of an HTTPS bridge —
the loopback `:5553` mirror and the Vite dev server — where the shared
certificate does not cover the hostname in use; there the iframe points straight
at `:8940`, the scene renders normally, and the frame handshake stays dormant.

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
{"type":"portos:connect","version":1,"nonce":"fresh-opaque-session","capabilities":{"portosNavigation":1,"labelPreferences":1},"labelVisibility":"nearby"}
```

The renderer validates `event.source === parent` and the embedding PortOS origin,
then replies to that exact origin with `eidoverse:ready`, echoing `version` and
`nonce` and advertising its supported capabilities. The renderer must obtain
the expected parent origin from its trusted embedding configuration; accepting
an arbitrary opener as the parent is not sufficient.

**PortOS supplies that configuration.** The renderer reads it from
`GET /embed-config`, which the bridge on `:5563` answers itself rather than
forwarding: the hostname is the one the browser just used to reach the bridge,
and the scheme and port are PortOS's own. The checkout's static
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

Floating-label preference is browser-only: `nearby` respects authored modes,
`all-nearby` includes inspect-only objects within the renderer's bounded range,
and `off` hides floating labels while keeping selected-object details accessible.
PortOS sends `portos:label-preference` with `version`, `nonce`, and
`labelVisibility` only after the frame advertises V1 preference support. A
preference change never sends a world verb or rewrites configuration. The
renderer owns distance culling, object picking, and accessible selected details.
