# Eidoverse Worlds integration

Eidoverse Worlds is an optional, disabled-by-default PortOS feature. It is not
vendored into PortOS and is not a git submodule. Choosing **Install & enable**
under **Settings → Features** is the explicit consent boundary that downloads,
installs, and enables the runtime; the ordinary feature toggle never installs it.

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

## Runtime and data ownership

The managed app uses port `8940` and starts with:

```text
bun --env-file=.env.portos server/server.ts
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
stable fallback from the persisted PortOS instance identity (using the instance
name when available and a non-identifying instance-id-derived label otherwise).
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

## PortOS projection recipe

The PortOS projection is deterministic and local. It turns current PortOS
resources into Eidoverse entities without an LLM call. The default lanes are:

- managed apps, active agents, open CoS tasks, enabled features, and federated
  peer summaries become individual model-backed entities;
- goals and current-sprint Jira tickets become bounded individual entities;
- productivity and activity become compact summary/history entities;
- memory becomes category/graph summaries only (raw memory and journal bodies
  are not copied into the world component payload);
- storage becomes bounded PostgreSQL table and `data/` domain summaries;
- health becomes one aggregate, while operations becomes one compact hub for
  CoS/AI state, review, backup, inbox, notifications, voice, character,
  chronotype, health metrics, and disk state;
- the recipe controls which families are included, per-family caps, layout
  spacing/scales, model assets, and procedural terrain parameters;
- stable entity ids make repeated projections update existing buildings,
  vehicles, crates, drones, and landmarks instead of accumulating duplicates;
- an unavailable source is preserved as unknown and does not delete its last
  good entities; a confirmed empty source may remove the generated entities for
  that family.

The Eidoverse renderer receives the resource label, source id, status, and
bounded fields as generic `portos` component metadata alongside each model.
That keeps the world useful even when a source is sparse and leaves the
Eidoverse scene graph/inspector as the authoritative detail view; the PortOS
adapter does not pretend that arbitrary metadata is a persistent 3D text label.

The Eidoverse page exposes **Project PortOS now** and a recipe editor. The
Persistent Mind and explicitly granted local CoS agents can use the governed
`eidoverse.status`, `eidoverse.project`, `eidoverse.augment`, and
`eidoverse.say` tools. `eidoverse.augment` accepts only bounded world verbs (for
example `spawn`, `place`, `comp`, `light`, `terrain`, `sky`, and `grant`); it
cannot execute arbitrary runtime behavior or modify the installed Eidoverse
source. Status requires bounded PortOS read access; projection additionally
requires the dedicated Eidoverse-management grant, while augmentation and
world chat require that dedicated grant without widening generic PortOS
record-write authority.

## Growth and automation

The projection recipe is intentionally separate from the current world log.
As PortOS gains resources, the deterministic projection runs when the hosted
page opens and can also be run manually, from a CoS task, or through the
disabled-by-default autonomous job
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

Eidoverse itself remains a plain-HTTP service on `:8940`. For an HTTPS PortOS
session, the embedded page lazily opens a PortOS-owned HTTPS/WebSocket bridge on
`:5563`, using the same machine certificate as `:5555` and forwarding to
`127.0.0.1:8940`. This avoids browser mixed-content rejection while leaving both
external repositories unchanged. The bridge starts only when the page is
opened, waits for the managed app to answer before mounting the iframe, and
returns an explicit unavailable state when the runtime does not become ready.

## PortOS bridge boundary

The hosted page, identity bridge, projection service, and CoS tools are explicit
PortOS adapters across the two projects' public protocols. They remain
deterministic and install-local: opening PortOS does not call an AI provider,
and no raw Eidoverse world log is copied to another machine by federation.
