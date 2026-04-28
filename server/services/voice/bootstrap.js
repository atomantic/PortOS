// Voice stack lifecycle — owns the whisper-server PM2 app and model/binary
// provisioning. Piper (TTS) is spawned per-request in services/voice/tts.js.

import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { basename, join } from 'path';
import { createServer } from 'net';
import { PATHS } from '../../lib/fileUtils.js';
import { execPm2, getAppStatus } from '../pm2.js';
import { expandPath, piperVoiceTildePath, voiceHome, IS_WIN, PIPER_BIN_NAME } from './config.js';
import { isToolCapable, isReasoningModel } from './llm.js';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';

export const pexec = promisify(execFile);

export const WHISPER_APP = 'portos-whisper';

export const which = async (bin) => {
  const res = await pexec(IS_WIN ? 'where' : 'which', [bin]).catch(() => null);
  return res?.stdout?.split(/\r?\n/)[0]?.trim() || null;
};

export const verifyBinaries = async (cfg) => {
  const piperLocal = join(voiceHome(), 'piper', PIPER_BIN_NAME);
  const piperResolved = existsSync(piperLocal) ? piperLocal : null;
  // Only search PATH when piper isn't locally installed — spawning `where`/`which` is expensive.
  const [whisper, piperOnPath] = await Promise.all([
    which('whisper-server'),
    piperResolved ? Promise.resolve(null) : which('piper'),
  ]);
  const piperRequired = cfg?.tts?.engine === 'piper';
  return { whisper, piper: piperResolved ?? piperOnPath, piperRequired };
};

export const verifyModels = (cfg) => {
  const modelPath = expandPath(cfg.stt.modelPath);
  const out = { sttModel: existsSync(modelPath) ? modelPath : null };

  if (cfg.tts.engine === 'piper') {
    const voicePath = expandPath(cfg.tts.piper.voicePath);
    out.ttsVoice = existsSync(voicePath) ? voicePath : null;
  } else {
    // Kokoro models are managed by transformers.js cache — assume present.
    out.ttsVoice = `kokoro:${cfg.tts.kokoro?.modelId}`;
  }

  if (cfg.stt.coreml) {
    const mlPath = modelPath.replace(/\.bin$/, '-encoder.mlmodelc');
    out.coreml = existsSync(mlPath) ? mlPath : null;
  }
  return out;
};

const parseVoiceName = (voicePath) => basename(voicePath).replace(/\.onnx$/, '');

export const runSetupScript = async (cfg) => {
  const modelName = basename(expandPath(cfg.stt.modelPath));
  const voiceName = cfg.tts.engine === 'piper' ? parseVoiceName(expandPath(cfg.tts.piper.voicePath)) : '';
  const sttEngine = cfg.stt?.engine || 'whisper';
  const env = {
    ...process.env,
    MODEL_NAME: modelName,
    VOICE_NAME: voiceName,
    STT_ENGINE: sttEngine,
    TTS_ENGINE: cfg.tts.engine || 'kokoro',
    INSTALL_COREML: cfg.stt.coreml ? '1' : '0',
  };
  console.log(`🔧 voice: setup-voice (stt=${sttEngine}/${modelName}, tts=${cfg.tts.engine}, coreml=${env.INSTALL_COREML})`);
  // 10-minute cap — large models + slow network can legitimately take several
  // minutes, but a hung curl must not pin the HTTP request that triggered us.
  // On Windows prefer pwsh (PowerShell 7+) but fall back to the always-present
  // Windows PowerShell when pwsh isn't installed.
  let cmd;
  let args;
  if (IS_WIN) {
    const psBin = (await which('pwsh')) ? 'pwsh' : 'powershell';
    cmd = psBin;
    args = ['-ExecutionPolicy', 'Bypass', '-File', 'scripts\\setup-voice.ps1'];
  } else {
    cmd = 'bash';
    args = ['scripts/setup-voice.sh'];
  }
  const { stdout, stderr } = await pexec(cmd, args, {
    cwd: PATHS.root,
    env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });
  return { stdout, stderr };
};

