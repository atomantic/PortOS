# ADR: Diegetic FaceTime Is an Optional Story Transport, Never the Session Authority

- **Date:** 2026-08-30
- **Status:** Accepted for a later opt-in experiment; not part of the initial
  hosted release
- **Related:** issue #5385, epic #5377, FaceTime epic #5306, hosted-session
  issue #5383, [PR #5374](https://github.com/atomantic/PortOS/pull/5374),
  [`hostedSession.js`](../../server/services/fableLoom/hostedSession.js),
  [`callSession.js`](../../server/services/voice/callSession.js),
  [`facetimeBridge.js`](../../server/services/voice/facetimeBridge.js), and ADR
  [privacy records stay machine-local](./2026-08-08-privacy-records-machine-local.md).

## Decision

A diegetic FaceTime Audio call is feasible as a **later, macOS-only output and
input transport for one explicit FableLoom story turn**. It is not a second
story-session implementation and it never becomes authoritative for node,
transcript, transition, or character-voice state.

The FableLoom hosted session remains the authority. FaceTime may borrow its
current authored hold phase, receive caller audio through the existing call
host, and play the already-resolved approved character voice through the call
reply device. Browser-hosted play remains the canonical path and the authored
fallback.

The experiment does not ship in this issue. A future implementation must first
introduce one server-side lease for story audio ownership and then expose a
deliberate **Call this character** action at an authored call beat. Starting a
call from story playback, page load, server boot, a timer, or an LLM decision is
forbidden.

## Why this is feasible now

The two contracts #5385 was waiting for are on the default branch:

- #5383 provides an ephemeral, machine-local hosted session; authoritative
  node and playback phase; a revalidated live-conversation gate; half-duplex
  `listening → thinking → speaking → listening`; approved interactive voice
  resolution; and transition commitment after the response is recorded.
- #5380 and #5381 provide approved machine-local voice profiles and the
  `interactive` route. `resolveCharacterVoice()` returns the profile id,
  revision, and engine voice; `synthesize()` accepts that profile id without
  changing project defaults.
- #5307 and #5388 provide the macOS Accessibility helper and strict
  `probe/call/answer/hangup` JSON boundary. The helper matches one configured
  identity, refuses ambiguous surfaces, and uses semantic controls rather than
  coordinate clicks.
- #5308 provides the real-browser call host, BlackHole 16ch input, BlackHole
  2ch reply output, Web Lock, server-side single-host guard, PCM conversion,
  Whisper endpointing, barge-in cancellation, and teardown on host loss.
- PR #5374 proves the bridge can reuse PCM ingestion and endpointing while
  selecting a different orchestration path. Its capture mode also proves that
  shared-device roles must be refused rather than allowed to race.

The small prototype completed with this ADR carries the resolved `profileId`,
`route: 'interactive'`, and `voiceId` into FableLoom live synthesis. That closes
the transport-independent seam: the same synthesized WAV can continue to the
hosted Socket.IO target today and later be addressed to `voice:call:tts` by an
adapter. Designed, cloned, and fine-tuned profiles are not flattened to a
preset voice on either transport.

## macOS and FaceTime boundary

This remains UI automation, not a supported FaceTime call-control API.

- The native helper requires a human to grant Accessibility access in **System
  Settings → Privacy & Security → Accessibility**. PortOS cannot grant or
  bypass it. Apple describes Accessibility access as permission for an app to
  control the Mac: <https://support.apple.com/guide/mac-help/mh43185/mac>.
- Apple documents FaceTime URLs, but its archived URL-scheme reference says
  macOS presents a confirmation before initiating a FaceTime call and labels
  `facetime-audio` native URLs as iOS-only:
  <https://developer.apple.com/library/archive/featuredarticles/iPhoneURLScheme_Reference/FacetimeLinks/FacetimeLinks.html>.
  PortOS's tested helper behavior is therefore an implementation observation,
  not a platform guarantee. A macOS update may change the prompt or AX tree.
- FaceTime requires an Apple Account, network access, and an available audio
  device. Apple documents those prerequisites at
  <https://support.apple.com/guide/facetime/fctm35515/mac>.
- FaceTime lets the user select a microphone and output device. PortOS depends
  on that user-selected route for BlackHole and must never switch it silently:
  <https://support.apple.com/guide/facetime/choose-a-camera-or-microphone-fctm26739220/mac>.
- The browser still needs its own microphone/device permission to enumerate
  and open BlackHole. Permission denial is a normal unavailable state, not a
  reason to weaken the check.
- Incoming calls arrive as notifications and may be answered, declined, sent
  to voicemail, or accepted while another call is active. PortOS automates only
  the single answer control that semantically matches the one configured
  identity. Apple's user-visible behaviors are documented at
  <https://support.apple.com/guide/facetime/fctm35828/mac>.
