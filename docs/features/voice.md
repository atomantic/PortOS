# Voice Mode

PortOS includes an optional voice assistant with support for fully local operation. Supports push-to-talk and hands-free continuous mode with barge-in (start speaking over a reply to interrupt it).

**Privacy note:** LLM, TTS, and pipeline orchestration always run locally. For speech-to-text, the default **Web Speech API** uses your browser's built-in recognition service — in Chrome/Chromium this forwards audio to a Google cloud endpoint. Switch `stt.engine` to **`whisper`** (whisper.cpp, local HTTP server) under *Settings → Voice* for fully-offline STT with no audio leaving the machine.

## Stack

| Stage | Default engine | Alternatives | Local? |
|-------|----------------|--------------|--------|
| Speech-to-text | Browser [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API) (default — **note**: Chromium browsers forward audio to a vendor cloud speech service) or [whisper.cpp](https://github.com/ggerganov/whisper.cpp) via `whisper-server` (HTTP :5562, fully local) | — | ✅ (whisper) / ⚠️ (web-speech) |
| LLM | LM Studio (`/v1/chat/completions`) | OpenAI-compatible local server | ✅ |
| Text-to-speech | [Piper](https://github.com/rhasspy/piper) (CLI) | Qwen3-TTS (CPU/CUDA/Apple Silicon MLX) | ✅ |
| Voice activity | AudioWorklet + RMS VAD (hands-free) or `MediaRecorder` (push-to-talk) — Web Speech mode bypasses server audio and posts final text via `voice:text` | — | ✅ |

The TTS engine is selectable in **Settings → Voice → TTS engine**.

**Qwen3-TTS status:** the bundled runner calls the official
[qwen-tts inference API](https://github.com/QwenLM/Qwen3-TTS#python-package-usage)
for voice design and reference cloning on CPU/CUDA. Install `qwen-tts` in the
isolated Qwen Python environment; the package supplies Torch, NumPy and
SoundFile. Apple Silicon uses [MLX Audio](https://github.com/Blaizzy/mlx-audio)
against the same verified official snapshots. In the isolated Qwen Python
environment, install `mlx-audio` at commit
`784b29e2691a93ca7483147d86f61859dfaa6296` (the adapter's reference API) plus
`soundfile` and `huggingface_hub`. The runtime probe checks MLX/Metal availability
without loading weights. MLX cloning requires a reference transcript and a
loaded speech-tokenizer encoder; otherwise it fails rather than generating an
unconditioned voice. Speech-rate changes and instruction-controlled Base cloning are
refused rather than reported as applied controls. Fine-tuning is described
under Voice Studio below. Explicit model
downloads in Settings fetch the official Qwen snapshot at an immutable Hub
revision and verify the size and digest of every required file, including the
speech tokenizer weights, before publishing readiness. Downloads require
`huggingface_hub` in the isolated Qwen Python environment. A missing dependency
or failed verification returns an error; it never marks the model downloaded.
Earlier versions produced test tones, placeholder checkpoints and download
metadata; those artifacts are not evidence of model readiness. Runtime probes
report dependency/hardware availability without loading weights. Model download readiness is separate: it
requires a verified snapshot marker and all required files. Unchanged verified
files use their size, change timestamps, and filesystem identity; changed files
are rehashed before they can report ready. Windows probes rehash all files because
Python does not expose a reliable change timestamp there; old metadata-only model folders remain unavailable.
Inference loads only these verified snapshots with Hub/Transformers offline
mode enabled, never a repository ID that might trigger an implicit download.
The returned model revision includes the immutable commit hash. No model
download runs automatically. Audio is buffered, not streamed.

Apple Silicon real-model generation and an independent transcript check passed
on 2026-09-27 (evidence below). The operator confirmed clear, natural design
speech and clear cloned speech with the same speaker identity. Fixture tests prove the adapter contract,
not speech quality. On a supported host with the
isolated environment and verified weights, run the following manually from
the repository root (substitute the isolated Python executable and model root):

```sh
python scripts/qwen3_tts_runner.py --models-dir <model-root> \
  --mode design --model-id Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign \
  --text 'The example garden gate is open.' --instructions 'A clear warm alto.' \
  --output-wav <scratch-dir>/design.wav
python scripts/qwen3_tts_runner.py --models-dir <model-root> \
  --mode clone --model-id Qwen/Qwen3-TTS-12Hz-1.7B-Base \
  --reference-audio <scratch-dir>/design.wav \
  --reference-transcript 'The example garden gate is open.' \
  --text 'Please close the gate after you enter.' --output-wav <scratch-dir>/clone.wav
```

Listen to both files and record intelligibility and voice continuity with the
reported revisions before treating this as a validated speech runtime. The
reference is generated, so no personal recording or consent is needed for this
smoke. A successful command or non-silent WAV alone does not establish quality.

**Apple Silicon smoke evidence — 2026-09-27 (#8857).** The two commands above
ran successfully on macOS arm64 through the production runner at `4a8dafc3a`,
with seed 42 and rate 1.0. No runtime code changes were needed. The reference
was the generated design WAV, not a personal recording. Model acquisition used
the runner's explicit `--download` operation for each model; all required files
passed upstream size/digest verification before inference loaded local snapshots
with Hub/Transformers offline mode enabled.

| Model | Verified revision |
|-------|-------------------|
| `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` | `5ecdb67327fd37bb2e042aab12ff7391903235d3` |
| `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | `fd4b254389122332181a7c3db7f27e918eec64e3` |

The isolated environment used Python 3.11.11, MLX 0.32.2, MLX Audio 0.4.8
at the pinned commit above, Transformers 5.17.0, NumPy 2.4.6, SoundFile 0.14.0,
and huggingface-hub 1.33.0. PyTorch was absent; the probe reported `device: mlx`,
both 1.7B snapshots downloaded, and `training_adapter: null`.

| Output | Format | Duration | RMS | Peak | Independent local transcript |
|--------|--------|----------|-----|------|------------------------------|
| `design.wav` | Mono PCM16, 24 kHz | 1.76 s | 0.115736 | 0.622681 | The example Garden Gate is open. |
| `clone.wav` | Mono PCM16, 24 kHz | 1.84 s | 0.098126 | 0.410736 | Please close the gate after you enter. |

Both decoded WAVs were finite and non-silent. Local MLX Whisper 0.4.3
(`mlx-community/whisper-small.en-mlx` revision
`52a88bf6e98b114a210c21bb83e22d6e1505cb73`, English, no supplied transcript prompt)
recovered every requested word, ignoring case and punctuation. This supports
intelligibility for these two short samples; it does not establish naturalness,
speaker identity, general quality, or browser playback latency. WAV SHA-256:

```text
design.wav c05344914d4c81b7099c427483f44d620edfe743f7b17af1f08cdb93044ace29
clone.wav  7ff72e5745adb753b36f318f567cddceaf13e42c37f5e7d21e6a9969492dee0e
```

After listening to both files, the operator confirmed that the design sample
was clear and natural, and that the clone clearly spoke the requested sentence
and sounded like the same speaker. These are listening observations for the
two samples, not a numerical similarity score or general quality benchmark.

A real `--mode fine-tune` invocation on this host exited 1 with
`QWEN3_RUNTIME_UNAVAILABLE` (requires CUDA with bf16), creating no checkpoint
directory. A real CUDA training run and an intelligible checkpoint audition
remain open in #8857; these MLX results do not close that issue.

Interactive profile qualification plays a fresh buffered WAV in the browser.
The first click renders and transfers the probe. A second explicit playback
click preserves browser autoplay permission. The latency gate sums measured
render-request time and click-to-`playing` startup time, including response
transfer and decoding, while excluding the operator's wait between clicks.
It is a render-plus-playback-start benchmark, not continuous request-to-playback
or first-chunk streaming latency. Rendering
alone never enables the route. A one-use receipt expires after two minutes, binds
the measurement to the rendered profile revision, and saves its boundary, model
revision and route decision together. Restarting the server or changing the
profile requires a fresh benchmark. The probe must reach `ended` after `playing`
before submitting its startup measurement. Playback rejection or timeout cannot
qualify.
The browser reports its own playback event; this is a trusted operator-reported
measurement, not an attestation of another machine's audio output. The receipt
binds the report to a current probe but cannot prove that a remote client played
it. Qualification changes profile routing, not execution authority. No similarity score is
invented, and passing this latency gate does not establish intelligibility or
speaker identity.

### FaceTime Audio control plane

FaceTime Audio controls are off by default and remain machine-local. On macOS, run `npm run setup:facetime`, grant the installed helper Accessibility permission in System Settings, choose the configured BlackHole devices in FaceTime, then enable **FaceTime Audio** in Settings → Features. Set a target name and E.164 phone number or email in Settings → Voice, save, and use **Probe**, **Test call**, or **Hang up**. The helper refuses ambiguous FaceTime surfaces and never uses coordinate clicks.

### FaceTime Audio call bridge

The control plane can dial and hang up. Carrying the conversation takes two
virtual audio devices and a browser tab.

**Devices.** `npm run setup:facetime` offers to run `brew install blackhole-2ch
blackhole-16ch`. BlackHole is GPLv3 and is never bundled — PortOS asks, you
install it, and declining is fine (dial and hang up keep working without it).
In FaceTime, set the **output** to BlackHole 16ch and the **microphone** to
BlackHole 2ch. Both must run at 48 kHz; **Settings → Voice → Check setup**
verifies the label, rate, and channel count of each and names the exact problem
when one is wrong. A device list that cannot be read at all reports that
plainly rather than claiming the device is missing.

**Call host.** Open **/voice/call-host** in a browser tab on the Mac running
PortOS and press **Attach call host**. Device permissions and `setSinkId` need
a real browser profile, so this cannot live on the server. The page reads
BlackHole 16ch (what FaceTime plays into), streams it to PortOS as 16 kHz mono
PCM, and plays each reply back through BlackHole 2ch (what FaceTime hears as
its microphone). An input-level meter and a one-second test tone confirm both
directions before you rely on them.

The page **fails closed and says why**: a browser missing any required API
names all of them at once, a missing or misconfigured device is named
specifically, an unlabeled device list is reported as a missing microphone
permission rather than a missing driver, and a second tab is refused — it holds
a Web Lock, and the server refuses a second host independently, so two tabs can
never double-answer one call.

**Turns.** A phone call has no push-to-talk, so the server decides where a turn
ends: energy-based voice activity detection with 700 ms of trailing silence and
a 20-second ceiling per utterance. Each utterance runs the **existing** voice
pipeline — same persona, tools, confirm gate, and TTS settings as the widget.
Speaking over a reply interrupts it, exactly as the widget's barge-in does.

**Ending.** The call ends when the caller hangs up, after 60 seconds of caller
silence, at the configured maximum call length (Settings → Voice, default 15
minutes), or when the call-host tab goes away — a call nobody can hear is ended
rather than left running. The helper's own view of the FaceTime window is the
source of truth throughout: a probe that fails is treated as unknown, never as
a hangup.

**What is kept.** A text transcript is appended to the daily journal, labelled
`Caller` and `PortOS`. The call audio is never persisted, and the configured
handle never appears in the transcript or its metadata.

**Calls PortOS places on its own.** Two opt-in paths can dial without you
asking: the Persistent Mind's `voice.call-user` grant, and the
critical-notification escalation in **Settings → Voice**. Both are off by
default and share one gate and one budget — never while a browser tab can speak
the message, never inside voice quiet hours, at most 3 calls per rolling 24
hours and at least 30 minutes apart, counted in durable state so a restart
cannot reset them. Escalation additionally fires only for a `critical`
notification that is *still unread* after `escalateAfterMinutes`. See
[Chief of Staff enhancement → Persistent Mind phone calls](./cos-enhancement.md#persistent-mind-phone-calls).

**Calling PortOS back.** Turn on **Automatically answer incoming calls** in
Settings → Voice → FaceTime Audio (`facetime.autoAnswer`, off by default) to
call the Mac from your phone or watch and talk to your Chief of Staff. Fail
closed by construction: the helper's `answer` command presses only the
Notification Center action naming your own configured identity — a call from
any other handle is left ringing, and PortOS never logs anything that would
name who it was. Answering also needs the **call host** tab open and attached
on this Mac (same tab the outbound bridge uses); without it, an authorized
call rings unanswered and a `medium` notification records the miss instead of
silently dropping it. Quiet hours change only the greeting's tone, never
whether the call is picked up — you placed it, so PortOS answers at any hour.
Once answered, the call runs exactly like an outbound one: whisper STT →
voice LLM/persona → Piper/Qwen3 TTS, the same silence/max-duration/hangup
rules, and a transcript in the daily journal. If the Persistent Mind is
running, the call carries its persona and context and the transcript is
handed back to it as a message on hangup, continuing the same conversation on
its next wake; if the mind isn't running, it's the plain voice persona, same
as the widget. The Mind tab shows an active-call chip with a **Hang up**
button (`voice:call:hangup`) for either direction, from any tab — not just
the one carrying the audio.

### Meeting capture

The call-host page's second mode: **/voice/call-host?mode=capture** (or the
**Capture system audio** tab on the same page) turns live audio from a
Zoom/Meet/FaceTime meeting into a timestamped transcript in the daily journal
and the Brain inbox — no dialing, no reply, no LLM call.

**Setup.** Reads the same BlackHole 16ch device as the call bridge, so it
needs no separate driver — but only the input half: capture never plays
anything back, so BlackHole 2ch is not required. Route the meeting app's
output to BlackHole 16ch (a macOS Multi-Output Device lets you also hear it
through your speakers at the same time).

**Capturing.** Press **Start capture**; PortOS transcribes continuously with
the same whisper.cpp STT and energy-based endpointing (700 ms trailing
silence) the call bridge uses, but stops there — it never runs the LLM/tools
pipeline, so no AI provider is called while a meeting is being captured.
Press **Stop capture** (or close the tab) to finalize: the transcript is
appended to the daily journal under a "Meeting capture" heading with
start/stop timestamps, and filed as a Brain inbox item with auto-classify
off — exactly like a manually-typed thought with classification skipped. The
usual summarize/tag flow applies only once you ask for it from the inbox.

**Mutually exclusive with a call.** Both modes read the same BlackHole
device and the same host tab, so starting one while the other is active on
this tab is refused with a specific reason rather than fighting over the
device.

### Default TTS engine

Piper is the default local TTS engine. Kokoro is retired: existing settings migrate to Piper while preserving custom Piper voices. Upgraded installs wait for **Save & Reconcile** before installing Piper. Existing Kokoro character profiles remain available as historical records; select or promote a Piper replacement to synthesize new audio.

## First-time setup

1. Open PortOS → **Settings → Voice**.
2. Pick your TTS engine (default: Piper), Whisper model size, and CoreML toggle (macOS).
3. Toggle **Enable voice mode** and click **Save & Reconcile**.

PortOS will:
- Install `whisper-cpp` via Homebrew if missing (the whisper.cpp binary + its base models)
- Download the selected Whisper ggml `.bin` model into `~/.portos/voice/models/`
- On macOS with CoreML enabled, download the matching `<model>-encoder.mlmodelc` (2–3× faster STT on Apple Silicon, requires a custom whisper.cpp build)
- If Piper is selected, download the pre-built Piper binary + phonemize libs from [rhasspy/piper](https://github.com/rhasspy/piper) and [rhasspy/piper-phonemize](https://github.com/rhasspy/piper-phonemize) GitHub Releases (Piper is not on Homebrew), then fetch the selected voice `.onnx` into `~/.portos/voice/voices/`
- Start `portos-whisper` under PM2

Piper voice models live under `~/.portos/voice/voices/`.

### Model download completion and repair

A model file that merely exists is not proof its download finished — a dropped
connection leaves a truncated file at the final path. Both setup scripts
(`scripts/setup-voice.sh`, `scripts/setup-voice.ps1`) therefore:

- download each managed asset (Whisper `.bin`, Piper `.onnx` and `.onnx.json`) to a unique
  temp sibling, check that the transfer completed with a non-empty payload, and parse the Piper
  config (`audio.sample_rate`) **before** promoting anything — a failed replacement leaves the
  previous files in place, and temp files are removed on failure;
- write a `<asset>.portos-complete.json` receipt (size + sha256 per file) only after the whole
  asset is promoted — for Piper, only once the `.onnx` **and** its `.onnx.json` are both in place;
- on every run, re-verify the receipt (including sha256) and repair anything that no longer
  matches.

The server applies the same contract through `server/lib/voiceModelAssets.js`. A model is **ready**
when its receipt matches the file sizes on disk, or — for installs that predate receipts and for
files at a path you chose yourself — when it is non-empty and, for Piper, the `.onnx.json` next to
it parses. A Piper `.onnx` without a valid `.onnx.json`, an empty file, or a file that disagrees
with its receipt is **incomplete**: `/api/voice/status` and the Piper health badge stop reporting it
ready (`models.ttsVoiceState` / `sttModelState` carry `verified`, `unverified`, `incomplete` or
`missing`).

Repair is always user-authorized. **Save & Reconcile** and the Settings voice-picker download re-run
the setup script for an incomplete model instead of skipping it. Server boot only reads state: an
incomplete model is logged and left for the next Save & Reconcile, and boot starts no model download.

Models that predate receipts keep working. The next Save & Reconcile has the script adopt them: a
Piper pair with a parseable config is recorded as complete with no network access; a Whisper file is
compared with the remote size (adopted on a match, re-downloaded on a mismatch, left untouched when
the remote size cannot be read). Only files directly in `~/.portos/voice/models/` and
`~/.portos/voice/voices/` are managed this way — a model at any other path is validated but never
replaced, so give a hand-installed model its own filename or directory.

You can also run the bootstrap script directly:

```bash
TTS_ENGINE=piper INSTALL_COREML=1 bash scripts/setup-voice.sh
TTS_ENGINE=piper VOICE_NAME=en_US-ryan-high bash scripts/setup-voice.sh
MODEL_NAME=ggml-small.en.bin bash scripts/setup-voice.sh
```

## Configuration options

All options live in `data/settings.json` under `voice` (Settings UI patches this file).

| Option | Default | Notes |
|--------|---------|-------|
| `enabled` | `false` | Master toggle. Triggers reconcile on change. |
| `hotkey` | `Space` | Held to talk. Ignored while typing in inputs. |
| `stt.model` | `base.en` | `tiny.en` · `base.en` · `small.en` · `medium.en` · `large-v3` |
| `stt.coreml` | `false` | Optional on macOS. Enable to use the CoreML encoder companion (requires a custom whisper.cpp build with `-DWHISPER_COREML=1`). |
| `stt.endpoint` | `http://127.0.0.1:5562` | whisper-server listen address (whisper engine only). |
| `tts.engine` | `piper` | `piper` or `qwen3-tts` |
| `tts.rate` | `1.0` | Speech rate, 0.5–2.0 |
| `tts.piper.voice` | `en_GB-jenny_dioco-medium` | Piper voice id (path-encoded) |
| `tts.piper.voicePath` | `~/.portos/voice/voices/<voice>.onnx` | ONNX file location |
| `llm.model` | `auto` | `auto` picks first loaded LM Studio model |
| `llm.systemPrompt` | (concise voice prompt) | Edit to change personality |
| `llm.fastPath.enabled` | `false` | Fast-resolution cascade (see below). Off = every turn runs on the server LLM. |
| `llm.fastPath.triggers` | `true` | Tier 1: resolve navigation commands ("go to tasks") in the browser, no LLM. |
| `llm.fastPath.browserLlm` | `true` | Tier 2: answer simple/conversational turns with Chrome's on-device Gemini Nano. |
| `llm.fastPath.browser.temperature` | `0.7` | Nano sampling temperature (0–2). |
| `llm.fastPath.browser.topK` | `3` | Nano sampling top-K (1–128). |

## Using voice mode

Two modes, toggle with the headset icon in the voice widget:

- **Push-to-talk**: click/hold the mic or hold the configured hotkey. Release to send. The hotkey ignores keypresses while an input/textarea is focused.
- **Hands-free**: the mic stays live; an AudioWorklet computes an RMS envelope and auto-submits once you've been silent for `vad.endOfSpeechMs` (default 700 ms). Ambient noise is calibrated at session start.

Either mode: start speaking while the assistant is replying to interrupt it (barge-in). Click the square button to stop current TTS playback without sending a new turn.

With `stt.engine = 'web-speech'` the browser's SpeechRecognition handles STT entirely client-side; PortOS sends the final transcript as `voice:text` instead of shipping audio, which skips whisper.cpp and avoids a 250–800 ms server-side round-trip.

## Fast-resolution cascade (lower latency)

The server LLM is the slowest part of a turn — a local model with tools attached can take several seconds. When `llm.fastPath.enabled` is on, the **client** triages each turn through faster tiers first and only falls through to the server LLM when it has to:

1. **Trigger** (`fastPath.triggers`) — deterministic, offline. A navigation command ("go to tasks", "open the daily log") is matched against the ⌘K palette nav manifest and navigates immediately. No LLM.
2. **Browser LLM** (`fastPath.browserLlm`) — Chrome's on-device **Gemini Nano** (the Prompt API: `window.LanguageModel` / legacy `self.ai.languageModel`) answers simple/conversational turns entirely in the browser (fast, private, offline). Nano is also asked to reply `ESCALATE` for anything that needs a real action.
3. **Server** — the configured provider/model (recommend **Ollama** with a small model) via the existing pipeline. Handles every tool/action turn, personal-data retrieval, dictation, confirmations, and anything the fast tiers decline or can't run.

Notes:

- The cascade only applies to **client-produced transcripts** — Web Speech STT or typed input. Whisper / hands-free audio turns have no client transcript to triage, so they stay fully server-driven. Set `stt.engine = 'web-speech'` to get the benefit.
- Trigger/Nano replies are spoken through the server's configured TTS (`POST /api/voice/public/synthesize`), reusing the normal playback queue and echo-suppression, so barge-in keeps working.
- Fast-tier turns are handled without a server round-trip, so they are **not** added to the server-side conversation history; a later server turn won't have that chit-chat in its context. Action turns (which always hit the server) are unaffected.
- Nano availability is surfaced in **Settings → Voice → Fast resolution**. When it isn't downloaded/enabled (`chrome://flags/#prompt-api-for-gemini-nano` + `#optimization-guide-on-device-model`), tier 2 transparently falls through to the server.
- Nothing here runs a model the user hasn't triggered — Nano only executes on a real spoken/typed turn, consistent with the no-cold-bootstrap AI policy.

Client modules: `client/src/services/browserLlm.js` (Nano client), `client/src/services/voiceFastPath.js` (the routing decision), wired into `VoiceWidget.jsx`.

## Architecture

```
browser mic → MediaRecorder (PTT) OR AudioWorklet + RMS VAD (hands-free)
  → Socket.IO 'voice:turn' (audio) OR 'voice:text' (Web Speech final)
  → whisper.cpp /inference          (STT for audio path)
  → LM Studio /v1/chat (streaming)  (LLM)
  → sentence-boundary TTS dispatch  (Piper CLI | Qwen3-TTS runtime)
  → Socket.IO 'voice:tts:audio'     → Web Audio playback queue
```

Pipeline orchestration: `server/services/voice/pipeline.js`. The pipeline emits events as it runs:

- `voice:transcript` — STT result
- `voice:llm:delta` — each token delta from LM Studio
- `voice:llm:done` — full assistant reply
- `voice:tts:audio` — one WAV per sentence as soon as TTS finishes it
- `voice:idle` — turn complete (or interrupted)

Barge-in works by aborting the shared `AbortController` tied to the current turn — the LLM stream is torn down and any queued TTS is discarded.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/voice/status` | Health probes + active engines + binary/model presence |
| GET  | `/api/voice/config` | Current merged voice config |
| PUT  | `/api/voice/config` | Deep-merge patch; triggers PM2 + setup reconcile |
| GET  | `/api/voice/voices` | Voices for the active TTS engine |
| POST | `/api/voice/test`   | Body `{ text }`, returns WAV bytes — verifies TTS |

| GET  | `/api/voice/facetime/status` | BlackHole device + helper + identity preflight |
| POST | `/api/voice/facetime/{probe,call,answer,hangup}` | Machine-local call control |

Socket events are documented in `server/sockets/voice.js` — including the
call-host bridge (`voice:call:attach` / `voice:call:audio` / `voice:call:detach`
/ `voice:call:hangup` inbound, `voice:call:state` / `voice:call:tts` outbound —
`voice:call:state` broadcasts to every connected tab, not just the call host,
so the Mind tab's active-call chip stays in sync) and meeting capture, which
reuses the same `voice:call:audio` PCM frames (`voice:capture:start` /
`voice:capture:stop` inbound, `voice:capture:state` outbound).

## Troubleshooting

- **Whisper badge red** — `brew install whisper-cpp`, then `which whisper-server`.
- **CoreML missing** — re-run `INSTALL_COREML=1 bash scripts/setup-voice.sh` (or toggle voice off/on after enabling CoreML).
- **Piper spawn fails** — `which piper` and check voice file at `~/.portos/voice/voices/<name>.onnx`.
- **LM Studio red** — start LM Studio and load a chat model; the voice pipeline uses `/v1/chat/completions`.
- **No audio playback** — browsers require a user gesture before AudioContext can play. Click the page once or press the mic button.

## Performance notes

| Engine | Cold start | Warm latency (per sentence) | Quality |
|--------|------------|------------------------------|---------|
| Piper | ~100 ms (CLI spawn) | ~100 ms | Mid |
| Whisper base.en (no CoreML) | 0 (server resident) | 400–800 ms / 2 s of audio | Good |
| Whisper base.en + CoreML | 0 | 150–300 ms / 2 s of audio | Good |
| Whisper small.en + CoreML | 0 | 300–600 ms / 2 s of audio | Better |

## Character Voice Studio

**Create → Voice Studio** (`/voices`) is the reusable voice library. A character's
sheet links here with its universe and character selected. `/voices/new`
creates a voice; `/voices/:profileId` auditions and assigns it. Series dialogue
and FableLoom live conversations reuse the universe-character voice resolver.
Assigning copies an approved reference into a separate character profile, so
experimentation in the library does not silently replace a cast voice. Profiles
and reference audio remain machine-local, following the existing voice policy.

AuK-Flash uses the official `feat/mlx-apple-silicon` backend with 8-bit inference.
On Apple Silicon, **Set up AuK locally** provisions an isolated Python runtime
under `~/.portos/auk`, downloads weights, and converts them to MLX. It requires
`uv`, network access, and at least 40 GB free disk space. Setup is explicit;
startup and page reads never download weights or generate speech. Other hosts
can browse their stored library but cannot run this MLX engine.

Timbre/accent/delivery use natural-language direction. Pitch is a separate AuK
acoustic edit in semitones. Pace changes target duration; the operator must
listen for intelligibility and clipping before assigning. Previews are 2–6
base seconds, scaled by pace. Longer dialogue is split without dropping text
into model segments of at most 12 seconds, all conditioned on the same voice
reference, then joined into one WAV (up to 32 segments per request). Controls take
effect on generation, not continuously during playback. Each generation creates
a new candidate, with a preserved WAV reference, transcript, seed, and settings.
The resident model is reused for previews and unloaded after ten idle minutes
or through **Unload model**. Inference is serialized and times out after three
minutes. Assignment offers an explicit **Use this voice in FableLoom live
conversations too** option. It accepts buffered playback (the whole reply must
finish before playback, up to the three-minute runtime timeout), not low-latency
streaming qualification. Without that opt-in, AuK remains studio-only and the
existing interactive fallback is retained. The production planner checks the
interactive route rather than treating every approved studio voice as live-ready.

The separate Qwen runtime can fine-tune one speaker with the official
[Qwen3-TTS single-speaker recipe](https://github.com/QwenLM/Qwen3-TTS/tree/022e286b98fbec7e1e916cb940cdf532cd9f488e/finetuning)
(adapter `qwen-tts-sft-12hz`). The runner ports that recipe rather than
calling the upstream scripts. The probe names the adapter only on CUDA with
bf16 support and `qwen-tts`, `librosa` and `safetensors` installed. CPU and Apple Silicon hosts report
`training_adapter: null`, and starts return `503 QWEN3_TRAINING_UNAVAILABLE` before any job record or process
exists. Training uses a verified, downloaded Base snapshot offline (`409 QWEN3_MODEL_NOT_INSTALLED`
otherwise). It uses the profile's transcribed source recordings, with the first recording as the speaker
reference. Full-parameter training needs substantial GPU memory. Each checkpoint is a full model copy
(about the base snapshot's size), so the checkpoint interval (optimizer steps) bounds disk use.

A checkpoint is published only after the runner records the SHA-256 of every file it loads. It must pass
the same verification and loader used for synthesis and render a non-silent audition (`audition.wav`).
Checkpoints that fail are deleted. The published revision is
`<base-model>@<base-revision>+sha256.<weights-digest>`; promotion records it, and fine-tuned synthesis
refuses a checkpoint whose files changed or whose revision differs. Checkpoints load only through
qwen-tts on CPU/CUDA; MLX refuses them. Checkpoints recorded by earlier placeholder runners have no
producing adapter or sealed revision and are refused with `409 CHECKPOINT_UNVERIFIED` rather than promoted.
Fixture tests prove this publication contract, not training quality. A real training run on supported
hardware is still pending in #8857. Operators should listen to each audition before promoting. The runtime is excluded from
Voice Studio assignment until repaired (issue #8857). Voice Studio does not
claim a Qwen runtime is working merely because its metadata exists.

The character Voice Lab's **Fine-Tuning** tab drives the whole run (#10400). On open it reads the profile's
runs from their `job.json` sidecars (`GET /api/voice/profiles/:id/fine-tune`, newest first), so a reload
recovers them. After that it applies `voice:fine-tune:updated` frames, which carry the whole job, on each
status change, each sealed checkpoint, and at most once a second during training. It does not poll. Each
checkpoint plays its audition from `/data/voice-profiles/…`. **Promote** is disabled, with the refusal
reason beside it, on any checkpoint the server would refuse. **Cancel** appears while a run is live. A voice
trains one run at a time (`409 FINE_TUNE_ALREADY_RUNNING`), and a cancelled run still counts until its
trainer process has exited (`processActive`). A
sidecar left `running` by a server restart is reported as `interrupted`, because its process is gone. Its
sealed checkpoints remain promotable.