/**
 * Download a single Piper voice without touching whisper/STT state. Used by
 * the Settings voice-picker so users can audition voices as they browse the
 * catalog rather than waiting for Save & Reconcile.
 */
export const downloadPiperVoice = async (voiceId, currentCfg) => {
  if (!voiceId || typeof voiceId !== 'string') throw new Error('voiceId required');
  const voicePath = piperVoiceTildePath(voiceId);
  if (existsSync(expandPath(voicePath))) return { skipped: true, voicePath };
  // Re-use the existing setup script but force it into Piper-only mode. The
  // script already short-circuits whisper steps when the model/binary are
  // present, so this is cheap on repeat invocations.
  await runSetupScript({
    ...currentCfg,
    tts: { engine: 'piper', piper: { voicePath } },
  });
  return { downloaded: true, voicePath };
};

const isWhisperRunning = async () => {
  const status = await getAppStatus(WHISPER_APP).catch(() => null);
  return status?.status === 'online';
};

// Returns null if the port is free, else a short description of who's there.
// `port` MUST be coerced to a number — `net.Server.listen(stringPort)` is
// interpreted as a pipe path and silently misses real TCP port collisions.
// Any listen() error other than EADDRINUSE (EACCES, EADDRNOTAVAIL, EINVAL…)
// indicates endpoint misconfiguration — surface it instead of silently
// proceeding to a more confusing PM2 failure downstream.
const probePortInUse = (host, port) => new Promise((resolve) => {
  const portNum = Number(port);
  const s = createServer();
  s.once('error', (err) => {
    s.close();
    if (err.code === 'EADDRINUSE') {
      resolve(`port ${portNum} in use (${err.code})`);
    } else {
      resolve(`cannot bind ${host}:${portNum} (${err.code || err.message})`);
    }
  });
  s.once('listening', () => s.close(() => resolve(null)));
  s.listen(portNum, host);
});

// Poll until whisper's /inference endpoint answers (any HTTP status = bound),
// or give up after `timeoutMs`. Distinguishes "bound but slow" from "crashed".
// Each probe has its own abort-based timeout so a hung connect (firewall,
// half-open socket) can't stall the loop past the overall deadline.
const waitForWhisper = async (host, port, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  const url = `http://${host}:${port}/`;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const probeTimeout = Math.max(1, Math.min(1000, remaining));
    const ok = await fetchWithTimeout(url, { method: 'GET' }, probeTimeout)
      .then(() => true)
      .catch(() => false);
    if (ok) return true;
    const sleep = Math.min(250, Math.max(0, deadline - Date.now()));
    if (sleep > 0) await new Promise((r) => setTimeout(r, sleep));
  }
  return false;
};

export const startWhisper = async (cfg) => {
  const whisperBin = await which('whisper-server');
  if (!whisperBin) throw new Error('whisper-server not on PATH — run scripts/setup-voice.sh');
  const modelPath = expandPath(cfg.stt.modelPath);
  if (!existsSync(modelPath)) throw new Error(`whisper model missing: ${modelPath}`);

  const url = new URL(cfg.stt.endpoint);
  const host = url.hostname;
  const port = url.port || '5562';

  // Delete stale PM2 entry so our own previous instance doesn't count as a collision.
  await execPm2(['delete', WHISPER_APP]).catch(() => {});

  // Pre-flight: refuse to start if something ELSE is already on the port —
  // whisper-server crashes on bind failure and takes the model with it.
  // Distinguish "port collision" (use a different port) from "bind error"
  // (EACCES / EINVAL / EADDRNOTAVAIL → host/IP itself is wrong).
  const occupied = await probePortInUse(host, port);
  if (occupied) {
    if (/EADDRINUSE|in use/i.test(occupied)) {
      throw new Error(`${occupied} — another service is bound to ${host}:${port}. Change voice.stt.endpoint (e.g. http://127.0.0.1:5563) under Settings → Voice.`);
    }
    throw new Error(`${occupied} — voice.stt.endpoint is misconfigured for ${host}:${port}. Check Settings → Voice and ensure the host/IP is valid and bindable on this machine.`);
  }

  await execPm2([
    'start', whisperBin,
    '--name', WHISPER_APP,
    '--interpreter', 'none',
    '--no-autorestart',
    '--',
    '--host', host, '--port', port, '--model', modelPath,
  ]);

  // Verify the server actually bound. whisper-server returns 0 to PM2 even
  // when it aborts on bind failure, so we can't trust pm2 exit status alone.
  const bound = await waitForWhisper(host, port);
  if (!bound) {
    await execPm2(['delete', WHISPER_APP]).catch(() => {});
    throw new Error(`whisper-server failed to bind on ${host}:${port} within 8s — check pm2 logs ${WHISPER_APP}`);
  }

  console.log(`🎙️  voice: ${WHISPER_APP} up on ${host}:${port} (model=${modelPath})`);
  return { name: WHISPER_APP, host, port, modelPath };
};

