/**
 * Speech-to-text for Music Video lyric alignment.
 *
 * Voice chat's STT is off by default (the browser does it) and its whisper
 * model is `base.en`, which is too weak for a sung vocal. Alignment therefore
 * brings its own runner and never asks the director to enable voice:
 *
 *   1. `whisper-cli` on PATH → one-shot run over the whole decoded song with a
 *      music-grade model (large-v3-turbo), word timestamps from its `-ojf`
 *      JSON. A 3–4 minute song takes seconds on Apple Silicon.
 *   2. The configured voice STT endpoint, when something answers there.
 *   3. `whisper-server` on PATH → a temporary loopback server on a free port
 *      with the music-grade model, stopped when the alignment finishes.
 *   4. None of these → 503 with how to install whisper.cpp.
 *
 * The model downloads on the first alignment that needs it (a user click or
 * an autopilot run the user started — never at boot) into the same folder
 * voice uses, through a `.partial` file renamed into place when complete.
 *
 * A transcriber is `{ kind, transcribe(wav, { startSec, endSec, prompt }), release() }`
 * where `transcribe` returns words on the SONG clock.
 */

import { existsSync } from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { createServer } from 'net';
import { homedir, tmpdir } from 'os';
import { basename, join } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { spawn } from '../../lib/childProcess.js';
import { whichFirst } from '../../lib/processEnv.js';
import { runStreamingCommand } from '../../lib/streamingSpawn.js';
import { streamResumableDownload } from '../../lib/downloadPreflight.js';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { getVoiceConfig, expandPath } from '../voice/config.js';
import { transcribe as sttTranscribe } from '../voice/stt.js';
import {
  explainSttFailure,
  lyricAlignChunkSec,
  mergeChunkWords,
  parseWhisperCliWords,
  planAudioChunks,
  sliceWav,
  wavDurationSec,
} from './lyricAlignCore.js';

