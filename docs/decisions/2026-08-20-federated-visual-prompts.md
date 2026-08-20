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

4. **The counterparty is not an anonymous third party.** A federation peer is an
   explicitly registered instance the local user added by hand, authenticated by
   a per-peer Basic credential, and reachable only on a private network —
   typically the same user's own other machine. This is what makes the carve-out
   scoped rather than general: it authorizes sending a prompt to *a machine the
   user enrolled*, not to the internet, and not to a cloud provider's account.

5. **Unattended routing does not widen this boundary.** A configured route names
   one peer, one kind and one model; the operator opts in per kind, exactly as
   they opt in per job today. What changes is review cadence, not audience — the
   same prompts go to the same enrolled machine. An unattended route may never
   fan out to peers the user did not name, may never fall back to a different
   peer on failure, and may never relax rules 1–3.

6. **Unattended routes require a tailnet peer.** Where an interactive render is
   routed by a human who picked that peer for that job, a standing route exports
   every future prompt of its kind without review, so a misconfigured
   counterparty is a permanent leak rather than a one-time one. `peerFetch` sets
   `rejectUnauthorized: false` ("Tailnet is the trust boundary"): between two
   tailnet nodes WireGuard already supplies mutual authentication, but a
   plain-LAN or non-`.ts.net` peer gets **no server authentication** — nothing
   proves the far end is the machine the user enrolled. That is an acceptable
   risk for a per-job human decision and not for a standing one. When unattended
   routing ships, configuring a route to a peer that
   `peerRequiresTailscale()`-style detection does not recognize as a tailnet host
   must be refused, naming the reason. Interactive routing is unchanged.

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

- **Require the instance password before any prompt crosses.** Rejected as a
  gate, kept as good practice. Authentication is opt-in and off by default
  (`CLAUDE.md`, Security Model), so making it a precondition would either block
  the feature for most installs or, worse, invite an "if unset, send anyway"
  fallback. The tailnet requirement in rule 6 is the narrower gate that actually
  binds the risk unattended routing adds.

- **Forbid federated visual rendering entirely.** Rejected: it deletes the
  feature to protect data from the user's own second machine, which is where the
  data already lives — the peer is enrolled precisely because it is trusted with
  this project's work.

## Consequences

- The flat "no PII on federation" rule in `CLAUDE.md` now reads with one scoped
  carve-out attached: *submitted job bodies for image/video rendering*. The
  privacy-records ADR cross-references this record so the two are read together.
  Privacy Center records remain machine-local and unaffected — nothing here adds
  a federated kind, a sync category, or a wire version.
- The schemas and route branches stop restating the rationale inline and point
  at this ADR instead, so the argument lives in one place and a reviewer's
  objection has a citable answer.
- Implementing rule 6 means `peerRequiresTailscale()` (currently module-private
  in `server/services/instances.js`) has to become reachable from wherever an
  unattended route is validated. That is left to the slice that ships unattended
  routing rather than exported ahead of a consumer.
- Any future federated kind must be classified against rules 1–3 before it
  ships: is its payload a *submission* (may carry what the work is) or a *status*
  (may not carry anything)? A kind whose free-form content has a privacy-safe
  canonical form should adopt audio's pattern rather than the visual one.

## Revisiting

This carve-out is scoped to submitted image/video job bodies travelling to an
enrolled peer on a private network. Widening it — input-asset transfer, routing
to peers the user did not enroll, relaying through a non-PortOS service, or any
path where the counterparty is not the user's own registered instance — requires
a new ADR, not a reading of this one.