export const stopWhisper = async () => {
  if (!(await isWhisperRunning())) return { skipped: true };
  await execPm2(['delete', WHISPER_APP]).catch(() => {});
  console.log(`🛑 voice: ${WHISPER_APP} stopped`);
  return { stopped: true };
};

// Default tool-capable model to auto-install via `lms get` when the user has
// voice.enabled + tools.enabled + model='auto' but LM Studio has no model that
// speaks OpenAI structured tool_calls. We try a small list in order — first
// one resolved successfully wins. Picks favor: small (≤7B), explicitly
// non-reasoning ("instruct"/"2507" non-thinking variants), and currently
// available in the LM Studio Hub catalog (the catalog evolves, so we try
// newer slugs first and keep older ones as fallbacks). Override the entire
// chain with PORTOS_VOICE_DEFAULT_TOOL_MODEL (single id).
const DEFAULT_TOOL_MODEL_CHAIN = () => {
  const override = process.env.PORTOS_VOICE_DEFAULT_TOOL_MODEL;
  if (override) return [override];
  return [
    'qwen/qwen3-4b-2507',                             // 4B, non-thinking, ~2.3 GB MLX, fast TTFT
    'qwen/qwen3.5-9b',                                // 9B, current Qwen3.5 line
    'lmstudio-community/Qwen2.5-7B-Instruct-GGUF',    // older, kept for older catalogs
    'meta-llama/Llama-3.1-8B-Instruct',               // Llama fallback
  ];
};

const LMS_BASE = () => (process.env.LM_STUDIO_URL || 'http://localhost:1234')
  .replace(/\/+$/, '').replace(/\/v1$/, '');

const listLmStudioModels = async () => {
  const res = await fetch(`${LMS_BASE()}/v1/models`).catch(() => null);
  if (!res?.ok) return [];
  const body = await res.json().catch(() => ({}));
  return (body?.data || []).map((m) => m.id);
};

// Approximate parameter count from id, mirroring `sizeRank` in llm.js but
// hoisted here so bootstrap doesn't need to import it. Returns Infinity for
// model ids without a `<n>B` suffix (utility models, embeddings, etc.).
const sizeOf = (id) => {
  const n = String(id).toLowerCase();
  const moe = n.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*b\b/);
  if (moe) return parseFloat(moe[1]) * parseFloat(moe[2]);
  const m = n.match(/(\d+(?:\.\d+)?)\s*b\b/);
  return m ? parseFloat(m[1]) : Infinity;
};

// Above this rough parameter count (in B), a model is too heavy for a
// snappy single-user voice agent on Apple Silicon — TTFT balloons and
// it competes for VRAM with anything else loaded. We treat "tool-capable
// but huge" as effectively missing and install a small one alongside.
const FAST_VOICE_MODEL_MAX_B = 10;