export const ALIGN_MODEL_FILE = 'ggml-large-v3-turbo.bin';
export const ALIGN_MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${ALIGN_MODEL_FILE}`;
export const alignModelDir = () => join(homedir(), '.portos', 'voice', 'models');

// Homebrew's whisper-cpp ships `whisper-cli`; older builds named it `whisper-cpp`.
const WHISPER_CLI_NAMES = ['whisper-cli', 'whisper-cpp'];
const CLI_TIMEOUT_MS = 15 * 60 * 1000;
const SERVER_BOOT_MS = 90_000;
const ENDPOINT_PROBE_MS = 1500;

export const WHISPER_MISSING_MESSAGE = 'Aligning words needs whisper.cpp, and none was found on this machine. '
  + 'Install it (macOS: `brew install whisper-cpp`; Linux/Windows: build whisper.cpp so `whisper-cli` is on PATH, '
  + 'or run scripts/setup-voice.sh), then click Align words again.';

let modelDownload = null;

async function downloadAlignmentModel(target, { download = streamResumableDownload } = {}) {
  console.log(`⬇️ Downloading whisper alignment model ${ALIGN_MODEL_FILE} (about 1.6 GB, first alignment only)`);
  let lastDecile = -1;
  await download({
    url: ALIGN_MODEL_URL,
    destPath: target,
    onBytes: (received, total) => {
      if (!(total > 0)) return;
      const decile = Math.floor((received / total) * 10);
      if (decile === lastDecile) return;
      lastDecile = decile;
      console.log(`⬇️ Whisper alignment model ${decile * 10}% (${Math.round(received / 1e6)} of ${Math.round(total / 1e6)} MB)`);
    },
  });
  console.log(`✅ Whisper alignment model ready at ${target}`);
}

/**
 * Path of a music-grade whisper model, downloading large-v3-turbo on first
 * use. A `large` model the voice settings already point at is used as is.
 * Concurrent callers share one download.
 */
async function ensureAlignmentModel({ configuredModelPath = null, download } = {}) {
  const target = join(alignModelDir(), ALIGN_MODEL_FILE);
  if (existsSync(target)) return target;
  if (configuredModelPath && /large/i.test(basename(configuredModelPath)) && existsSync(configuredModelPath)) {
    return configuredModelPath;
  }
  if (!modelDownload) {
    modelDownload = downloadAlignmentModel(target, { download }).finally(() => { modelDownload = null; });
  }
  await modelDownload.catch((err) => {
    console.error(`❌ Whisper alignment model download failed: ${err.message}`);
    throw new ServerError(`Could not download the whisper alignment model: ${err.message}`, { status: 502, code: 'LYRIC_ALIGN_MODEL_DOWNLOAD_FAILED' });
  });
  return target;
}

/** whisper-cli argv for one WAV file; JSON lands at `${outBase}.json`. */
function whisperCliArgs({ modelPath, wavPath, outBase, language = 'en', prompt = '' }) {
  const args = ['-m', modelPath, '-f', wavPath, '-l', language, '-ml', '1', '-sow', '-ojf', '-of', outBase, '-np'];
  if (prompt) args.push('--prompt', prompt);
  return args;
}

function regionOf(wav, { startSec, endSec } = {}) {
  const duration = wavDurationSec(wav);
  if (!(duration > 0)) {
    throw new ServerError('Could not read the decoded vocal.', { status: 422, code: 'LYRIC_ALIGN_DECODE_FAILED' });
  }
  const start = Math.max(0, startSec || 0);
  const end = Math.min(duration, endSec ?? duration);
  if (!(end > start)) {
    throw new ServerError('That lyric line has no audio window to align.', { status: 422, code: 'LYRIC_ALIGN_NO_WINDOW' });
  }
  return { startSec: start, endSec: end, whole: start === 0 && end === duration };
}

/** One-shot whisper-cli transcriber. */
function createCliTranscriber({ bin, modelPath, language = 'en', run = runStreamingCommand }) {
  return {
    kind: 'whisper-cli',
    async transcribe(wav, { startSec, endSec, prompt = '' } = {}) {
      const region = regionOf(wav, { startSec, endSec });
      const dir = await mkdtemp(join(tmpdir(), 'lyric-align-cli-'));
      try {
        const wavPath = join(dir, 'audio.wav');
        const outBase = join(dir, 'words');
        await writeFile(wavPath, region.whole ? wav : sliceWav(wav, region.startSec, region.endSec));
        const result = await run(bin, whisperCliArgs({ modelPath, wavPath, outBase, language, prompt }), null, { timeoutMs: CLI_TIMEOUT_MS });
        if (!result?.success) {
          console.error(`❌ whisper-cli failed: ${result?.error || 'unknown error'}`);
          throw new ServerError(`whisper-cli could not transcribe the song: ${result?.error || 'unknown error'}`, { status: 502, code: 'LYRIC_ALIGN_WHISPER_FAILED' });
        }
        const raw = await readFile(`${outBase}.json`, 'utf8').catch(() => null);
        const parsed = raw ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : null;
        if (!parsed) {
          throw new ServerError('whisper-cli wrote no readable word timings.', { status: 502, code: 'LYRIC_ALIGN_WHISPER_FAILED' });
        }
        return parseWhisperCliWords(parsed).map((word) => ({
          ...word,
          startSec: word.startSec + region.startSec,
          endSec: word.endSec + region.startSec,
        }));
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
    release: async () => {},
  };
}

/**
 * Transcriber over a whisper.cpp HTTP server (the voice endpoint or a
 * temporary one): the region is chunked so each request fits the STT timeout.
 */
function createEndpointTranscriber({ endpoint = null, kind = 'stt-endpoint', transcribe = sttTranscribe, release = async () => {} }) {
  return {
    kind,
    async transcribe(wav, { startSec, endSec, prompt = '' } = {}) {
      const region = regionOf(wav, { startSec, endSec });
      const chunks = planAudioChunks(region.endSec - region.startSec, { chunkSec: lyricAlignChunkSec() }).map((chunk) => ({
        startSec: region.startSec + chunk.startSec,
        endSec: region.startSec + chunk.endSec,
      }));
      console.log(`🎤 Aligning lyric words (${chunks.length} whisper ${chunks.length === 1 ? 'chunk' : 'chunks'} via ${kind})`);
      const results = [];
      for (const chunk of chunks) {
        let result;
        try {
          result = await transcribe(sliceWav(wav, chunk.startSec, chunk.endSec), {
            verbose: true,
            mimeType: 'audio/wav',
            filename: 'lyric-align.wav',
            prompt,
            ...(endpoint ? { endpoint } : {}),
          });
        } catch (err) {
          console.error(`❌ Lyric alignment speech-to-text failed: ${err.message}`);
          throw new ServerError(explainSttFailure(err), { status: 503, code: 'LYRIC_ALIGN_STT_UNAVAILABLE' });
        }
        results.push({
          startSec: chunk.startSec,
          endSec: chunk.endSec,
          words: (result?.words || []).map((word) => ({ text: word.text, startSec: word.startSec, endSec: word.endSec })),
        });
      }
      return mergeChunkWords(results);
    },
    release,
  };
}

/** True when anything answers HTTP at the endpoint (any status = bound). */
async function probeSttEndpoint(endpoint) {
  if (!endpoint) return false;
  return fetchWithTimeout(`${String(endpoint).replace(/\/+$/, '')}/`, { method: 'GET' }, ENDPOINT_PROBE_MS)
    .then(() => true)
    .catch(() => false);
}

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Start a private whisper-server for this alignment; resolves `{ endpoint, stop }`. */
async function startTemporaryWhisperServer({ bin, modelPath }) {
  const port = await freeLoopbackPort();
  const endpoint = `http://127.0.0.1:${port}`;
  const child = spawn(bin, ['--host', '127.0.0.1', '--port', String(port), '--model', modelPath], { stdio: 'ignore' });
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.on('error', (err) => {
    exited = true;
    console.error(`❌ Temporary whisper-server failed: ${err.message}`);
  });
  const stop = async () => {
    if (exited) return;
    killWithEscalation(child, { label: 'temporary whisper-server', stillRunning: () => !exited });
  };
  const deadline = Date.now() + SERVER_BOOT_MS;
  while (Date.now() < deadline && !exited) {
    if (await probeSttEndpoint(endpoint)) {
      console.log(`🎙️ Temporary whisper-server up on ${endpoint} for lyric alignment`);
      return { endpoint, stop };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  await stop();
  throw new ServerError('The temporary whisper server did not start. Check that whisper-server runs from a terminal.', { status: 503, code: 'LYRIC_ALIGN_STT_UNAVAILABLE' });
}

async function firstOnPath(names, which) {
  for (const name of names) {
    const found = await which(name);
    if (found) return found;
  }
  return null;
}

/**
 * Pick the runner for this alignment (see the module header for the order).
 * Every dependency is injectable so selection is testable without binaries.
 */
export async function resolveAlignmentTranscriber(deps = {}) {
  const {
    which = whichFirst,
    voiceConfig = getVoiceConfig,
    probeEndpoint = probeSttEndpoint,
    ensureModel = ensureAlignmentModel,
    runCommand = runStreamingCommand,
    startServer = startTemporaryWhisperServer,
    transcribe = sttTranscribe,
  } = deps;
  const cfg = await voiceConfig().catch(() => null);
  const language = cfg?.stt?.language || 'en';
  const configuredModelPath = cfg?.stt?.modelPath ? expandPath(cfg.stt.modelPath) : null;

  const cli = await firstOnPath(WHISPER_CLI_NAMES, which);
  if (cli) {
    const modelPath = await ensureModel({ configuredModelPath });
    return createCliTranscriber({ bin: cli, modelPath, language, run: runCommand });
  }
  const endpoint = cfg?.stt?.endpoint || null;
  if (endpoint && await probeEndpoint(endpoint)) {
    return createEndpointTranscriber({ endpoint, kind: 'stt-endpoint', transcribe });
  }
  const serverBin = await which('whisper-server');
  if (serverBin) {
    const modelPath = await ensureModel({ configuredModelPath });
    const server = await startServer({ bin: serverBin, modelPath });
    return createEndpointTranscriber({ endpoint: server.endpoint, kind: 'whisper-server', transcribe, release: server.stop });
  }
  throw new ServerError(WHISPER_MISSING_MESSAGE, { status: 503, code: 'LYRIC_ALIGN_STT_UNAVAILABLE' });
}