- This mechanism is appropriate for PortOS's local, user-installed macOS
  integration. It is not represented as an App Store-safe or sandbox-safe
  FaceTime API, and no product contract should depend on unattended calling.

### Identity and confirmations

The first experiment calls only the existing configured identity. It does not
read Contacts, accept an arbitrary number from a loom, or let generated story
text choose a recipient. The configured display name and handle stay in the
machine-local voice configuration.

An outgoing call is requested only after the user activates the authored call
beat and sees the configured display name. Any system FaceTime confirmation
remains visible and authoritative. Canceling or declining it selects fallback;
PortOS does not retry automatically.

Incoming story calls are not automatic in the first experiment. A later inbound
variant may arm a bounded **Wait for my call** beat after explicit consent, for
the one configured identity and while a call host is attached. All other callers
remain indistinguishable from idle, matching the existing helper boundary.

## Ownership and handoff

Call, meeting capture, browser-hosted story voice, and a diegetic call must not
process story audio concurrently. They are different users of two resources:

1. **BlackHole device lease** — one of `call`, `capture`, or
   `fableloom-facetime` may own the call-host devices.
2. **FableLoom conversation lease** — one of `browser` or `facetime` may submit
   the next audience utterance and receive protagonist audio for a hosted
   session.

The future implementation should make those leases a shared server registry,
not another socket-local boolean. Acquisition is fail-closed and atomic within
the one PortOS process. A lease records owner kind, session id, socket id,
acquired time, and an `AbortController`; it contains no handle or contact data.
Disconnect and teardown release by matching owner token so a late disconnect
cannot release a successor's lease.

Browser and FaceTime modes may **hand off**, but they never overlap:

1. Revalidate that the hosted session is active at an authored safe hold with
   an off-screen protagonist and no blocking rendered audio.
2. Pause browser listening and wait for any in-flight turn to reach a phase
   boundary. Do not cancel a completed response or replay it on the call.
3. Acquire the conversation lease for `facetime`; then acquire the device
   lease. If either fails, release the other and resume browser listening.
4. Place and connect the call. The computer may keep playing the authored safe
   hold loop, but the QR/browser microphone stays closed.
5. Route caller PCM into the hosted turn contract. Route only the synthesized
   character WAV to BlackHole 2ch. Commit a story transition once, after speech
   completion or an explicit no-audio fallback.
6. Tear down the call and both leases before reopening browser listening.

The QR guest token and hosted session remain alive during the handoff. The
phone browser receives phase/snapshot updates but cannot submit audio until it
regains the conversation lease. This makes a failed call a transport failure,
not a lost story session.

## Recoverable call state machine

The adapter owns these states; FaceTime's AX observation is evidence, not the
whole state machine:

```text
idle
  -> preflighting
  -> awaiting-confirmation
  -> ringing
  -> connected.listening
  -> connected.thinking
  -> connected.speaking
  -> connected.listening
  -> ending
  -> ended
  -> browser-fallback
```

Terminal outcomes are recorded separately from state:

| Outcome | Evidence | Recovery |
| --- | --- | --- |
| `declined-or-cancelled` | Ringing returns to `idle/ended` before connection | Release leases; resume browser at the same hold |
| `timed-out` | Local ring deadline expires | Best-effort hangup; authored fallback |
| `dropped` | A previously connected call becomes `idle/ended` | Abort STT/TTS; keep the last committed transition only |
| `helper-unavailable` | AX permission, probe, or semantic control fails | Preserve the last known state briefly, then teardown; never infer a decline from `unknown` |
| `host-detached` | Call-host socket or Web Lock is lost | Abort buffers and TTS, hang up, release leases, browser fallback |
| `device-unavailable` | BlackHole preflight or browser permission fails | Do not place the call; browser fallback |
| `user-ended` | Explicit stop/hangup | Graceful teardown and browser resume |
| `story-ended` | Authoritative hosted session ends | Abort, hang up, revoke the QR token, release all leases |

FaceTime does not reliably distinguish every remote reason. PortOS should say
`declined-or-cancelled` or `not-answered`, not manufacture a precise decline
reason from an idle AX tree. Repeated `unknown` probes are a degraded transport;
they never count as remote hangup on the first failure.

## Half-duplex and character voice

The hosted session's phase is the one authority:

- Caller PCM is accepted only in `listening` and only from the current
  conversation-lease owner.
- Once an utterance endpoints, the phase becomes `thinking`; later PCM is
  discarded. The first experiment has no barge-in because the FableLoom
  contract intentionally forbids overlapping voices.
- Before every reply, resolve the character's currently approved profile for
  the `interactive` route. Preserve `profileId`, profile revision, engine/model
  revision, delivery settings, and `voiceId`; do not fall back silently.