export const ensureToolCapableModel = async (cfg) => {
  // Only intervene when the user opted in: tools on AND model is 'auto'.
  // An explicit model id means they know what they want — respect it even
  // if incompatible.
  if (!cfg?.llm?.tools?.enabled) return { skipped: 'tools-disabled' };
  if (cfg?.llm?.model && cfg.llm.model !== 'auto') return { skipped: 'explicit-model' };

  const installed = await listLmStudioModels();
  // Tool-capable AND non-reasoning AND under the size cap. The size cap is
  // important: a user with only `mistral-small-24B` installed gets a model
  // that thrashes VRAM on every turn; we'd rather download Qwen2.5-7B and
  // give them snappy responses out of the box.
  const fastCapable = installed.find(
    (id) => isToolCapable(id) && !isReasoningModel(id) && sizeOf(id) <= FAST_VOICE_MODEL_MAX_B
  );
  if (fastCapable) {
    return { skipped: 'already-capable', model: fastCapable };
  }

  const lms = await which('lms');
  if (!lms) {
    console.warn(`🎙️  voice: no fast tool-capable model installed and 'lms' CLI not on PATH — install LM Studio CLI or set voice.llm.model explicitly.`);
    return { skipped: 'no-lms-cli' };
  }

  // Snapshot the model set BEFORE install so we can detect which id LM Studio
  // actually registered the new download under (LM Studio sometimes
  // normalizes case or appends quant suffix). Without this snapshot we
  // mis-attributed success to whichever existing tool-capable model
  // happened to match — including the slow 14B reasoning model we were
  // trying to escape.
  const before = new Set(installed);
  const chain = DEFAULT_TOOL_MODEL_CHAIN();
  for (const target of chain) {
    console.log(`🎙️  voice: installing fast tool-capable model ${target} via lms get (this may take a few minutes)`);
    const { stdout, stderr } = await pexec(lms, ['get', '-y', target], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
    }).catch((err) => ({ stdout: '', stderr: err?.message || String(err) }));
    const after = await listLmStudioModels();
    const newOnes = after.filter((id) => !before.has(id));
    const fastNew = newOnes.find(
      (id) => isToolCapable(id) && !isReasoningModel(id) && sizeOf(id) <= FAST_VOICE_MODEL_MAX_B
    );
    if (fastNew) {
      console.log(`🎙️  voice: fast tool-capable model ready — ${fastNew}`);
      return { installed: fastNew };
    }
    if (stderr && /not exist|not found|permission|failed/i.test(stderr)) {
      console.warn(`🎙️  voice: ${target} unavailable (${stderr.split('\n').pop().slice(0, 160)}) — trying next`);
      continue;
    }
    console.warn(`🎙️  voice: lms get ${target} returned but no new fast model detected — trying next`);
  }
  console.warn(`🎙️  voice: exhausted install chain ${chain.join(', ')} — set voice.llm.model explicitly in Settings`);
  return { failed: chain };
};

// Returns the set of model keys currently loaded in LM Studio (per `lms ps`).
// `lms load` is NOT idempotent in practice — re-loading an already-loaded
// model spawns a SECOND instance of it, doubling VRAM. Worse, when VRAM is
// full the second load fails with "Model loading was stopped due to
// insufficient system resources" and our preload reports as failed even
// though the original instance is fine. Always check `lms ps` first.
const listLoadedModelKeys = async () => {
  const lms = await which('lms');
  if (!lms) return new Set();
  const { stdout } = await pexec(lms, ['ps', '--json'], { timeout: 10_000 })
    .catch(() => ({ stdout: '' }));
  try {
    const arr = JSON.parse(stdout || '[]');
    return new Set(arr.map((m) => m.modelKey).filter(Boolean));
  } catch {
    return new Set();
  }
};

