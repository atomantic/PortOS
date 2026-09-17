// Voice stack lifecycle — owns the whisper-server PM2 app and model/binary
// provisioning. Piper (TTS) is spawned per-request in services/voice/tts.js.

import { existsSync } from 'fs';
import { execFile } from '../../lib/childProcess.js';
import { promisify } from 'util';
import { basename, join } from 'path';
import { createServer } from 'net';
import { PATHS } from '../../lib/fileUtils.js';
import { execPm2, getAppStatus } from '../pm2.js';
import { expandPath, piperVoiceTildePath, voiceHome, IS_WIN, PIPER_BIN_NAME } from './config.js';
import { isReasoningModel } from './llm.js';
import {
  getVoiceProvisioner, DEFAULT_VOICE_BACKEND, sortPreferred, sizeOf, FAST_VOICE_MODEL_MAX_B,
} from './modelProvisioners.js';
import { getProviderById } from '../providers.js';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';
import { whichFirst } from '../../lib/processEnv.js';
import { PORTS } from '../../lib/ports.js';

export const pexec = promisify(execFile);

export const WHISPER_APP = 'portos-whisper';

// Thin re-export of the shared PATH probe so voice callers keep the local name.
export const which = (bin) => whichFirst(bin);

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
    // Qwen3 runtime owns its model readiness.
    out.ttsVoice = null;
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
    TTS_ENGINE: cfg.tts.engine || 'piper',
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
  const port = url.port || String(PORTS.WHISPER);

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

/**
 * The first model in `ids` that is fast, non-reasoning and tool-capable.
 *
 * Sequential on purpose. The capability check can be a per-model HTTP probe
 * (Ollama's /api/show), and we only need the FIRST match — a `Promise.all`
 * here would probe every installed model on an install with dozens of them to
 * answer a question the first hit already settles.
 */
const firstFastCapable = async (backend, ids) => {
  for (const id of ids) {
    if (isReasoningModel(id) || sizeOf(id) > FAST_VOICE_MODEL_MAX_B) continue;
    if (await backend.isToolCapable(id)) return id;
  }
  return null;
};

/**
 * The local backend voice should PROVISION models against for `cfg`, or null
 * when this provider needs no provisioning.
 *
 * Mirrors `resolveLlmEndpoint` in llm.js: voice falls back to the default
 * backend whenever the configured provider is missing, not api-type, or has no
 * endpoint — so a half-configured install still gets a working local model.
 * A provider that DOES resolve to a usable api-type endpoint serves its own
 * models (OpenAI, Groq, a remote vLLM), so there is nothing to install or
 * pre-warm and we return null rather than provisioning the wrong backend.
 */
const resolveVoiceProvisioner = async (cfg) => {
  const providerId = cfg?.llm?.provider || DEFAULT_VOICE_BACKEND;
  const local = getVoiceProvisioner(providerId);
  if (local) return local;
  const provider = await getProviderById(providerId).catch(() => null);
  // A usable remote provider needs no local provisioning.
  if (provider && provider.type === 'api' && provider.endpoint) return null;
  return getVoiceProvisioner(DEFAULT_VOICE_BACKEND);
};

/**
 * Ensure a fast, tool-capable model exists on the configured local backend,
 * installing one from the catalog-derived chain when none does.
 *
 * Only intervenes when the user opted in: voice on, tools on AND model is
 * 'auto'. An explicit model id means they know what they want — respect it
 * even if incompatible.
 *
 * The `enabled` gate is deliberately duplicated from `reconcile`'s early
 * return rather than left to the caller: this function downloads multi-GB
 * weights, so an install with voice OFF must never reach it even if a future
 * caller forgets the gate. `preloadModel` guards itself the same way.
 */
