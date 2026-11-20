# FableLoom character, voice, and hosted-production continuity

## Status and objective

This is the decision-complete architecture for taking a linked Universe Bible
through consistent character production, repeatable character voices, and a
two-device hosted FableLoom experience. It complements, rather than replaces,
the visual-conditioning design in
[`2026-08-29-fableloom-visual-continuity.md`](./2026-08-29-fableloom-visual-continuity.md).

The target experience has four hard constraints:

1. A character must retain recognizable identity, wardrobe, props, voice, and
   speech behavior across a feature-length or episodic production.
2. All visible story material is pre-rendered. Runtime AI never has to generate
   or lip-sync video.
3. In hosted mode, a viewer joins from a phone by QR code and speaks to the
   protagonist only during authored off-screen conversation windows.
4. The protagonist and viewer are half-duplex: only one speaks at a time, and
   live protagonist speech never overlaps rendered character dialogue.

## Tracking issues

The implementation program is tracked by
[epic #5377](https://github.com/atomantic/PortOS/issues/5377):

- [#5378](https://github.com/atomantic/PortOS/issues/5378) — approved Universe
  character production packages;
- [#5379](https://github.com/atomantic/PortOS/issues/5379) — visual canon
  bindings and capability-aware conditioning;
- [#5380](https://github.com/atomantic/PortOS/issues/5380) — machine-local
  Kokoro/Piper character voice profiles;
- [#5381](https://github.com/atomantic/PortOS/issues/5381) — Qwen3-TTS voice
  design, consented cloning, and optional fine-tuning;
- [#5382](https://github.com/atomantic/PortOS/issues/5382) — entry, hold-loop,
  and transition playback assets;
- [#5383](https://github.com/atomantic/PortOS/issues/5383) — scoped QR-hosted
  sessions and half-duplex protagonist voice;
- [#5384](https://github.com/atomantic/PortOS/issues/5384) — episodic production
  orchestration and continuity review; and
- [#5385](https://github.com/atomantic/PortOS/issues/5385) — a non-blocking
  future investigation of diegetic FaceTime calls.

## Executive decision

Reliable consistency does not come from one prompt, seed, model, or reference
image. PortOS should make every character a versioned production package with
four coordinated layers:

1. **Portable canon** — identity, speech, and performance intent in the
   Universe character record.
2. **Approved source assets** — curated identity views, wardrobe views, voice
   samples, and pronunciation anchors.
3. **Machine-local adapters** — character LoRAs and voice-engine artifacts,
   resolved by Universe and character ids rather than stored in federating
   records.
4. **Per-shot state** — wardrobe, expression, injuries, carried objects,
   location state, dialogue, and the prior shot that actually leads here.

The production path is therefore:

```text
Universe character
  -> approved visual identity pack + approved voice profile
  -> scene bindings and continuity state
  -> locked storyboard keyframe
  -> short image-to-video shot
  -> separately rendered dialogue / performance / mix
  -> provenance-backed playback asset

Hosted FableLoom node
  -> entry clip
  -> silent/off-screen hold loop
  -> phone listening turn
  -> in-character LLM response
  -> the same approved character voice
  -> transition clip or next node
```

Text-to-video remains useful for drafts and non-canon inserts. A canon-locked
character shot starts from an approved still or reference-conditioned image;
the video model animates the shot instead of rediscovering the cast.

## Research findings

Current production tools converge on the same workflow PortOS is already close
to supporting:

- **Named, reusable identity references.** Runway Gen-4 References accepts up
  to three references and recommends a neutral, evenly lit subject image; its
  documented workflow is to iterate a character or environment into new scenes
  while retaining the saved reference identity. See [Runway Gen-4
  References](https://help.runwayml.com/hc/en-us/articles/40042718905875-Creating-with-Gen-4-Image-References).
- **Reference-conditioned short video.** Veo 3.1 exposes image-to-video, up to
  three subject references, first/last-frame interpolation, and extension.
  Those are separate conditioning roles, which supports PortOS's decision to
  type references instead of sending an unordered image pile. See [Veo 3.1
  video generation](https://ai.google.dev/gemini-api/docs/veo).
- **Lightweight identity fine-tuning for a recurring cast.** LoRA/DreamBooth
  adapts a base image model with a small portable weight set; Hugging Face's
  current Diffusers documentation treats it as the memory-efficient
  personalization path. See [Diffusers DreamBooth
  training](https://huggingface.co/docs/diffusers/training/dreambooth). PortOS
  already implements local FLUX character-LoRA dataset creation, training,
  checkpoint comparison, and local character resolution.
- **Reference adapters when training is unnecessary.** PhotoMaker's official
  implementation describes stacked identity embeddings, multiple identity
  images, and composition with ControlNet, IP-Adapter, and character LoRAs.
  This is useful as a capability class for future local backends, not as a
  second PortOS character registry. See [PhotoMaker](https://github.com/TencentARC/PhotoMaker).
- **Performance is a separate source from appearance.** Runway Act-Two takes a
  character reference plus a driving performance and transfers speech,
  expression, and motion. This supports rendering or recording the approved
  dialogue performance before the final talking shot instead of trusting a
  video model's invented voice. See [Runway Act-Two performance
  capture](https://help.runwayml.com/hc/en-us/articles/42311337895827-Performance-Capture-with-Act-Two).
- **Modern local TTS can design, clone, fine-tune, and stream.** Qwen3-TTS's
  released Apache-2.0 models include free-form voice design, 3-second rapid
  cloning, fine-tunable base models, instruction control, and streaming in
  0.6B/1.7B sizes. See [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS).
  Chatterbox and F5-TTS are viable evaluation alternatives, but the first
  PortOS integration should prove one new backend thoroughly instead of adding
  several shallow adapters.
- **A phone microphone requires a secure origin.** Browser `getUserMedia()` is
  unavailable on an ordinary remote HTTP page; the join surface must use HTTPS
  and still requires an explicit user permission gesture. See [MDN
  getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).
  Browser audio also needs a user gesture to create or resume an audio context,
  so joining the experience must include a visible **Join and enable audio**
  action rather than trying to start from the QR navigation alone. See [MDN Web
  Audio best practices](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices).

The practical lesson is to lock identity before motion, lock the voice before
dialogue rendering, keep shots short, and record exactly which references,
adapters, models, and settings produced each approved asset.

## Existing PortOS foundation

PortOS already owns most of the primitives this design needs:

| Concern | Existing foundation | Gap |
|---|---|---|
| Character canon | Universe `characters[]` with stable ids, aliases, physical and visual identity, palettes, expressions, gestures, props, wardrobes, `speechAccent`, `speechPattern`, and `voiceId` | No versioned voice-production intent or approval state |
| Visual source assets | `imageRefs[]`, `primaryImageRef`, standard and variant reference sheets | References need typed roles and an approved identity-pack view |
| Identity training | Local character LoRA datasets, checkpointed FLUX training, sidecar registration, and `resolveCharacterLoras()` | FableLoom's continuity compiler must consume the same resolver and expose degraded state |
| Storyboard prompting | Shared canon descriptors, scene matchers, wardrobe-aware scene prompts | FableLoom needs explicit structured entity bindings |
| Video | Image-to-video, first/last frames, multi-keyframes, LTX continuation windows, short-shot history, and IC-LoRA modes | Per-model reference roles and a FableLoom playback-asset contract |
| Offline voices | Kokoro and Piper under one `synthesize()` facade; Universe character `voiceId`; pipeline dialogue extraction and rendering | Preset ids do not represent designed/cloned/trained voices or delivery revisions |
| Live voice | Whisper/browser STT, sentence TTS streaming, VAD, echo suppression, aborts, and Socket.IO transport | Voice turns use the general assistant persona, not a FableLoom character/session state |
| Story runtime | FableLoom graph, automatic cuts, decision loops, helper mode, connected/disconnected scenes, and `playTurn()` | One-device preview only; one `videoHistoryId` cannot express entry/hold/exit assets |

This should be an integration program, not a greenfield media system.

## Character production package

### Portable Universe fields

Keep the existing `speechAccent`, `speechPattern`, and `voiceId`. Add an
optional, bounded `voiceCanon` object to a character:

```json
{
  "voiceCanon": {
    "version": 1,
    "description": "warm low alto; dry texture; controlled breath; intimate rather than announcer-like",
    "defaultDelivery": "measured and observant; short pauses before admitting uncertainty",
    "emotionalRange": ["guarded", "wry", "quietly frightened", "urgent"],
    "avoid": ["radio-announcer projection", "sing-song sentence endings"],
    "pronunciations": [
      { "term": "Aster Vale", "pronunciation": "AS-ter vayl" }
    ],
    "sourcePolicy": "designed"
  }
}
```

`sourcePolicy` is one of `designed`, `consented-performance`, or `licensed`.
It records the production posture without putting a performer's identity,
contract, or reference recording into a federated Universe record.

The portable fields describe the character's voice. They do not name a model,
filesystem path, provider account, or trained artifact. Existing `voiceId`
remains the backward-compatible preset fallback until a local voice profile is
approved.

The visual side uses the `visualCanon` scene binding and typed asset roles
specified in the companion visual-continuity plan. The Universe editor should
present those assets as an **Identity pack**:

- neutral face/primary identity;
- three-quarter and profile identity views;
- full-body front/side/back proportions;
- expression and gesture sheet;
- one approved image per recurring wardrobe;
- signature prop and scale views;
- negative identity notes: features that must not appear or change.

The pack is a curated view over existing managed assets. It is not another
character database. Generated images remain candidates until the user approves
them; only approved assets may satisfy a canon-locked render.

### Machine-local voice profile

Create `voice_profiles` as machine-local metadata with managed files under
`data/voice-profiles/<profileId>/`. The metadata is an app-native record and
should be DB-primary; reference audio, previews, and engine artifacts are files
addressed by safe basenames. Add both to `docs/STORAGE.md`. Source recordings
and locally trained artifacts are user-created and must be backed up; do not add
them to default backup excludes.

```json
{
  "id": "voice-example",
  "version": 3,
  "binding": {
    "universeId": "universe-example",
    "characterId": "char-example"
  },
  "kind": "designed",
  "engine": "qwen3-tts",
  "modelId": "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
  "modelRevision": "pinned-revision",
  "sourceAssets": [
    {
      "filename": "approved-reference.wav",
      "sha256": "...",
      "transcript": "...",
      "rightsConfirmedAt": "2026-08-29T00:00:00.000Z"
    }
  ],
  "inference": {
    "seed": 42,
    "instructions": "measured, intimate, dry humor",
    "rate": 0.96,
    "pitchSemitones": 0,
    "formantSemitones": 0
  },
  "routes": {
    "studio": { "enabled": true },
    "interactive": { "enabled": true, "maxFirstAudioMs": 900 }
  },
  "mastering": {
    "targetLufs": -18,
    "peakDb": -1,
    "highPassHz": 70
  },
  "approval": {
    "status": "approved",
    "approvedAt": "2026-08-29T00:00:00.000Z",
    "benchmarkRevision": 2
  }
}
```

All values are illustrative. Sanitizers bound strings, arrays, numeric ranges,
and file counts. Exact engine knobs belong in an engine-specific sub-object
when they cannot be mapped honestly to the common fields.

Resolution mirrors character LoRAs:

1. Find an approved local profile matching `(universeId, characterId)` and the
   requested route (`studio` or `interactive`).
2. Otherwise use the character's existing namespaced `voiceId`.
3. Otherwise use the project/system default and report a degraded binding.

Never persist a local `voiceProfileId` onto the federating Universe character.
A peer without the artifact must degrade visibly, not retain a dangling path.

### Voice-engine contract

Extend the TTS facade without breaking Kokoro/Piper:

```js
listVoiceEngines()
// -> [{ id, capabilities: {
//   preset, voiceDesign, instantClone, fineTune, streaming,
//   instructionControl, emotionControl, seed, wordTimings
// }}]

synthesize(text, {
  profileId, route, delivery, signal, stream,
})
// -> audio/stream + engine, model revision, profile revision, timings,
//    effective controls, latency, and degradation warnings
```

Kokoro and Piper implement preset synthesis and remain the zero-setup fallback.
The first richer local backend should be Qwen3-TTS in an isolated, health-probed
Python runtime because one model family covers voice design, cloning,
fine-tuning, instruction control, and streaming under a permissive license.
Integration remains opt-in: model downloads, design runs, cloning, and training
start only after an explicit user action.

Chatterbox, F5-TTS, OpenVoice, and commercial engines can later implement the
same capability contract. PortOS should not expose a control merely because it
exists in the common UI: unsupported emotion, formant, timing, or streaming
controls are disabled with an explanation.

### Voice development workflow

The Universe character editor gets a **Voice lab** beside the current preset
picker:

1. **Start from current local voices.** Audition Kokoro/Piper and approve a
   preset immediately. This provides a working baseline and hosted-mode
   prototype without new models.
2. **Design an original voice.** Convert `voiceCanon` plus user instructions
   into several previews, compare the same benchmark lines, and explicitly
   promote one preview.
3. **Clone a consented performance.** Record or upload clean single-speaker
   material, confirm rights, transcribe it, create an instant profile, and keep
   the source private and machine-local.
4. **Fine-tune when the prototype is not stable enough.** Reuse the LoRA
   training UX pattern: dataset readiness, explicit start, progress, samples,
   checkpoints, cancel, and promotion. The last checkpoint is not assumed to
   be the best.
5. **Calibrate studio and interactive routes.** Prefer the same artifact for
   both. If latency requires a smaller live model, approve it only after an A/B
   benchmark shows the two routes read as the same character.

Each profile has a fixed benchmark script covering:

- the character's name and Universe terms;
- plosives, sibilants, numbers, and difficult consonant clusters;
- calm, amused, frightened, angry, whisper-like, and urgent delivery;
- a short reply and a multi-sentence reply;
- the same line across every promoted revision.

The approval screen records human selection plus objective diagnostics such as
clipping, loudness, synthesis latency, and ASR round-trip errors. Speaker-
similarity scoring may assist review, but it never automatically approves a
voice or rewrites canon.

### Pitch, timbre, and mastering

Pitch and timbre are different controls:

- Use model-native voice design, cloning, or tone-color conversion to establish
  identity and timbre.
- Use delivery instructions for emotion, energy, cadence, and pace.
- Use post-processing pitch/formant shifts only for modest art direction after
  the identity exists. Large pitch shifts without formant preservation sound
  like sped-up/slowed-down audio and should not be presented as voice design.
- Keep EQ, high-pass, compression, de-essing, loudness normalization, and peak
  limiting in the mastering chain. EQ changes brightness; it does not create a
  new character identity.

Probe the installed audio toolchain for pitch/formant support. If a
formant-preserving transform is unavailable, disable that slider with direct
setup guidance rather than silently approximating it with sample-rate changes.
Every rendered line records the pre-master profile revision and the mastering
chain so it can be reproduced.

## Visual and video production workflow

Adopt the companion visual-continuity plan with two additions.

First, a canon-locked shot resolves both the approved identity pack and every
compatible local character LoRA. A reference-only backend, a LoRA-only backend,
and a backend capable of using both report different capability manifests; the
compiler never pretends they are equivalent.

Second, storyboard approval becomes a real production gate:

1. Resolve Universe style, entity ids, wardrobe, props, and current state.
2. Allocate typed reference slots according to backend capability.
3. Apply compatible character adapters and their trigger tokens.
4. Generate several still candidates.
5. Let the author approve one candidate as the shot's locked first frame.
6. Animate that frame with a short image-to-video render.
7. Use a separately approved last frame only when the action or a seamless loop
   genuinely needs one.
8. Use video extension only within one continuous take. A normal edit creates a
   new shot and re-resolves durable canon instead of accumulating drift through
   repeated extension.

Seeds are reproducibility hints, not identity locks. Multi-character shots are
capability-sensitive and generally harder: backends must declare how many
distinct character references they can preserve. A backend that cannot honor
the bound cast blocks a canon-locked render or requires an explicit draft-mode
override.

For pre-rendered on-screen speech, render or record the approved voice first,
then use it as the driving performance for an offline lip-sync/performance pass
when the selected backend supports one. Video-model native dialogue audio is
not the canonical character voice and must not replace the audio-stage render.
Mux character dialogue, ambience, effects, and music as explicit lanes.

## FableLoom playback-asset model

One looping `videoHistoryId` is not sufficient for the hosted experience. Add
an optional `playbackAssets` object to a node while retaining the legacy field:

```json
{
  "playbackAssets": {
    "entryVideoHistoryId": "video-entry",
    "holdLoopVideoHistoryIds": ["video-hold-a", "video-hold-b"],
    "exitByTransition": {
      "tr-example": "video-exit"
    }
  },
  "interactionWindow": {
    "enabled": true,
    "protagonistCharacterId": "char-example",
    "protagonistPresence": "offscreen",
    "audioTarget": "host",
    "ambientDuckDb": -8
  }
}
```

The default node sequence is:

1. Play `entryVideoHistoryId` once.
2. Enter `hold` and rotate or repeat approved hold loops.
3. Open the microphone only if the live-conversation gate passes.
4. Complete the viewer -> LLM -> protagonist TTS turn.
5. If the story stays on the node, return to listening over the hold loop.
6. If a transition is chosen, finish protagonist speech, play the optional exit
   clip, then enter the next node.

An author may use a single loop for entry and hold, but the schema does not
force that compromise. Variation selection is deterministic from the hosted
session seed until the author explicitly enables non-repeating rotation.

Every playback asset carries an audio occupancy manifest:

```json
{
  "durationMs": 8000,
  "characterDialogue": [],
  "music": [{ "startMs": 0, "endMs": 8000 }],
  "effects": [{ "startMs": 1200, "endMs": 1900 }],
  "safeForLiveVoice": true
}
```

`safeForLiveVoice` is validated, not trusted blindly: a hold asset with a
character-dialogue interval cannot open a live voice window. Music/ambience may
continue and duck under TTS. The author can mark a sound effect as voice-
blocking if it would make the conversation unintelligible.

### Live-conversation gate

Live voice is derived as allowed only when all of these are true:

- the loom uses helper participation and the node's audience connection is
  `connected`;
- the node is a decision/hold node, not an automatic cut or ending;
- `interactionWindow.enabled` is true;
- the bound protagonist exists in the linked Universe;
- `protagonistPresence` is `offscreen`;
- the host player is in the `hold` phase;
- the active hold asset is safe for live voice;
- an approved interactive voice route resolves locally;
- STT, LLM, and TTS readiness checks pass;
- neither participant is currently speaking.

Any failed condition appears in authoring preflight with direct remediation.
The runtime also rechecks the gate; stale browser state cannot enable an unsafe
window.

### Hosted play-turn response

FableLoom's present play stage returns narrator text. Add a hosted character
contract that returns one bounded spoken response:

```json
{
  "action": "stay",
  "transitionId": null,
  "speech": "I heard you. Give me a second to check the west stair.",
  "delivery": "quiet urgency"
}
```

The prompt receives the character's portable speech canon, current node,
spoiler-safe transition descriptions, bounded session transcript, and the
audience message. It does not receive hidden future scenes or unrelated private
Universe records. A malformed or unusable response stays on the current node
and uses a short authored fallback line when available.

The character voice resolver synthesizes `speech`; `delivery` is an overlay,
not a mutation of the approved profile. The same response text is stored in the
session transcript so reconnecting devices agree about what was said.

## Two-device hosted runtime

### Session creation and QR join

Add a host-created session endpoint:

```text
POST /api/fableloom/:loomId/episodes/:episodeId/host-sessions
  -> { sessionId, joinUrl, qrSvg, expiresAt, readiness }
```

Session creation is an explicit user action. It refuses when hosted-mode
preflight is red. The join token is random, high entropy, stored hashed, scoped
to one FableLoom session, single-audience by default, and short-lived until it
is claimed. The QR URL carries the token in the URL fragment so it is not sent
in HTTP request lines, access logs, or referrers. The join page consumes the
fragment and sends the token only in the hosted Socket.IO handshake.

Use a dedicated hosted namespace and authorization middleware. A guest token
can read/write only its session's voice and play events; it does not become a
PortOS login and cannot call ordinary `/api/*` routes. This scoped token is
required even when the instance password is off.

The first delivery target is a same-tailnet or same-LAN audience device over
PortOS HTTPS. An internet relay is a separate deployment and trust-boundary
project; do not expose the full PortOS instance publicly to make hosted mode
work.

### Browser readiness

Host mode preflight checks:

- PortOS is serving HTTPS on the address encoded in the QR code;
- the phone page is a top-level secure origin with microphone support;
- the phone user tapped **Join and enable audio**, granted microphone access,
  and chose an output device if the browser exposes that choice;
- both devices have the current session snapshot;
- the host has unlocked media/audio playback through a user gesture;
- the selected STT and character TTS routes are warm or explicitly show the
  expected cold start.

If HTTPS is missing, show the existing certificate setup path in the UI. Do not
display a QR code that leads to a page whose microphone cannot work.

### Authoritative state and protocol

The server owns story/session state; the computer owns the actual playback
clock. The phone is the microphone and audience UI. Events carry a monotonic
`seq` and session id:

```text
session:snapshot
player:node-enter
player:phase                 entry | hold | exit | ended
player:clock                 video id, currentTime, playing, sampledAt
audience:listening
audience:transcript-partial
audience:transcript-final
character:thinking
character:speech-start
character:speech-audio
character:speech-end
story:transition-committed
session:error
session:ended
```

The host emits phase changes and a low-frequency clock heartbeat. The phone
does not play a second copy of the story video, so frame-perfect clock sync is
unnecessary; it needs the current scene, listening/speaking state, and recovery
snapshot.

Start with Socket.IO because PortOS already streams PCM/transcripts/TTS over it
and the session has one audience device. WebRTC adds signaling and NAT concerns
without improving the authored state machine. Revisit it only for an external
relay or multiple remote audience devices.

### Half-duplex audio state machine

Hosted voice has four states:

```text
LISTENING -> THINKING -> SPEAKING -> LISTENING
     |                         |
     +------ session end ------+
```

- Only `LISTENING` accepts microphone frames.
- Final STT moves atomically to `THINKING`; additional audio is discarded.
- The LLM result moves to `SPEAKING`; TTS plays on exactly one configured
  target (`host` by default for a room-scale performance, or `audience` for a
  headphone experience).
- Both devices receive speech start/end state even when only one plays audio.
- Input remains closed through a short measured echo tail, then returns to
  `LISTENING`.
- No barge-in in v1. The existing voice widget retains barge-in, but hosted mode
  intentionally guarantees no overlapping voices.

If the host is the audio target, the phone still receives the spoken text and
timing so it can keep its microphone closed while the room speakers are active.
If the phone is the target, reuse `voiceClient`'s playback queue and echo memory.

### Recovery and privacy

- Reconnecting devices request `session:snapshot` and resume only at a phase
  boundary. A disconnected phone pauses listening; it never lets the story
  choose a path from a partial utterance.
- A host disconnect pauses the session and closes the microphone.
- Viewer audio is ephemeral by default. Persist only final transcript text and
  selected story transitions unless the host explicitly enables recording.
- Hosted transcripts and recordings are machine-local and never federate.
- End/expiry revokes the guest token, aborts active STT/LLM/TTS work, releases
  audio buffers, and closes the namespace room.

## Future investigation — diegetic FaceTime calls

The investigation is complete. ADR
[`2026-08-30-diegetic-facetime-transport.md`](../decisions/2026-08-30-diegetic-facetime-transport.md)
accepts this as a later, explicitly triggered macOS transport experiment, with
browser-hosted play retained as the canonical fallback and no simultaneous
story-audio ownership.

A later game mechanic could let an in-story character place or receive a real
FaceTime Audio call while the computer continues an authored hold loop or
related pre-rendered sequence. The audience would speak through the call and
hear the approved character voice on the call return path, turning the phone
itself into a diegetic story object rather than only a browser microphone.

The existing call-host bridge is the starting point for this investigation.
[PR #5374](https://github.com/atomantic/PortOS/pull/5374) demonstrates a related
capture-only extension that reuses its BlackHole 16ch PCM ingestion and Whisper
endpointing while deliberately bypassing the conversational LLM/tool/TTS path.
It also reinforces an important constraint: call, capture, and any future
FableLoom call-host role need explicit, mutually exclusive ownership of the
shared audio device.

Before scheduling implementation, investigate:

- what FaceTime and macOS automation permit, including user confirmation,
  contact/call identity, incoming versus outgoing calls, and App Store or
  platform restrictions;
- a recoverable call state machine for ringing, answered, declined, dropped,
  timed out, and host teardown states;
- whether call-host mode and QR/browser hosted mode are mutually exclusive or
  can hand off without reopening the microphone or replaying a story turn;
- routing the selected character voice through the existing call reply output
  while preserving the same approved profile revision and half-duplex rules;
- explicit consent and machine-local retention policy for call audio,
  transcripts, contacts, and call metadata; and
- an authored fallback to the QR/browser experience when FaceTime, its host,
  or the audio device is unavailable.

This is not a dependency for the first hosted-mode release. Treat it as a
separate, user-triggered transport and gameplay experiment after the browser
session protocol and character voice pipeline are stable.

## Production provenance

Every approved FableLoom media asset records a shared versioned manifest:

```json
{
  "version": 1,
  "loomId": "loom-example",
  "episodeId": "ep-example",
  "nodeId": "node-example",
  "universeId": "universe-example",
  "characters": [
    {
      "characterId": "char-example",
      "wardrobeId": "wardrobe-field",
      "identityAssets": ["character-primary.png"],
      "lora": {
        "filename": "lora-trained-example.safetensors",
        "sha256": "...",
        "scale": 0.9
      },
      "voice": {
        "profileId": "voice-example",
        "profileVersion": 3,
        "engine": "qwen3-tts",
        "modelRevision": "pinned-revision"
      }
    }
  ],
  "visualConditioningVersion": 1,
  "promptCompilerVersion": 1,
  "audioMixVersion": 1,
  "omitted": [],
  "warnings": []
}
```

Do not put filesystem paths, raw voice samples, or full Universe records in the
manifest. Store safe ids, basenames, revisions, hashes, and the exact effective
parameters needed for explanation and reproduction.

Regenerate uses current canon by default. **Repeat exact inputs** resolves the
recorded revisions and refuses if an asset or artifact is unavailable. It does
not silently substitute the newest character LoRA or voice profile.

## User-triggered continuity review

Production review is explicit and runs no AI at boot or merely on opening a
loom.

Visual review compares approved shots against the bound identity assets,
wardrobe, props, and temporal predecessor. Voice review renders the fixed
benchmark against the promoted profile revision and checks dialogue assets for
wrong-character bindings, clipping, unexpected engine/model changes, and
pronunciation drift. Hosted preflight verifies every conversation node has a
safe hold loop and an approved interactive voice route.

Automated checks produce findings. They never auto-replace an identity
reference, promote a training checkpoint, change a voice, or rewrite a scene.

## Delivery phases

### Phase 0 — consolidate today's working paths

- Keep implementing the predecessor bridge and visual compiler from the
  companion plan.
- Feed FableLoom character bindings through the existing local character-LoRA
  resolver.
- Stamp current Kokoro/Piper `voiceId`, model, rate, duration, and mastering
  provenance on rendered dialogue.
- Add a FableLoom production-readiness report without new provider calls.

### Phase 1 — approved character package

- Add backward-compatible `voiceCanon` schema/sanitization/UI.
- Add typed/approved identity-asset roles and wardrobe references.
- Make storyboard approval the gate for canon-locked video.
- Expose ready/missing/ambiguous/unsupported states for every resolved visual
  and voice role.

### Phase 2 — voice profiles with existing engines

- Add machine-local `voice_profiles`, managed files, storage documentation,
  CRUD, preview benchmarks, approval, and resolver.
- Wrap Kokoro/Piper presets as approved profiles without duplicating their
  models.
- Add the reproducible mastering chain and capability-probed pitch/formant
  controls.
- Update pipeline audio and FableLoom dialogue rendering to resolve profiles.

### Phase 3 — designed and cloned local voices

- Add the isolated Qwen3-TTS runtime and health/readiness UI.
- Implement voice-design previews, consented instant cloning, streaming, and
  profile promotion.
- Benchmark studio and interactive routes on supported CPU/GPU hosts before
  enabling the latter.
- Add explicit, cancellable voice fine-tuning only after design/clone workflows
  and checkpoint evaluation are stable.

### Phase 4 — production playback assets

- Add `playbackAssets`, `interactionWindow`, and audio-occupancy sanitization.
- Render entry, hold-loop variants, and transition exits as separate assets.
- Generate/mux canonical dialogue separately from video-native audio.
- Update the one-device Play surface to rehearse the exact phase state machine.

### Phase 5 — two-device hosted mode

- Add HTTPS/readiness gating, scoped host sessions, QR join, hosted namespace,
  recovery snapshots, and the half-duplex controller.
- Reuse local Whisper and the approved interactive character voice.
- Add the hosted character play-turn schema and safe authored fallbacks.
- Ship single-host/single-audience same-tailnet operation first.

### Phase 6 — episodic production and review

- Add topological batch generation with identity/voice readiness gates.
- Add per-episode continuity review and exact-input reproduction.
- Add path-specific visual variants only after playback asset selection and
  storage retention are specified.
- Evaluate an external relay and multi-audience operation as separate work.

## Acceptance criteria

- Every character shot identifies the exact Universe character, approved
  identity assets, wardrobe, adapters, temporal source, and omitted inputs.
- A canon-locked video begins from an approved scene still and never silently
  drops a required character reference or LoRA.
- Existing local character LoRAs are automatically considered by FableLoom
  without adding pointers to federated Universe records.
- Every offline dialogue line and live reply identifies the character voice
  profile revision, engine/model revision, delivery overlay, and mastering
  chain.
- Changing the project default voice cannot change a character with an approved
  profile.
- A machine lacking the local visual or voice artifact reports a degraded
  binding; it never claims that a missing artifact is an intentional empty one.
- Hosted mode cannot start without HTTPS, microphone permission, rendered safe
  hold loops, a bound off-screen protagonist, and ready STT/LLM/TTS routes.
- The microphone is open only in `LISTENING`; live TTS and rendered character
  dialogue never overlap viewer input.
- A transition is committed only after the final transcript has been resolved
  and any protagonist reply has finished.
- Reconnects restore one authoritative node/phase/transcript without replaying
  a completed LLM turn or taking a path twice.
- Guest tokens authorize one hosted session only and expose no general PortOS
  API capability.
- Existing looms, Universe characters, pipeline audio, and voice settings load
  unchanged when all new fields are absent.
- No voice design, cloning, training, continuity review, or media generation
  runs at boot or without an explicit user-triggered/scheduled action.

## Explicit non-goals for the first release

- Real-time video generation or real-time lip sync.
- FaceTime-triggered story calls; they remain the future investigation above.
- Multiple simultaneous audience speakers.
- Publishing the full PortOS server to the public internet.
- Automatic cloning from arbitrary media or a voice without confirmed rights.
- Treating a seed, face-recognition score, or speaker-similarity score as human
  approval.
- Promising perfect multi-character identity on a backend whose declared
  reference capability cannot support the bound cast.
