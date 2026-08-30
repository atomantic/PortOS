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

## Runtime and data ownership

The managed app uses port `8940` and starts with:

```text
bun --env-file=.env.portos server/server.ts
```

Installation does not start the server. Start, stop, logs, updates, and launch
links remain visible on the normal managed-app screen. Managed updates pull both
the selected Worlds checkout and its companion video runtime before using Bun's
frozen lockfile rather than npm.

Durable Eidoverse world logs live at `data/eidoverse/worlds`. This is
machine-local `file-primary` data: PortOS backups include it, but PortOS does
not federate it to peers. The git checkouts remain under `data/repos`, which is
the existing re-cloneable repository backup class.

Disabling the feature does not delete repositories, unregister the app, stop a
running process, or remove world history. It only records that this PortOS
instance is not actively using the integration. Destructive uninstall remains
an explicit manual operation.

## Network boundary

This integration is intended for the same private, single-user Tailscale trust
boundary as PortOS. Eidoverse binds its server to the host network and permits
an empty join token; do not expose this configuration to the public internet.
An instance that needs a broader trust model should configure Eidoverse access
control in that project before starting it.

## PortOS bridge boundary

This slice establishes installation and runtime management only. Persistent
Mind presence, agent identity, and dynamic PortOS buildings/assets should be
implemented as explicit adapters across the two projects' public protocols.
They must remain opt-in and must not cause provider calls at PortOS boot.