// Pre-warm the model that 'auto' will pick on the first turn so the user
// doesn't pay a 5–30 s cold-load on their first question. Skip when the
// chosen model is already loaded — see `listLoadedModelKeys` for why "skip
// if loaded" matters more than just being efficient.
export const preloadModel = async (cfg) => {
  if (!cfg?.enabled) return { skipped: 'voice-disabled' };
  if (cfg?.llm?.model && cfg.llm.model !== 'auto') return { skipped: 'explicit-model' };
  const lms = await which('lms');
  if (!lms) return { skipped: 'no-lms-cli' };
  const installed = await listLmStudioModels();
  if (!installed.length) return { skipped: 'no-models' };

  const sortPreferred = (list) => list.slice().sort((a, b) => {
    const ar = isReasoningModel(a) ? 1 : 0;
    const br = isReasoningModel(b) ? 1 : 0;
    if (ar !== br) return ar - br;
    return sizeOf(a) - sizeOf(b);
  });

  const wantsTools = !!cfg.llm?.tools?.enabled;
  const candidates = wantsTools ? installed.filter(isToolCapable) : installed;
  const target = sortPreferred(candidates)[0] || sortPreferred(installed)[0];
  if (!target) return { skipped: 'no-candidate' };

  // CRITICAL: skip the load if the model is already in `lms ps`. Otherwise
  // every server restart spawns another instance of the same model in
  // LM Studio (3 copies of qwen3-4b reported in the wild), eating multiples
  // of its VRAM and causing OOM-style "Model loading was stopped due to
  // insufficient system resources" errors when nothing is actually wrong.
  const loaded = await listLoadedModelKeys();
  if (loaded.has(target)) {
    console.log(`🎙️  voice: ${target} already loaded — skipping preload`);
    return { skipped: 'already-loaded', model: target };
  }

  // `lms load` blocks until ready (5-30s cold). Run as fire-and-forget so
  // reconcile returns immediately; whisper/TTS can come up in parallel.
  console.log(`🎙️  voice: preloading ${target} (warming GPU/cache for first turn)`);
  pexec(lms, ['load', target], { timeout: 5 * 60 * 1000 })
    .then(() => console.log(`🎙️  voice: ${target} loaded and ready`))
    .catch((err) => console.warn(`🎙️  voice: preload ${target} failed: ${err.message}`));
  return { preloading: target };
};

/**
 * Reconcile PM2 state with desired voice.enabled. Called from
 * PUT /api/voice/config and at server boot.
 */
export const reconcile = async (cfg) => {
  if (!cfg.enabled) return stopWhisper();

  // Don't block reconcile on this — it can take minutes on first install.
  // The user will see a clear log line and their first turn may fail with the
  // new `voice:error` hint until the model finishes downloading, but voice
  // STT + TTS + whisper are ready immediately. Once install resolves (or
  // immediately if no install was needed), pre-warm the chosen model so the
  // first voice turn doesn't pay a 5-30s cold-load.
  ensureToolCapableModel(cfg)
    .catch((err) => {
      console.warn(`🎙️  voice: ensureToolCapableModel failed: ${err.message}`);
    })
    .then(() => preloadModel(cfg))
    .catch((err) => {
      console.warn(`🎙️  voice: preloadModel failed: ${err.message}`);
    });

  const bins = await verifyBinaries(cfg);
  const models = verifyModels(cfg);
  const piperMissing = bins.piperRequired && (!bins.piper || !models.ttsVoice);
  const webSpeech = cfg.stt?.engine === 'web-speech';

  // Web Speech STT runs entirely in the browser — stop any leftover whisper
  // instance and skip STT provisioning. Piper voice provisioning still runs.
  if (webSpeech) {
    if (piperMissing) await runSetupScript(cfg);
    await stopWhisper().catch(() => null);
    return { skipped: 'web-speech', piperProvisioned: piperMissing };
  }

  const coremlMissing = cfg.stt.coreml && !models.coreml;
  const sttMissing = !bins.whisper || !models.sttModel || coremlMissing;
  if (piperMissing || sttMissing) await runSetupScript(cfg);

  return startWhisper(cfg);
};
