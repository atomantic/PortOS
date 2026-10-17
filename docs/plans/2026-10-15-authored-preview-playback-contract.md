# Authored complete-frame preview playback

## Context and authority

Issue #11221 remains open after #11591. Current main is
`0ea9b0cb2505a5f30087edfa74f84881421921e2`. The canonical starter has a narrowly
recognized producer; generated, customized and older documents retain exact
seek playback. The user authorized continuing the playback/capture redesign,
independent design review and bounded implementation while preserving arbitrary
document semantics and exact final fidelity. Deployment, restart, provider calls,
package installation and previously held worktree deletion remain excluded.

Independent design review approved the custom opt-in foundation below before
implementation. It does not approve automatic generated-document admission,
source-purity inference, CSP changes or broader source-resolution claims.

## Compatibility boundary

Keep existing document bytes and the final renderer unchanged. Existing
`seek(t)` behavior remains authoritative for pause, scrub and export. Today's
generated hosts ignore section-function return values; making them await
Promises or revoking retained contexts would change existing semantics.

Add an optional `preview-playback.json` declaration with exactly
`{"version":1,"contract":"portos-complete-frame-v1"}`. Only an explicitly
declared staged document may use the authored lane. Missing declarations leave
the canonical recognizer and legacy exact path unchanged. Present malformed,
unknown or unsupported declarations decline the authored lane without rewriting
source. Do not synthesize declarations for existing generated manifests or old
engines. The immutable document pointer and frozen staged asset snapshot provide
revision identity; a declaration or digest does not prove JavaScript purity.

Future generated adoption requires a new immutable candidate under a deliberate
authoring contract, reviewed before selection. Customized/imported documents
implement the API and re-import. Known historical engine adoption remains an
explicit version change. Spatial rendering needs its own cooperative producer
and parity evidence. Stronger isolation through workers/alternate realms is a
separate design; the current CSP remains unchanged.

## Runtime and host contract

The declared page supplies `portosComposition.previewPlayback` before document
readiness. It declares version 1, 30 fps, `atomic-canvas-v1` presentation and
`staged-output-v1` timing, and supplies own callable `clock`, `prepare`, `play`,
`sync`, `pause` and `dispose` methods. The handshake copies and binds method
references and their receiver once into a host-owned immutable bridge at
`globalThis.__portosAuthoredPreviewPlayback`. Later API replacement must not
retarget dispatch. Unsupported plain shape is a clean exact fallback. Throwing
or unsettled inspection closes the owned page under a host deadline.

Retain the verified Chromium 155+ capture baseline, native request/cancel video
frame callbacks and trusted finite selected-video cadence above 10 fps. These
are eligibility checks, not proof of 30 fps authored content or arbitrary codecs.

Host RPCs use method-specific deadlines and strict method/status/epoch/sequence
responses. Clocks are finite monotonic milliseconds in the renderer's
`performance.now()` timebase. Prepare, play and sync echo the request epoch and
sequence; pause confirms its epoch only after all owned work has retired.
Transport capture sequence stays independent of authored operation sequence.

Gate the native stream synchronously when pause, control, cancellation or failure
arrives. Exact seeks and controls wait for successful retirement through the
existing queue. Once an invoked producer times out, rejects or violates the
response contract, close the owned page before any exact reuse; a timeout race
does not cancel authored Promises. A fresh explicit reopen is a new session.

The author owns complete atomic visible publication, resource readiness,
song/draw/source timing, holds, scene transitions, lyric/finishing order and
stale-lease suppression. Background mutations after a commit or pause violate
that promise. The bound bridge provides dispatch integrity and host lifecycle
guards, not same-realm isolation or proof that arbitrary pixels are complete.

## Verification and acceptance

- Exercise declaration and runtime admission through the public preview-open
  boundary: absent, malformed, unknown, incomplete, unsupported browser/cadence,
  and correctly bound implementation. Preserve original source bytes.
- Exercise real registered socket handlers for held prepare/play/pause, wrong
  epoch/sequence/status, nonfinite/regressing clocks, runtime errors/deadlines,
  immediate frame gating, control ordering and late completion after close.
- Verify method and receiver replacement cannot redirect the bound producer.
- Verify an undeclared asynchronous custom document retains its exact seek
  behavior and generated version-1 documents are never automatically admitted.
- Use a real imported opt-in custom document with asynchronous preparation and
  atomic publication through the actual socket and React player. Measure distinct
  intrinsic content at wire, hook, decode and one-RAF boundaries, including scene
  transitions, cancellation, pause/resume and exact paused/final PNG parity.
  Retain original warmup, cadence, quality and drift requirements.
- State input dimensions/codec and output dimensions/quality for every run. The
  earlier canonical 640×360 input result establishes no 1080p/4K decoding or
  arbitrary-document/GPU performance guarantee.
- Complete independent source/result review, focused checks, client build when
  affected, pregate before every push, draft PR and required exact-head CI.
  Keep #11221 open while generated and untouched legacy paths remain.

## Presentation ordering after native evidence

A bounded native attempt delivered 89 consecutive source images through wire,
hook acceptance and actual image decode in its first three-second window, but
only 80 remained current through the independent one-RAF observation. The nine
missing observations were interior images followed by another image about
12–17 ms later. Immediate source replacement and URL revocation can supersede a
decoded image before that opportunity. The entire failed attempt and positive
owned cleanup were retained; later passing windows do not replace this failure.

Independent design review approved a native-playback FIFO with two pending
images and one presenting image. Validate request/session/epoch/received sequence
before enqueueing; track presented sequence separately. The actual visible
image's load, decode and current-source check precede a lease-checked one-RAF
acknowledgement. Keep the presentation slot occupied through acknowledgement,
then promote its successor in an owned cancelable timer task. Every successor,
including a new arrival after acknowledgement, follows that task. A synchronous
or Promise-microtask promotion can precede peer RAF callbacks; an additional RAF
would cap a 60 Hz consumer at approximately 30 frames/s with no recovery headroom.
The [HTML rendering model](https://html.spec.whatwg.org/multipage/webappapis.html#update-the-rendering)
and [RAF callback iteration](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#run-the-animation-frame-callbacks)
explain this task boundary. It provides an RAF opportunity, not hardware paint
proof; the independent actual-player observation remains the acceptance gate.

Receipt-to-acknowledgement has a 100 ms deadline. Recheck identity, source,
lease and age at acknowledgement and promotion. Overflow or excess age closes
visibly through the existing error/audio-stop path; never drop an intermediate
image silently. This adds bounded presentation latency, while the original
end-to-end lag, ahead, drift, quality and cadence criteria stay unchanged.

Pause, seek, prepare, visual-control dispatch, disconnect and unmount retire
pending work immediately. Keep or restore the last known decoded current image
when canceling an unfinished candidate. Exact/legacy frames retain their
existing generation rules and bypass this native FIFO. Preserve a current image
across a reopen until replacement, revoke URLs only after the DOM retires them,
and capture the actual known decoded image for Save frame. Old decode, RAF or
timer continuations cannot advance another intent or redirect capture.

Public rendered regressions must cover burst order, deferred decode, peer
observers before and after acknowledgement in one RAF batch, a new arrival
before the promotion task, pause/control/epoch races, overflow/age failures and
exactly-once URL cleanup. Freeze the updated source and independently review a
fresh native package before another run. No threshold, warmup, window, input or
output-quality relaxation is authorized by this design.
