// Voice stack lifecycle — owns the whisper-server PM2 app and model/binary
// provisioning. Piper (TTS) is spawned per-request in services/voice/tts.js.

import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { basename, join } from 'path';
import { createServer } from 'net';
import { PATHS } from '../../lib/fileUtils.js';
import { execPm2, getAppStatus } from '../pm2.js';
import { expandPath, piperVoiceTildePath } from './config.js';

export const pexec = promisify(execFile);

export const WHISPER_APP = 'portos-whisper';

export const which = async (bin) => {
  const res = await pexec('which', [bin]).catch(() => null);
  return res?.stdout.trim() || null;
};

export const verifyBinaries = async (cfg) => {
  const [whisper, piper] = await Promise.all([which('whisper-server'), which('piper')]);
  // Only require piper when active engine actually uses it.
  const piperRequired = cfg?.tts?.engine === 'piper';
  return { whisper, piper, piperRequired };
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
  const scriptPath = join(PATHS.root, 'scripts', 'setup-voice.sh');
  const modelName = basename(expandPath(cfg.stt.modelPath));
  const voiceName = cfg.tts.engine === 'piper' ? parseVoiceName(expandPath(cfg.tts.piper.voicePath)) : '';
  const env = {
    ...process.env,
    MODEL_NAME: modelName,
    VOICE_NAME: voiceName,
    TTS_ENGINE: cfg.tts.engine || 'kokoro',
    INSTALL_COREML: cfg.stt.coreml ? '1' : '0',
  };
  console.log(`🔧 voice: setup-voice.sh (stt=${modelName}, tts=${cfg.tts.engine}, coreml=${env.INSTALL_COREML})`);
  // 10-minute cap — large models + slow network can legitimately take several
  // minutes, but a hung curl must not pin the HTTP request that triggered us.
  const { stdout, stderr } = await pexec('bash', [scriptPath], {
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
const probePortInUse = (host, port) => new Promise((resolve) => {
  const portNum = Number(port);
  const s = createServer();
  s.once('error', (err) => {
    s.close();
    resolve(err.code === 'EADDRINUSE' ? `port ${portNum} in use (${err.code})` : null);
  });
  s.once('listening', () => s.close(() => resolve(null)));
  s.listen(portNum, host);
});

// Poll until whisper's /inference endpoint answers (any HTTP status = bound),
// or give up after `timeoutMs`. Distinguishes "bound but slow" from "crashed".
const waitForWhisper = async (host, port, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  const url = `http://${host}:${port}/`;
  while (Date.now() < deadline) {
    const ok = await fetch(url, { method: 'GET' }).then(() => true).catch(() => false);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 250));
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
  const occupied = await probePortInUse(host, port);
  if (occupied) {
    throw new Error(`${occupied} — another service is bound to ${host}:${port}. Change voice.stt.endpoint (e.g. http://127.0.0.1:5563) under Settings → Voice.`);
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
 * Reconcile PM2 state with desired voice.enabled. Called from
 * PUT /api/voice/config and at server boot.
 */
export const reconcile = async (cfg) => {
  if (!cfg.enabled) return stopWhisper();

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
