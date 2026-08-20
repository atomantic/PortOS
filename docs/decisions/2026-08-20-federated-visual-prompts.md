# ADR: Federated Image/Video Prompts May Cross to a Peer; Status Payloads Never May

- **Date:** 2026-08-20
- **Status:** Accepted
- **Related:** issue #4682 (this record), epic #4348 (federated media providers),
  PRs #4674 / #4676 (the image/video wire and peer-routed renders),
  [`server/lib/validation.js`](../../server/lib/validation.js)
  (`federatedMediaImageJobSubmissionSchema`, `federatedMediaVideoJobSubmissionSchema`),
  [`docs/FEDERATED_MEDIA_PROVIDERS.md`](../FEDERATED_MEDIA_PROVIDERS.md),
  ADR [privacy records machine-local](./2026-08-08-privacy-records-machine-local.md) (#2148).

## Context

`CLAUDE.md` states flatly that **PII must not ride the federation layer at all**,
pointing at the privacy-records ADR. Read literally against the federated media
wire, that rule looks violated: a federated image or video job carries its
`prompt` to the peer as submitted, and a Creative Director / Creative Commission
prompt is generated from project records — it can embed universe canon, character
names, and other personal app data.

Audio is the exception in the other direction. A federated audio submission is
rejected unless its prompt is a canonical string rendered from a fixed
style/mood/instrument profile (`isFederatedMediaAudioPrompt`), and lyrics are
refused outright. That asymmetry is deliberate, but until now it was justified
only by a comment on the schema — so every reviewer who reads the flat rule
against the visual path re-raises the same contradiction, and every answer is
reconstructed from scratch.

This ADR writes the boundary down so the rule and its one scoped carve-out are
readable together.

## Decision

**A submitted job body may carry the prompt the user (or their project) asked to
render. A status or capability payload may never carry prompt or record content.
Those are two different payload classes, and the "no PII on federation" rule
governs the second.**

Concretely:

1. **Image and video prompts cross as submitted.**
   `federatedMediaImageJobSubmissionSchema` and
   `federatedMediaVideoJobSubmissionSchema` accept the prompt (and negative
   prompt) verbatim, bounded only by length. There is no fixed-vocabulary
   re-rendering, because there is no closed taxonomy for arbitrary visual or
   motion content the way audio has a finite style/mood/instrument alphabet. A
   render is *defined by* its prompt; a peer that cannot read the prompt cannot
   do the work at all, so "render this remotely" and "the prompt stays home" are
   mutually exclusive for this kind.

2. **Audio stays fixed-vocabulary.** Music prompts and lyrics are free-form
   natural language whose whole purpose is to carry words, and a finite profile
   alphabet *does* exist for instrumental style. Where a privacy-safe canonical
   form is available at no expressive cost, it is required. Remote lyrical
   conditioning stays unsolved and unshipped (see #4348).

3. **Status and capability payloads stay absolutely prompt-free.**
   `GET /api/federation/media/v1/status` returns allowlisted engine/model pairs,
   readiness signals, queue depth and staleness — never a prompt, a job body, a
   record excerpt, or a filename derived from one. The owner-scoped job
   projection is likewise a sanitized status view. This is the line that must not
   move, and it is the line `CLAUDE.md`'s rule is protecting.

4. **The counterparty is not an anonymous third party.** Sending is gated on
   *local* configuration, not on the peer asking nicely: the peer record must be
   enabled, enabled as a media provider, and carry this exact kind/engine/model
   in the per-peer allowlist the local user configured
   (`assertFederatedMediaProviderSelection`), and a peer credential can only be
   entered locally — never learned from an inbound announce
   (`server/services/instances.js`). On the receiving side the provider surface
   refuses anything that is not a verified Basic credential from an enabled
   registered peer (`authorizeFederatedMediaPeer`), which means an install with
   the optional instance password *off* cannot accept a federated job at all.
   That is what makes the carve-out scoped rather than general: it authorizes
   sending a prompt to a peer this install's own settings enable and allowlist
   for this kind of work, not to the internet and not to a cloud provider's
   account. The *record* alone is not the consent — an inbound announce can
   create an enabled peer row on its own. The allowlist is, because an announced
   peer arrives with no media-provider config and stays refused until the local
   user gives it one.

   Two limits of that identity are real and are not fixed by this ADR: the Basic
   credential authenticates *the install*, not one peer, and the
   `X-PortOS-Instance-Id` header naming which registered peer is calling is
   self-asserted. So the guarantee is "a holder of this provider's instance
   password, on this private network" rather than a cryptographic binding to
   one allowlisted machine — a least-disclosure boundary between cooperating
   peers, as `docs/FEDERATED_MEDIA_PROVIDERS.md` already states. Tightening that
   benefits every federated surface and is tracked with the transport work, not
   here.

5. **Unattended routing does not widen the audience, but it must be gated on a
   tailnet peer.** A configured route names one peer, one kind and one model, so
   the same prompts reach the same allowlisted machine — what changes is review
   cadence. It may never fan out to peers the allowlist does not cover, never
   fall back to a different peer on failure, and never relax rules 1–3.

   One thing does change enough to need its own gate. A standing route exports
   every future prompt of its kind without a human looking, so a misconfigured
   counterparty is a permanent leak where an interactive mistake is a one-time
   one — and `peerFetch`'s `rejectUnauthorized: false` posture leaves a plain-LAN
   or non-`.ts.net` peer with no server authentication at all (see the HTTPS
   bullet in `CLAUDE.md`). Authentication does not save this: the prompt rides
   the request body, so an impostor holding the connection reads it before it
   fails to answer. When unattended routing ships, a route whose peer is not
   recognized as a tailnet host must be refused, naming the reason (see
   Consequences for why that check needs its own predicate rather than a
   re-export of the probe-deferral one). Interactive routing is unchanged.

### Local input assets are out of scope, and stay out

Init/reference images, keyframes, clips to extend and LoRA weights do not cross
the wire at all: a federated request carrying any of them is rejected with
`400 MEDIA_PROVIDER_INPUT_UNSUPPORTED`. That is a capability limit today rather
than a privacy decision, but the privacy consequence is real — a reference photo
is a far denser personal payload than a text prompt. Input-asset transfer is a
later slice of #4348 and must revisit this ADR before shipping.

## Alternatives considered

- **Render visual prompts from a fixed vocabulary, like audio.** Rejected:
  there is no such vocabulary. Any enum expressive enough to describe an
  arbitrary shot is a natural language, and any enum small enough to be
  privacy-safe cannot express what the user asked for. It would not protect the
  prompt so much as discard it.

- **Strip or redact names before submitting.** Rejected: it makes renders
  silently wrong. A universe's character names are frequently the *subject* of
  the image, so redaction produces a plausible render of the wrong thing —
  the same failure mode the wire already refuses to accept for dropped init
  images.

- **Make the instance password a precondition.** Not an alternative — it
  already is one, on the receiving side. `authorizeFederatedMediaPeer` demands a
  `method: 'basic'`, `authenticated: true` context, and `authGate` only ever
  produces that after verifying the instance password, so a provider running the
  default passwordless posture rejects every federated job with
  `MEDIA_PROVIDER_PEER_AUTH_REQUIRED`. No prompt crosses to an unauthenticated
  install today, and this ADR does not relax that. It also does not make the
  stronger per-peer binding described in rule 4 a precondition — that gap is not
  prompt-specific, so blocking this decision on it would fix nothing here.

- **Forbid federated visual rendering entirely.** Rejected: it deletes the
  feature to protect data from the user's own second machine, which is where the
  data already lives — the peer is allowlisted for this work precisely because
  it is trusted with it.

## Consequences

- Privacy Center records are unaffected: nothing here adds a federated kind, a
  sync category, or a wire version. `CLAUDE.md` and the privacy-records ADR link
  here rather than re-arguing the carve-out, and the schemas and route fields
  stop restating the rationale inline, so a reviewer's objection has one citable
  answer instead of four paraphrases.
- Rule 5's tailnet gate needs a predicate of its own. `peerRequiresTailscale()`
  (`server/services/instances.js`) is the right *shape*, but it is module-private
  and its job is probe deferral — an availability heuristic that a future
  polling-noise fix is free to loosen. Re-exporting it as a security gate would
  let that loosening silently widen this boundary, so the slice shipping
  unattended routing owns a deliberate predicate rather than a borrowed one.
- Rule 3 is enforced, not just asserted: a guard in
  `server/services/federatedMediaProvider.test.js` submits a job per kind and
  fails if its prompt reaches the status payload or either job projection.
- Any future federated kind must be classified against rules 1–3 before it
  ships: is its payload a *submission* (may carry what the work is) or a *status*
  (may not carry anything)? A kind whose free-form content has a privacy-safe
  canonical form should adopt audio's pattern rather than the visual one.

## Revisiting

Widening the carve-out requires a new ADR, not a reading of this one — in
particular input-asset transfer, or relaying through anything that is not a
PortOS instance this install has allowlisted for that kind of work.