- Synthesize once. Address the resulting WAV to the current transport. A
  transport swap never re-runs the LLM or TTS for the same turn.
- Keep the input lease closed until playback completion plus the measured echo
  tail, then return to `listening`.
- Rendered character dialogue blocks the gate on both transports. A silent or
  non-dialogue safe hold may continue on the computer while call audio plays.

## Consent, retention, and privacy

The call beat must explain that FaceTime will carry the conversation and that
PortOS will transcribe it locally. Consent is per attempt; enabling the general
FaceTime feature or starting a QR session is not consent to a story call.

Default retention is deliberately smaller than the general voice call path:

- **Audio:** bounded in memory for endpointing and discarded after STT. Never
  written to disk, journal, Brain, backup, or a peer.
- **Transcript:** ephemeral in the hosted session. Persist final story dialogue
  and chosen transitions only when the hosted-session retention setting already
  allows it. Do not append diegetic calls to the daily journal.
- **Contact:** the configured display name and handle stay in machine-local
  voice settings. No Contacts lookup and no contact value in story records,
  socket payloads, logs, notifications, or provenance.
- **Metadata:** keep only coarse machine-local operational fields needed for
  recovery—a story/session id, timestamps, terminal outcome, and approved voice
  profile revision. Never federate them. Omit the handle and raw AX text.

STT for this path is the local Whisper route used by the call host. The browser
Web Speech API is not an allowed fallback for call audio because it would send
audio to a browser vendor without the story-call consent naming that provider.
FaceTime itself necessarily carries the live call through Apple's service;
that fact must be visible in the consent copy.

## Authored fallback

Every FaceTime call beat must carry a fallback authored against the same
current node. Fallback is selected when the feature is off, the platform is not
macOS, setup or permission is incomplete, the call host/device lease is busy,
the user cancels, the call is unanswered, or teardown occurs before a valid
turn completes.

Fallback order:

1. Resume the existing QR/browser session at the same safe hold and invite the
   audience to speak there.
2. If the guest is disconnected, offer local host input for the same turn.
3. If no live input route exists, play the node's authored non-interactive
   branch. Never generate a replacement scene or call silently.

The fallback must be previewable in authoring and must not be a generic error
screen. A failed call cannot advance the graph unless its authored fallback
explicitly does so.

## Reuse and deliberate non-reuse

Reuse:

- #5307/#5388: setup preflight, native helper, identity matching, strict result
  schema, and semantic AX controls.
- #5308: call-host tab, client audio bridge, BlackHole validation, PCM framing,
  endpointing, reply sink, Web Lock, and host-loss teardown.
- PR #5374: capture-mode proof that PCM ingestion/Whisper endpointing can feed a
  selected orchestration path, plus its fail-closed mutual-exclusion pattern.
- #5383: hosted session, live gate, half-duplex phases, authoritative transcript
  and transitions, reconnect snapshot, echo memory, and approved voice route.

Do not reuse:

- #5309's proactive Mind calling policy or rate budget. A story call is a direct
  user action, not agent authority.
- #5310's auto-answer behavior in the first experiment.
- `callSession`'s general voice persona, tools, barge-in, journal transcript, or
  Mind handoff. The FableLoom turn engine and retention policy stay in control.
- PR #5374's journal/Brain persistence. Its reusable contribution is transport
  capture and ownership, not meeting semantics.

## Follow-up gate

The browser-hosted session and approved character-voice contracts are now
stable, so implementation may be decomposed. Do not file or start the slices
until there is a real-device test environment: a supported Mac with FaceTime
signed in, both BlackHole devices, Accessibility and browser permissions, and a
second configured device.

When that environment exists, split implementation by independently shippable
behavior:

1. shared device/conversation lease registry and hosted-session suspension;
2. explicit authored call beat, preflight, consent, and fallback UI;
3. FableLoom call adapter using hosted turns plus character-profile TTS; and
4. real-device state/recovery validation and privacy/retention controls.

No slice may make an LLM/provider call at boot, place a call without the same
user action, take over an active browser turn, or federate call data.

## Rejected alternatives

- **FaceTime as a second hosted-session engine.** It would duplicate graph,
  transcript, reconnect, and transition authority and make handoff unsafe.
- **Run QR and FaceTime simultaneously.** Distinct microphones do not prevent
  duplicate audience turns, overlapping TTS, or double transition commits.
- **Reuse the general voice pipeline unchanged.** It selects the PortOS persona,
  tools, barge-in, and journal behavior instead of the authored character and
  FableLoom state contract.
- **Automatically fall back to Web Speech STT.** That changes the privacy route
  without call-specific consent.
- **Store the call as a federated story record.** Call audio, contact identity,
  transcript, and operational metadata stay machine-local.
