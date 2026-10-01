# Music Video performance evidence

Stream-duration parity and temporal lip-sync are separate review checks. Equal
audio/video lengths do not show that the singer's mouth follows the song.
Still-frame review and correctly sliced source audio cannot establish that either.

In Setup, attach a full-length bounce starting at song time zero and choose the
conditioning source: master mix, attached vocal stem, or an explicitly selected
clean singer stem. The last choice records the director's intent; demucs separation
does not certify a single isolated singer. Replacing/removing a stem resets that
choice. Each performance scene can name its intended speaker/singer. A generated
take records this speaker, the actual source filename/hash, selection provenance,
and unverified voice isolation in its immutable shot instruction.

The Board performance preview plays the recorded conditioning audio alongside
the muted clip on the recorded song/clip timebase. Word buttons seek clip-relative
windows; evidence buttons seek song-time windows. Old takes without source
metadata remain review-needed. Evidence is shown only for the reviewed take.

## Optional local analyzer protocol

PortOS ships the adapter contract, not a temporal model. Install a trusted native
executable named `portos-temporal-analyzer` on the server's PATH to supply one.
Windows batch wrappers are unsupported. PortOS never installs or downloads an
analyzer and never invokes a paid analyzer provider. No analyzer runs at boot.

The executable must answer `--capabilities` with one JSON object:

```json
{"protocolVersion":1,"id":"example-analyzer","version":"1.0","ready":true,"temporalLipSync":true,"localOnly":true}
```

Only an installed analyzer with that supported protocol and ready local models is
used. Capability discovery has a five-second timeout. Each explicitly requested
draft review has a sixty-second total analysis budget and at most 256 evidence
spans. Output is bounded to 256 KiB per invocation.

For each rendered performance section the adapter invokes, without a shell:

```text
portos-temporal-analyzer --analyze --video <excerpt-file> --audio <excerpt-file> --audio-start-sec 0 --start-sec <excerpt-start> --end-sec <excerpt-end> --speaker <recorded-speaker>
```

Both inputs name the actual encoded output. Compare visible mouth motion with
its embedded song audio, not stream duration, source preparation, or a current
master that may have changed since rendering. Times are seconds relative to the
excerpt, not absolute song time. Positive offset means picture lags audio.
The executable must remain local and must not install weights during analysis.

Return ordered, contiguous spans covering the entire requested section:

```json
{"spans":[{"startSec":0,"endSec":5,"status":"verified","offsetSec":0.02,"confidence":0.95}]}
```

Every span requires finite times, `verified` or `unverified` status, offset in
[-5, 5] seconds (or null), and confidence in [0, 1] (or null). Start/end must
stay inside the section, with at most one millisecond of boundary rounding.
Confidence below 0.8 or missing offset leaves a span unverified.
Complete verified coverage passes temporal lip-sync only when all absolute
offsets are at most 0.12 seconds. A larger measured offset produces a timecoded
finding independent of duration parity.

Unavailable, unsupported, failed, malformed, gapped or inconclusive evidence
remains unverified with no invented score. The run stops as needs-human before
opening a revision, including when the vision reviewer flags another problem.
It cannot spend money trying to fix unknown temporal quality. A measured failure
can enter the existing explicitly budgeted revision workflow.

Analyzer identity/version, shot/source provenance, measured offsets/confidence
and spans persist in existing auto-review records. Excerpts snapshot performance
provenance when rendering begins, so later board edits cannot relabel evidence.
The project sync schema is version-gated; older takes need no data migration.

## Repair a measured performance suffix

After stopping or finishing a review/production run, the Board evidence inspector
can offer **Repair from here** for the latest measured take. It shows the song-time
boundary, remaining audio interval and estimated next spend before submitting.
The boundary must lie in a real word gap inside an accepted prefix; every remaining
span must have a measured offset above 0.12 seconds. Incomplete evidence, missing
word timings, changed audio, unsupported providers and suffixes outside the
provider's limits stay review-needed. There is no backward audio padding and no
whole-take fallback. Authored code/document compositions and timed action contracts
need their own edit review before this continuation route is available.

Repair keeps the original clip as an accepted-prefix scene with explicit edit
points, captures its last accepted frame, and creates a contiguous suffix scene.
The checkpoint retains the original take, source interval, boundary, reference
frame time and generated continuation provenance. Resume submits only that suffix
through the normal revision/media queue. Its durable reservation permits one paid
generation; duplicate clicks, cancellation and ambiguous restarts cannot submit it
again. A synchronous enqueue failure with no durable job refunds the reservation.
Once the suffix take lands, Resume renders the revised draft using both original
prefix footage and the continuation. Retrying the draft render generates no video.
Existing active run budgets cannot be bypassed by opening a manual repair.
