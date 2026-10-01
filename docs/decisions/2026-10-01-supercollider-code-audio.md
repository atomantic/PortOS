# ADR: Add SuperCollider as an optional offline code-audio engine

**Date:** 2026-10-01
**Status:** Accepted integration direction; implementation pending
**Implementation:** [#9407](https://github.com/atomantic/PortOS/issues/9407)

## Decision

Add SuperCollider to the Music Designer's **Code** language choices through an
optional, contained offline renderer. Keep Strudel as the default. Install and
test the runtime only on an explicit setup action; generate or render music only
on an explicit request. This assessment does not enable or install SuperCollider.

The first implementation will use a PortOS-owned Linux container image with
`sclang`, `scsynth`, and the stock class library/plugins. A working Docker engine
is a prerequisite, reported separately from the installed image. This trades
container setup and disk space for one execution boundary across host platforms.
Native installations can remain useful outside PortOS, but will not be an
uncontained fallback for generated code.

## Current behavior

- `server/services/musicCode.js` explicitly accepts `strudel` and `tonejs` and
  asks the selected AI provider to write or revise source; it never executes it.
- `client/src/components/music/CodePanel.jsx` edits that source and plays or
  records it in `strudelFrame.js`'s opaque-origin browser sandbox.
- `POST /api/tracks/:id/code/render` accepts a browser-recorded WAV and uses
  `saveCodeTakeToTrack()` to append an `engine: 'code'` take.
- `server/services/musicEngineCatalog.js` describes model-backed engines;
  SuperCollider is a code runtime and must not be presented as a Hugging Face
  audio model or inherit their Python/CUDA installation path.
- [HTML compositions](../HTML_COMPOSITIONS.md) synthesize through a JavaScript
  `renderAudio` contract. Native SuperCollider source cannot run through that
  browser contract. Launch-video agents currently cannot install tools or submit
  arbitrary binary soundtracks in their composition directory.

## Why add it

[SuperCollider](https://supercollider.github.io/) separates its composition
language (`sclang`) from its native audio engine (`scsynth`). Its
[SynthDef graphs](https://docs.supercollider.online/Classes/SynthDef.html) make it
a useful choice for custom instruments and algorithmic sound design. The expected
benefit is more synthesis options and reusable scores, not a guarantee that
AI-authored music will sound better.

[Non-realtime synthesis](https://docs.supercollider.online/Guides/Non-Realtime-Synthesis.html)
renders a prepared score to a file without a live audio clock or network control
connection. Patterns can be converted to scores. This fits bounded music takes
and soundtrack production better than keeping an interactive audio server alive.
Each score must supply its own synthesis resources; temporary OSC files need
explicit cleanup. PortOS will validate actual audio duration rather than trust
the requested score duration alone.

## Integration contract

1. Add `supercollider` to the code-language contract and a dedicated prompt that
   produces stock-library `.scd` source for offline rendering. The server controls
   duration, sample rate, output path and invocation; source remains editable.
2. Provide `npm run setup:supercollider -- --yes` and `--status --json`, following
   `scripts/setup-motion.js`'s explicit, idempotent setup shape. Build the managed
   image from a checked-in recipe with pinned base/dependency inputs and retain
   upstream license/source information. No runtime download or build at boot or
   when merely listing languages. Missing Docker yields an actionable setup
   state; the installer must not silently change the host's Docker installation.
3. Run each render as an unprivileged, disposable container: no network, no
   capabilities, no Docker socket, read-only root filesystem, bounded CPU/memory,
   PID and wall-time budgets. Mount only frozen source read-only and a bounded
   job-private output directory writable. Use private configuration/home/temp
   directories, an environment allowlist without provider/API credentials, and
   stock library/plugin paths. Kill and remove the whole container on cancellation
   or timeout. A working-directory change or source blacklist is not containment.
4. Expose setup/readiness and render/cancel/progress through authenticated PortOS
   routes and the existing media queue/SSE conventions. Readiness requires a
   shipped synthetic offline-render probe under the same containment policy,
   cached by runtime/policy version; status reads only the cached result.
5. In CodePanel, offer setup when unavailable, then **Render preview**, normal
   browser audio playback, cancellation and **Save as take**. Reuse existing WAV
   validation and track append boundaries. Previewing must not mutate the active
   take; failed/canceled renders must not leave takes or temporary artifacts.
6. Preserve source language, source hash, seed, runtime version and render settings
   with the take using the existing track persistence contract. Any persisted
   schema change must follow the track migration and federation version rules.
   Fixed-seed reproducibility is scoped to a tested runtime/platform configuration,
   not promised across arbitrary versions or architectures.

`sclang` can execute [operating-system commands](https://docs.supercollider.online/Classes/String.html#-unixCmd)
and loads a [user startup file](https://docs.supercollider.online/Reference/StartupFile.html).
Containment must cover the language compiler as well as audio synthesis. Running
`scsynth` in offline mode alone does not protect the host from `sclang`.

## Alternatives and limits

- A third browser-frame library cannot execute SuperCollider's native language.
- Native package installation is feasible (for example, the
  [Homebrew cask](https://formulae.brew.sh/cask/supercollider)), but package presence
  does not establish a protected execution path. Do not install it during this
  assessment or advertise it as ready based only on executable discovery.
- Live OSC control, device routing, Quarks, third-party plugins, sample downloads,
  and AI singing are outside the first version.
- Launch-video and Code Animation consumers can reuse accepted Music-library
  takes immediately after implementation. Direct native-score submission needs a
  separate adapter that preserves their source snapshot, privacy and audio-evidence
  contracts; this decision does not loosen those contracts or their agent prompts.

## Required delivery evidence

Prove a real stock-synth stereo WAV with bounded duration and nonzero audio,
preview and save it through the public workflow, and exercise syntax errors,
missing runtime, timeout, cancellation and concurrent jobs. Verify that attempted
host-file access, network access, credential reads and output-path escapes fail
inside the execution boundary. Record tested platforms/architectures explicitly;
do not mark an untested configuration ready. Browser-language regression checks
must preserve existing playback and saves. No provider call belongs in setup or
the synthetic readiness probe.
