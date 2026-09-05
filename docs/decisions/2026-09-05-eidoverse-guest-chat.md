# ADR: Explicit Eidoverse guest conversations may cross registered peers

- **Date:** 2026-09-05
- **Status:** Accepted
- **Related:** [machine-local privacy records](./2026-08-08-privacy-records-machine-local.md), [Eidoverse](../features/eidoverse.md)

## Context

Humans and the Persistent Mind need to visit another connected PortOS world's
shared space and talk to its occupants. Rendering a teleport chamber without a
real guest session does not provide that experience. World chat must not become
a new record-sync channel or silently grant remote construction authority.

## Decision

An explicitly submitted world-chat message and its live replies may cross an
enabled registered peer during a guest visit. This narrow exception includes
participants' chosen in-world display handles. It permits conversation, never
private PortOS records, secrets, automatic context/history exports, or record
contents in status/capability payloads. Credential-shaped text is refused by the
headless guest-chat adapter before transmission. World scene projection remains
aggregate-only; peer names remain in the local PortOS destination controls,
while chambers carry opaque destination keys.

Admission uses the existing private-network and optional-password posture.
The destination requires an enabled registered origin, enabled Eidoverse,
a running compatible renderer, and the resident CoS presence capable of granting
visitor access. Registration is routing consent, not cryptographic proof of a
caller: when the instance password is enabled the existing auth gate also
requires its configured credentials. No path mints a PortOS owner login.

The resident grants a fresh opaque identity `visitor` with generation disabled
before entry. The renderer's explicit guest protocol ignores an existing browser
login, refuses missing visitor grants and ownerless worlds, and restricts
snapshot/scrollback chat to the visit's admission sequence. Guest debug history
is unavailable. This prevents automatic history delivery during the guest flow;
it does not add a confidentiality boundary around the renderer's existing public
world history or ordinary joins. A browser invitation is an expiring bearer ticket in the URL
fragment and yields only the guest identity and renderer port/protocol. The
standalone PortOS guest page skips private settings, catalogs, and owner controls.

Headless visits hold an ephemeral world connection on the destination. Their
session tokens are pinned to the originating registered peer, expire after
30 minutes, and permit only chat reads, bounded sends, and disconnect. The
origin rechecks its peer registration and enabled state on each operation.
The receive buffer holds at most 100 live messages; callers page with a cursor.
Neither session metadata nor chat buffers enter record synchronization or a new
persistent store. The destination's ordinary world log still records authored
chat according to Eidoverse's existing storage policy.

The Persistent Mind and semantic MCP principals need the separate, default-off
`visitEidoversePeers` grant to initiate cross-instance visits and conversation.
`manageEidoverse` retains its install-local meaning. Capability schema 7 and
migration 350 preserve existing grants while adding no new authority on upgrade.
Arrival, polling, and incoming chat never wake an AI provider. A configured Mind
may read/reply during its already-authorized reasoning turns; received text is
untrusted conversation and cannot grant capabilities or authorize tool actions.

## Compatibility

The federation contract is version 1 and requires the renderer's independently
versioned `guestEntry: 1` capability. Unsupported or offline peers are not travel
destinations. The origin obtains URLs only from its saved peer registry and
performs a fresh preflight on departure; it never accepts a destination URL from
an embedded scene or another peer's response. Users update both PortOS and the
Eidoverse renderer on each participating instance before travel becomes available.
