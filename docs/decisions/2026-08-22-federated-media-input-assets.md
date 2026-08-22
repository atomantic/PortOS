# ADR: Conditioning Crosses to an Allowlisted Peer; Weights and Chain State Do Not

- **Date:** 2026-08-22
- **Status:** Accepted
- **Supersedes (in part):** the "Local input assets are out of scope, and stay
  out" section and rule 2's closing sentence of ADR
  [federated visual prompts](./2026-08-20-federated-visual-prompts.md), which
  named both as decisions to be revisited by a later ADR. Rules 1, 3, 4 and 5 of
  that ADR are unchanged and still govern.
- **Related:** epic #4348 (federated media providers),
  [`server/lib/federatedMediaWire.js`](../../server/lib/federatedMediaWire.js),
  [`server/lib/validation.js`](../../server/lib/validation.js),
  [`docs/FEDERATED_MEDIA_PROVIDERS.md`](../FEDERATED_MEDIA_PROVIDERS.md),
  ADR [privacy records machine-local](./2026-08-08-privacy-records-machine-local.md) (#2148).

## Context

Federated media rendering shipped text-to-image, text-to-video and instrumental
text-to-audio. Four items were deliberately left undecided rather than
unimplemented, and each one has been re-raised by a later review because there
was no record saying which way it went:

1. **Input-asset transfer.** An init image, a reference image or a start/end
   video frame is refused with `400 MEDIA_PROVIDER_INPUT_UNSUPPORTED`. That
   makes every image-to-image, reference-conditioned and keyframed render
   local-only, which is exactly the work a user offloads to the GPU peer.
2. **Remote lyrical conditioning.** A federated audio submission is instrumental
   only. The flagship federatable audio model (MiniMax Music 3) is a *lyrical*
   model, so the one thing worth sending it is the one thing the wire refuses.
3. **Multi-provider fairness / failover.**
4. **A fixed-vocabulary "visual profile"** as a privacy-preserving substitute
   for a free-form image/video prompt.

The prior ADR settled the general shape — a *submission body* may carry what the
work is; a *status payload* may carry nothing — but explicitly reserved (1) and
(2) for a new ADR, because both widen what a submission body contains rather
than merely restating rule 1. This ADR decides all four.

## Decision

**Conditioning is part of the submission, and crosses under the same gate as the
prompt. Model weights and multi-step chain state are not conditioning, and do
not cross at all.**

### 1. Conditioning images cross as uploaded assets

An init image, reference images, and a video start/end frame are what the render
is *of*. Rule 1 of the prior ADR already answered the general question for
prompts — "a peer that cannot read the prompt cannot do the work at all" — and
an image-to-image render is the same argument with a denser payload: a peer that
cannot read the init image cannot perform an image-to-image render, so "render
this remotely" and "the source image stays home" are mutually exclusive for that
mode, exactly as they were for the prompt.

The denser payload does change the *mechanism*, not the *authorization*:

- Bytes travel through a dedicated, authenticated provider endpoint
  (`POST /api/federation/media/v1/assets`), never inline in a job body and never
  as a filesystem path. The upload declares its SHA-256 and the provider
  verifies it before storing, so a truncated or altered transfer fails rather
  than rendering something subtly different.
- The provider stores an uploaded asset **caller-scoped**, keyed by content
  hash, in a staging area outside every user-facing media root, with a bounded
  TTL and an explicit size and MIME allowlist. Re-uploading identical bytes is
  idempotent, which is what makes a reconcile after a restart free rather than a
  second multi-megabyte transfer.
- A provider advertises whether it accepts input assets at all, and with what
  limits, on its capability projection. **Absent reads as unknown, never as
  supported** — an older provider that has never heard of the field keeps
  refusing conditioning, and a consumer that cannot see the field refuses to
  send it. That is the same fail-closed rule the queue-capacity fields already
  follow.
- Every existing gate still applies unchanged: the peer must be registered,
  enabled, enabled as a media provider, allowlisted for this exact
  kind/engine/model, authenticated with a verified Basic credential, and — for a
  standing unattended route — recognized as a tailnet host (rule 5 of the prior
  ADR). Conditioning does not get its own weaker path.

### 2. Lyrics cross; the instrumental style prompt still does not

Rule 2 of the prior ADR required a privacy-safe canonical form *where one is
available at no expressive cost*, and closed by noting that remote lyrical
conditioning stayed unsolved. It is not unsolved so much as mis-framed: the
qualifier was doing all the work, and lyrics fail it.

A style/mood/instrument profile renders an instrumental prompt with no
expressive loss, so the fixed-vocabulary requirement stays exactly as it is for
`prompt`. **Lyrics have no such form.** Lyrics *are* the words; there is no
alphabet that encodes them without discarding them, which is the same reason the
prior ADR rejected a fixed vocabulary for visual prompts. So lyrics cross
verbatim under rule 1's logic, bounded by length and gated on the provider
capability already advertising `lyrics: true` for the selected model.

The consequence for persisted state is deliberate and is called out here because
it reverses an earlier comment: the remote audio marker now stores the lyrics it
will submit, exactly as the image and video markers already store their prompts.
Keeping them out was what made a routed audio job unable to carry the
conditioning it was routed to produce.

### 3. Model weights do not cross

A LoRA is not conditioning — it is a model. The issue that opened this work
lists **remote model installation and automatic model downloads under Out of
scope**, and nothing here changes that: a provider renders with the models its
operator installed and allowlisted, and a consumer selects from that
advertisement. A per-job weight upload would be a model-distribution channel
wearing a conditioning costume — unbounded in size, persistent in effect on the
provider, and outside the capability contract that makes provider selection
honest.

A federated request naming LoRA weights therefore keeps failing closed with
`MEDIA_PROVIDER_INPUT_UNSUPPORTED`, naming the weights as the reason. The
supported path for a user who wants remote LoRA rendering is to install the LoRA
on the provider and allowlist a model that uses it.

### 4. Multi-step chain state does not cross

A source video to extend, chained chunks, and IC-LoRA video references are not
single-render conditioning: they are the state of a multi-step pipeline whose
steps the consumer sequences. Sending them would make the provider a
partial owner of a chain it cannot see the rest of, and it re-opens the failover
question in the middle of a sequence. These stay local, refused with the same
typed code.

### 5. Multi-provider fairness and failover: won't-do

Declined, not deferred. Automatic load balancing is listed under **Out of scope**
on issue #4348, and automatic failover directly contradicts the fail-closed
routing decision taken in #4679: a job that silently re-targets a different peer
on failure has changed both *where the user's data went* and *which model
produced the result*, without anyone seeing it happen. Both are exactly the
outcomes the explicit-selection contract exists to prevent.

If a future need for this appears, it needs a decision about routing policy and
idempotent re-submission first, and its own ADR — reopening it as an
implementation detail is what this entry exists to prevent.

### 6. A fixed-vocabulary visual profile: won't-do

Declined. The prior ADR already rejected it under Alternatives considered — "any
enum small enough to be privacy-safe cannot express what the user asked for… it
would not protect the prompt so much as discard it." It is recorded here only
because it kept resurfacing as an open item on #4348 after that ADR settled it.

## Alternatives considered

- **Inline the asset in the job body as base64.** Rejected: it inflates the
  payload by a third, forces the whole conditioning set through the JSON body
  size limit, and makes an idempotent replay after a restart re-send every byte.
  A separate content-addressed endpoint gets deduplication and integrity checking
  for free.

- **Let the provider fetch the asset from the consumer by URL.** Rejected: it
  inverts the connection direction the federation transport is built around
  (the consumer holds the peer credential and initiates every hop), and it would
  require the consumer to expose an unauthenticated or separately-credentialed
  asset surface to a peer. Push, authenticated by the same credential as every
  other hop, adds no new inbound attack surface.

- **Keep refusing conditioning and tell users to render locally.** Rejected: it
  is the status quo, and it removes remote rendering from precisely the workloads
  where offloading matters most. The peer is allowlisted for this work because
  it is trusted with it — a reference image is denser than a prompt, but it is
  the same trust boundary and the same machine.

- **Strip or downscale the asset before sending.** Rejected for the same reason
  the prior ADR rejected redacting names from prompts: it makes the render
  silently wrong. A conditioning image that arrives altered produces a plausible
  render of something the user did not ask for.

- **Allow lyrics only when the consumer confirms per render.** Rejected as
  security theater on top of a decision already made locally: enabling a peer as
  a media provider and allowlisting a lyrical model for it *is* the consent, and
  a second prompt on every render trains the user to click through it.

## Consequences

- The wire stays **version 1**. Every field this decision adds is optional in
  both directions, and absence reads as *unsupported*, so an older provider and
  a newer consumer (and the reverse) both degrade to the pre-existing
  text-only behavior instead of failing. No `SCHEMA_VERSIONS` bump is warranted:
  no record kind, sync category, or federated record shape changes.
- Rule 3 of the prior ADR is untouched and its guard still holds: status and
  capability payloads carry counts, readiness and limits — never a prompt, never
  lyrics, and never an asset, a filename, or a hash derived from one. The
  capability's input-asset block is limits only.
- A provider now accepts inbound bytes, which it did not before. The staging
  area is caller-scoped, size-capped, MIME-allowlisted, content-hash-verified,
  TTL-swept, excluded from backups, and outside every media root the gallery or
  the sync layer reads — so an uploaded asset can never be mistaken for local
  user content or federated onward as a record.
- "Is this conditioning, a model, or chain state?" is the question any future
  federated input must answer. The three answers above are the precedent, and
  the second and third are refusals rather than gaps — a reviewer finding
  `MEDIA_PROVIDER_INPUT_UNSUPPORTED` on a LoRA is looking at a decision, not a
  to-do.

## Revisiting

Rules 3 and 4 are refusals with stated reasons; changing either needs a new ADR
naming what changed about the reason. Rule 1's mechanism may be extended to
further conditioning *kinds* under the same gate without a new ADR, provided the
new kind is single-render conditioning rather than a model or chain state, and
provided it keeps the capability-gated, hash-verified, caller-scoped, TTL-bounded
transfer described above.