export const ensureToolCapableModel = async (cfg) => {
  if (!cfg?.enabled) return { skipped: 'voice-disabled' };
  if (!cfg?.llm?.tools?.enabled) return { skipped: 'tools-disabled' };
  if (cfg?.llm?.model && cfg.llm.model !== 'auto') return { skipped: 'explicit-model' };

  const backend = await resolveVoiceProvisioner(cfg);
  if (!backend) return { skipped: 'remote-provider', provider: cfg?.llm?.provider };

  const installed = await backend.listModels();
  // `null` = the backend could not be reached. Every entry in the install
  // chain would fail for that one shared reason, so say so ONCE and stop —
  // walking the chain here is what spawned four futile multi-GB downloads on
  // every boot of a machine whose local server simply wasn't running.
  if (installed === null) {
    console.warn(`🎙️  voice: ${backend.label} is not reachable — ${backend.remedy}`);
    return { skipped: 'backend-unreachable', backend: backend.id };
  }

  // Tool-capable AND non-reasoning AND under the size cap. The size cap
  // matters: a user with only `mistral-small-24B` installed gets a model that
  // thrashes VRAM on every turn; we'd rather pull a small one and give them
  // snappy responses out of the box.
  const fastCapable = await firstFastCapable(backend, installed);
  if (fastCapable) return { skipped: 'already-capable', model: fastCapable };

  // Snapshot the model set BEFORE install so we can detect which id the
  // backend actually registered the download under (ids get case-normalized or
  // gain a quant suffix). Without this snapshot we mis-attributed success to
  // whichever existing tool-capable model happened to match — including the
  // slow reasoning model we were trying to escape.
  const before = new Set(installed);
  const chain = backend.chain();
  if (!chain.length) {
    console.warn(`🎙️  voice: no catalog model with tool support is installable on ${backend.label} — set voice.llm.model explicitly in Settings`);
    return { skipped: 'no-install-target', backend: backend.id };
  }

  for (const target of chain) {
    console.log(`🎙️  voice: installing fast tool-capable model ${target} via ${backend.label} (this may take a few minutes)`);
    const outcome = await backend.install(target);
    const after = await backend.listModels();
    // The backend going away mid-chain is the same shared cause as above —
    // stop rather than retrying every remaining entry against a dead server.
    if (after === null) {
      console.warn(`🎙️  voice: ${backend.label} became unreachable during install — ${backend.remedy}`);
      return { skipped: 'backend-unreachable', backend: backend.id };
    }
    const fastNew = await firstFastCapable(backend, after.filter((id) => !before.has(id)));
    if (fastNew) {
      console.log(`🎙️  voice: fast tool-capable model ready — ${fastNew}`);
      return { installed: fastNew };
    }
    console.warn(`🎙️  voice: ${target} unavailable (${String(outcome?.reason || 'unknown').slice(0, 160)}) — trying next`);
  }
  console.warn(`🎙️  voice: exhausted ${backend.label} install chain ${chain.join(', ')} — set voice.llm.model explicitly in Settings`);
  return { failed: chain };
};

// Pre-warm the model that 'auto' will pick on the first turn so the user
// doesn't pay a 5–30 s cold-load on their first question. Skip when the chosen
// model is already resident: on LM Studio a second `lms load` spawns another
// INSTANCE of the same model (3 copies of qwen3-4b reported in the wild),
// eating multiples of its VRAM and producing "Model loading was stopped due to
// insufficient system resources" when nothing is actually wrong.
export const preloadModel = async (cfg) => {
  if (!cfg?.enabled) return { skipped: 'voice-disabled' };
  if (cfg?.llm?.model && cfg.llm.model !== 'auto') return { skipped: 'explicit-model' };

  const backend = await resolveVoiceProvisioner(cfg);
  if (!backend) return { skipped: 'remote-provider', provider: cfg?.llm?.provider };

  const installed = await backend.listModels();
  if (installed === null) return { skipped: 'backend-unreachable', backend: backend.id };
  if (!installed.length) return { skipped: 'no-models', backend: backend.id };

  // Rank first, then walk — so the tool-capability probe runs on the models we
  // would actually pick and stops at the winner, rather than on every model.
  const ranked = sortPreferred(installed);
  let target = ranked[0] || null;
  if (cfg.llm?.tools?.enabled) {
    for (const id of ranked) {
      if (await backend.isToolCapable(id)) { target = id; break; }
    }
  }
  if (!target) return { skipped: 'no-candidate' };

  const loaded = await backend.loadedModels();
  if (loaded.has(target)) {
    console.log(`🎙️  voice: ${target} already loaded — skipping preload`);
    return { skipped: 'already-loaded', model: target };
  }

  // The load blocks until ready (5–30 s cold). Run fire-and-forget so
  // reconcile returns immediately; whisper/TTS can come up in parallel.
  console.log(`🎙️  voice: preloading ${target} (warming GPU/cache for first turn)`);
  backend.load(target)
    .then((result) => (result?.ok
      ? console.log(`🎙️  voice: ${target} loaded and ready`)
      : console.warn(`🎙️  voice: preload ${target} failed: ${result?.reason || 'unknown'}`)))
    .catch((err) => console.warn(`🎙️  voice: preload ${target} failed: ${err.message}`));
  return { preloading: target };
};


/**
 * Reconcile PM2 state with desired voice.enabled. Called from
 * PUT /api/voice/config and at server boot.
 */
export const reconcile = async (cfg, { allowSetup = true } = {}) => {
  if (!cfg.enabled) return stopWhisper();
  // A retired-engine upgrade must wait for the user's Save & Reconcile action.
  // Do not turn a normal restart into a new binary/model download.
  if (!allowSetup && cfg.tts?.retiredEngine === 'kokoro') {
    const bins = await verifyBinaries(cfg);
    const models = verifyModels(cfg);
    if (bins.piperRequired && (!bins.piper || !models.ttsVoice)) {
      // Keep an already-provisioned speech recognizer available while TTS
      // waits for consent. No setup scripts or LLM preloads run on this path.
      if (cfg.stt?.engine === 'web-speech') {
        await stopWhisper().catch(() => null);
      } else if (bins.whisper && models.sttModel && (!cfg.stt.coreml || models.coreml)) {
        return { ...await startWhisper(cfg), setupRequired: 'piper' };
      }
      return { setupRequired: 'piper' };
    }
  }

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
