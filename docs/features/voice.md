# Voice Mode

PortOS includes an optional push-to-talk voice assistant that runs entirely on your machine. No audio ever leaves your computer.

## Stack

| Stage | Default engine | Alternatives | Local? |
|-------|----------------|--------------|--------|
| Speech-to-text | [whisper.cpp](https://github.com/ggerganov/whisper.cpp) via `whisper-server` (HTTP :8080) | — | ✅ |
| LLM | LM Studio (`/v1/chat/completions`) | OpenAI-compatible local server | ✅ |
| Text-to-speech | [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) via `kokoro-js` (in-process) | [Piper](https://github.com/rhasspy/piper) (CLI) | ✅ |
| Voice activity | Browser `MediaRecorder` (push-to-talk) | — | ✅ |

The TTS engine is selectable in **Settings → Voice → TTS engine**.

### Why Kokoro is the default

Kokoro is a 82M-parameter frontier TTS model that runs in-process via ONNX Runtime + transformers.js — **no Python, no extra binaries, cross-platform**. Quality is significantly higher than Piper (more natural prosody, expressive pacing). First synthesis after server start has a 2–3 s cold start as the model loads; warm calls are 200–500 ms per sentence on CPU.

Use **Piper** instead if you need lower latency per call (~100 ms cold start), are on a memory-constrained machine, or want a particular pre-trained voice from rhasspy's catalogue.

## First-time setup

1. Open PortOS → **Settings → Voice**.
2. Pick your TTS engine (default: Kokoro), Whisper model size, and CoreML toggle (macOS).
3. Toggle **Enable voice mode** and click **Save & Reconcile**.

PortOS will:
- Install `whisper-cpp` (and `piper-tts` if you chose Piper) via Homebrew if missing
- Download the selected Whisper GGUF model into `~/.portos/voice/models/`
- On macOS with CoreML enabled, download the matching `<model>-encoder.mlmodelc` (2–3× faster STT on Apple Silicon)
- Download Piper voice ONNX into `~/.portos/voice/voices/` (Piper engine only)
- Start `portos-whisper` under PM2

Kokoro models live under `~/.cache/huggingface/hub/` and download lazily on first synthesis.

You can also run the bootstrap script directly:

```bash
TTS_ENGINE=kokoro INSTALL_COREML=1 bash scripts/setup-voice.sh
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
| `stt.coreml` | `true` (macOS) | Use CoreML encoder companion. |
| `stt.endpoint` | `http://127.0.0.1:8080` | whisper-server listen address. |
| `tts.engine` | `kokoro` | `kokoro` or `piper` |
| `tts.rate` | `1.0` | Speech rate, 0.5–2.0 |
| `tts.kokoro.voice` | `af_heart` | See [Kokoro voices](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) — A-grade are `af_heart`, `af_bella`. |
| `tts.kokoro.dtype` | `q8` | `q4` · `q8` · `fp16` · `fp32` (size/quality trade-off) |
| `tts.kokoro.modelId` | `onnx-community/Kokoro-82M-v1.0-ONNX` | HuggingFace repo id |
| `tts.piper.voice` | `en_US-ryan-high` | Piper voice id (path-encoded) |
| `tts.piper.voicePath` | `~/.portos/voice/voices/<voice>.onnx` | ONNX file location |
| `llm.model` | `auto` | `auto` picks first loaded LM Studio model |
| `llm.systemPrompt` | (concise voice prompt) | Edit to change personality |

## Using voice mode

- Click and hold the mic in the lower-right or hold the configured hotkey to speak.
- Release to send. You'll see `you: …` (transcript) then `assistant: …` streaming as the LLM responds.
- Start a new turn while the assistant is speaking to interrupt (barge-in).
- Click the square button during playback to stop the current utterance.

The hotkey ignores keypresses while inputs/textareas are focused.

## Architecture

```
browser mic → MediaRecorder → Socket.IO 'voice:turn'
  → whisper.cpp /inference          (STT, with CoreML encoder on Apple Silicon)
  → LM Studio /v1/chat (streaming)  (LLM)
  → sentence-boundary TTS dispatch  (Kokoro in-process | Piper CLI)
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

Socket events are documented in `server/sockets/voice.js`.

## Troubleshooting

- **Whisper badge red** — `brew install whisper-cpp`, then `which whisper-server`.
- **CoreML missing** — re-run `INSTALL_COREML=1 bash scripts/setup-voice.sh` (or toggle voice off/on after enabling CoreML).
- **Kokoro shows `lazy`** — model loads on first synthesis. Hit "Test voice" to warm it up.
- **Kokoro slow on first call** — first call after server start downloads model (~80 MB for q8) and initializes the runtime. Subsequent calls are 200–500 ms.
- **Piper spawn fails** — `which piper` and check voice file at `~/.portos/voice/voices/<name>.onnx`.
- **LM Studio red** — start LM Studio and load a chat model; the voice pipeline uses `/v1/chat/completions`.
- **No audio playback** — browsers require a user gesture before AudioContext can play. Click the page once or press the mic button.

## Performance notes

| Engine | Cold start | Warm latency (per sentence) | Quality |
|--------|------------|------------------------------|---------|
| Kokoro q8 (CPU) | 2–3 s | 200–500 ms | High |
| Kokoro fp32 (CPU) | 3–5 s | 400–900 ms | Highest |
| Piper | ~100 ms (CLI spawn) | ~100 ms | Mid |
| Whisper base.en (no CoreML) | 0 (server resident) | 400–800 ms / 2 s of audio | Good |
| Whisper base.en + CoreML | 0 | 150–300 ms / 2 s of audio | Good |
| Whisper small.en + CoreML | 0 | 300–600 ms / 2 s of audio | Better |
