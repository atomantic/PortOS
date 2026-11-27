# Eidoverse Worlds integration

Eidoverse Worlds is an optional, disabled-by-default managed app. **Settings → Features → Install & enable** is the explicit install action, including Bun setup when needed. The feature toggle alone cannot install anything. PortOS keeps independent, licensed checkouts of the configured Worlds origin and the companion video runtime in `data/repos/`. The recommended Worlds source is the PortOS branch of `atomantic/eidoverse-worlds`.

## Runtime and data ownership

PortOS installs Worlds with Bun's frozen lockfiles and writes its ignored `.env.portos` to point at the runtime and world store. The managed app starts the sequencer on loopback port 8940 through `server/lib/eidoverseLoopbackPreload.js`. Its Git tab reports both checkouts, their origins and fork drift. **Update both** pulls each configured source, refreshes Bun dependencies and restarts Eidoverse. **Sync fork only** fast-forwards a supported fork without changing local checkouts. Changing the tracked branch requires a clean checkout and refuses to discard local commits.

When enabled, boot and the hosted page can start the managed app and reconcile the bridge and resident presence. Startup performs no dependency installation, asset download or provider call. Eidoverse's runtime owns its append-only world log, snapshots, roles, chat and assets in `data/eidoverse/worlds`. PortOS backs up that directory and keeps it machine-local. PortOS bridge state in `data/eidoverse/portos-world.json` owns the selected world, human identity, stable resident CoS identity, recipe and projection checkpoint. The fallback human label is pseudonymous, and owner handoff retires the previous role after the new identity owns the world.

The world is served through the same-origin PortOS host, including the fullscreen `/eidoverse/solo` view. The proxy, renderer WebSocket and optional legacy bridge share admission. They reject cross-origin requests and, on password-protected instances, require an operator session or scoped guest ticket. Valid delegated operator sessions work here. Peer credentials and HTTP Basic do not open the renderer. Keep the sequencer on loopback and PortOS on its private network. The upstream name-based join protocol can accept an empty token, so a directly exposed sequencer would expose world authority.

## PortOS Commons and projection

The design recipe and install-specific asset lock are separate from the saved world log. The launch view reconciles a deterministic projection of bounded, opaque local signals into the Commons districts. The collector reads sources during explicit projection, and pure signal and projection owners derive aggregates and world verbs. Private source records and machine labels stay out of the projection. Projection may also run by explicit request or the disabled-by-default `job-eidoverse-projection`. Missing runtime or assets surface as unavailable, and an unattended run requires an available managed app.

Assets are resolved against the same runtime that accepts projected writes. The renderer advertises versioned capabilities for object interactions, frame transitions and guest entry. Older builds retain the compatible fallback for optional UI controls. User-authored object labels, aliases and the legend are kept separately from generated placement. Disabling the feature hides its navigation and automatic startup. It does not uninstall the managed app, erase world state or disarm separately configured jobs.

For end-to-end renderer acceptance, run `node scripts/eidoverse-frame-acceptance.mjs` with the Worlds and Video checkouts, Bun, Playwright and Chrome installed. It exercises the browser frame handshake, labels and interaction against a disposable synthetic world and keeps the install's saved world untouched.

## Federated guest travel

Use a chamber at the **Federation Terminal** or the destination buttons above the world. Connected, guest-capable peers have their own destination chambers. The source closes its renderer presence before opening the destination guest page, using renderer acknowledgement when available. The resident CoS presence stays at home. Both installs need guest-capable runtimes and the receiving host's resident presence enabled.

Guest admission checks the saved peer and current capabilities and issues a bounded visitor identity. The 30-minute admission ticket and scoped HttpOnly cookie admit only the Eidoverse guest renderer. They grant no PortOS API, data, construction or host authority. A visit ending, expiring or losing its peer closes the guest sockets. Guest chat is bounded to live visit messages and carries no saved transcripts or private records. Incoming chat grants no permissions and triggers no provider call. See the [guest chat ADR](../decisions/2026-09-05-eidoverse-guest-chat.md).

Mind travel uses the separate, default-off `visitEidoversePeers` grant. `eidoverse.destinations` lists eligible peers, `eidoverse.visit` opens a visit by opaque peer ID, `eidoverse.visit-chat` reads cursor-based replies or sends a message, and `eidoverse.leave` ends the visit. The independent `manageEidoverse` grant governs local world writes. An eligible visit sees the destination's local vernacular world.

## Foundations and inheritance

Authored foundations start in the install's local vernacular ledger. Style stays local. Shared-baseline promotion is an explicit local act and requires successful agent-free resilience evidence against the eligible structural body. Packaging rejects local style, unsafe references and content lacking the required provenance. Publishing creates a versioned peer-visible projection of the approved foundation, separate from the live world log. The owner can withdraw publication before deleting the owned foundation.

Peers discover and pull only the permitted package. Inheritance validates the before-write wire shape, records the origin and transport peer separately and puts the copy in a disjoint peer namespace. Imported data never shadows local foundations, never executes the sender's code and cannot be re-promoted from this install. Lineage ties authored, assayed, packaged, promoted and inherited records to their recorded evidence. See the [foundations ADR](../decisions/2026-09-18-federated-eidoverse-foundations.md).

The creative toolkit lists local styles and deterministic seeded layouts. `eidoverse.place-layout` computes live scene operations and `eidoverse.draft-foundation` computes a draft input. Recording a seeded district template recomputes placement from layout and anchor. Applying operations, recording a draft and publishing a foundation are distinct actions.

## Discovery and world controllers

`eidoverse.observe` summarizes places from the resolved recipe, peer destinations, inherited provenance, controller attention and changes since the Mind's last observation. It distinguishes a disabled source, an unavailable observation and a genuinely empty result. A saved visit marker gives later observations their comparison point.

Controllers select PortOS-shipped definitions by ID and store state and config as data. The supervisor only runs a synchronous deterministic step over validated config and state. It checks returned invariants and never calls a provider. Effects are bounded proposals. World delivery requires its own opt-in, and a failed delivery is recorded without repeating the step. Repeated failures, missing definitions or incompatible saved config disarm an install. Scheduler arming reconciles when changed, and missed intervals do not replay a backlog.

See [API Explorer](../API.md) for live operations, [private peer administration](peer-administration.md) for federation setup and [Eidoverse Video](../EIDOVERSE_VIDEO.md) for capture and replay workflows.
