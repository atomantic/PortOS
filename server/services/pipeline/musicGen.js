/**
 * Local OSS music generation — generator-agnostic backend selector
 * (Pipeline Audio Phase 4c.2).
 *
 * The audio stage's `source: 'gen'` library entry renders text-conditioned
 * background music on-device: no network, no API key — the same "local OSS
 * first" posture as the Kokoro / Piper voice path in `audio.js`. Each backend
 * is a sibling Python sidecar behind one `generateMusic` contract:
 *
 *   - `musicgen`  — Meta's MusicGen via MLX (Apple Silicon). Bounded clips
 *     (≤30s; trained on 30s windows, degrades past that). First backend.
 *   - `audioldm2` — AudioLDM2 latent diffusion via HuggingFace `diffusers`.
 *     Long-form (well past 30s), torch on MPS/CUDA/CPU. Second backend.
 *
 * An ENGINES registry holds each backend's models, duration window, sidecar
 * script, venv resolver and install hint, so the route, UI and `generateMusic`
 * stay engine-agnostic — adding a third backend is one ENGINES entry plus its
 * Python sidecar, with the route contract unchanged.
 *
 * Runtime: each backend has an opt-in venv from
 * `INSTALL_<ENGINE>=1 bash scripts/setup-image-video.sh`. When it isn't set up,
 * `generateMusic` throws a 503 with that backend's install hint rather than a
 * bare spawn error — exactly like the FLUX.2 venv gate.
 *
 * Output: a mono WAV written into the shared music library (PATHS.music) under
 * a `music-gen-<uuid>.wav` basename, so the picker treats a generated track
 * identically to an uploaded one.
 */

import { spawn } from 'child_process';
import { existsSync, statSync } from 'fs';
import { unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { PATHS, ensureDir } from '../../lib/fileUtils.js';
import { safeChildProcessEnv } from '../../lib/processEnv.js';
import { hfTokenEnv } from '../../lib/hfToken.js';
import {
  resolveMusicgenPython, MUSICGEN_RUNTIME_DIR, MUSICGEN_VENV_DEFAULT,
  resolveAudioldm2Python, AUDIOLDM2_RUNTIME_DIR, AUDIOLDM2_VENV_DEFAULT,
  resolveAcestepPython, ACESTEP_RUNTIME_DIR, ACESTEP_VENV_DEFAULT,
} from '../../lib/pythonSetup.js';
import { ServerError } from '../../lib/errorHandler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The sidecar scripts live at the repo root — resolve module-relative so the
// paths are correct regardless of the server process's cwd.
const MUSICGEN_SCRIPT = join(__dirname, '../../../scripts/generate_musicgen.py');
const AUDIOLDM2_SCRIPT = join(__dirname, '../../../scripts/generate_audioldm2.py');
const ACESTEP_SCRIPT = join(__dirname, '../../../scripts/generate_acestep.py');
// Back-compat alias for the pre-multi-engine `buildMusicGenArgs` default.
const SIDECAR_SCRIPT = MUSICGEN_SCRIPT;

// MusicGen's practical clip-length window. It was trained on 30s windows and
// degrades past that; the floor keeps at least one decoder step. Exported as
// the module-level defaults for backward compatibility — `musicgen` is the
// default engine, so these mirror its ENGINES entry.
export const MIN_DURATION_SEC = 1;
export const MAX_DURATION_SEC = 30;
export const DEFAULT_DURATION_SEC = 12;

// MusicGen model tiers; medium is the default — a quality/speed balance that
// fits comfortably in unified memory. Kept as a small in-module constant rather
// than threaded through the image/video `media-models.json` registry, whose
// seed/merge/migration machinery doesn't apply to a one-shot audio generator.
export const MUSICGEN_MODELS = Object.freeze([
  { id: 'musicgen-small',  repo: 'facebook/musicgen-small',  name: 'MusicGen Small (~2 GB, fastest)' },
  { id: 'musicgen-medium', repo: 'facebook/musicgen-medium', name: 'MusicGen Medium (~6 GB, balanced)' },
  { id: 'musicgen-large',  repo: 'facebook/musicgen-large',  name: 'MusicGen Large (~13 GB, best quality)' },
]);
export const DEFAULT_MUSICGEN_MODEL_ID = 'musicgen-medium';

// AudioLDM2 model tiers; the base model is the default — long-form text-to-audio
// with the smallest weights. `audioldm2-large` and `-music` trade size for
// fidelity / music-specialization.
export const AUDIOLDM2_MODELS = Object.freeze([
  { id: 'audioldm2',       repo: 'cvssp/audioldm2',       name: 'AudioLDM2 Base (~3 GB, long-form)' },
  { id: 'audioldm2-large', repo: 'cvssp/audioldm2-large', name: 'AudioLDM2 Large (~7 GB, best quality)' },
  { id: 'audioldm2-music', repo: 'cvssp/audioldm2-music', name: 'AudioLDM2 Music (~3 GB, music-tuned)' },
]);
export const DEFAULT_AUDIOLDM2_MODEL_ID = 'audioldm2';

// ACE-Step weights. The 3.5B foundation model is the only public checkpoint;
// `repo` is informational (the sidecar lets ACE-Step resolve + auto-download its
// own checkpoints, unlike the from_pretrained backends above).
export const ACESTEP_MODELS = Object.freeze([
  { id: 'ace-step-v1-3.5b', repo: 'ACE-Step/ACE-Step-v1-3.5B', name: 'ACE-Step v1 3.5B (full song + vocals)' },
]);
export const DEFAULT_ACESTEP_MODEL_ID = 'ace-step-v1-3.5b';

/**
 * Backend registry. Each engine is fully described here so the route, UI and
 * `generateMusic` stay generator-agnostic. Fields:
 *   - `id`/`name`        — stable id (the contract stored on the request) + label
 *   - `models`/`defaultModelId` — selectable weights for this backend
 *   - duration window    — min/max/default seconds, clamped before spawn
 *   - `scriptPath`       — the Python sidecar
 *   - `runtimeDir`       — value for the sidecar's --runtime-dir flag
 *   - `resolvePython`    — () => venv interpreter path | null (readiness probe)
 *   - `venvDefault`/`installEnv` — install-hint pieces for the 503 message
 */
export const ENGINES = Object.freeze({
  musicgen: {
    id: 'musicgen',
    name: 'MusicGen (MLX)',
    models: MUSICGEN_MODELS,
    defaultModelId: DEFAULT_MUSICGEN_MODEL_ID,
    minDurationSec: 1,
    maxDurationSec: 30,
    defaultDurationSec: 12,
    scriptPath: MUSICGEN_SCRIPT,
    runtimeDir: MUSICGEN_RUNTIME_DIR,
    resolvePython: resolveMusicgenPython,
    venvDefault: MUSICGEN_VENV_DEFAULT,
    installEnv: 'INSTALL_MUSICGEN',
    // The sidecar passes `--model <repo>` straight to from_pretrained, so any
    // HuggingFace MusicGen checkpoint works — user-installed models are usable.
    customModels: true,
  },
  audioldm2: {
    id: 'audioldm2',
    name: 'AudioLDM2 (diffusers)',
    models: AUDIOLDM2_MODELS,
    defaultModelId: DEFAULT_AUDIOLDM2_MODEL_ID,
    minDurationSec: 1,
    maxDurationSec: 120,
    defaultDurationSec: 20,
    scriptPath: AUDIOLDM2_SCRIPT,
    runtimeDir: AUDIOLDM2_RUNTIME_DIR,
    resolvePython: resolveAudioldm2Python,
    venvDefault: AUDIOLDM2_VENV_DEFAULT,
    installEnv: 'INSTALL_AUDIOLDM2',
    // `--model <repo>` → AudioLDM2Pipeline.from_pretrained: any HF AudioLDM2
    // checkpoint works, so user-installed models are usable.
    customModels: true,
  },
  acestep: {
    id: 'acestep',
    name: 'ACE-Step (full song + vocals)',
    models: ACESTEP_MODELS,
    defaultModelId: DEFAULT_ACESTEP_MODEL_ID,
    minDurationSec: 1,
    maxDurationSec: 240,
    defaultDurationSec: 60,
    scriptPath: ACESTEP_SCRIPT,
    runtimeDir: ACESTEP_RUNTIME_DIR,
    resolvePython: resolveAcestepPython,
    venvDefault: ACESTEP_VENV_DEFAULT,
    installEnv: 'INSTALL_ACESTEP',
    // ACE-Step is lyric-aware: the route/UI may send `lyrics`, threaded into the
    // sidecar as --lyrics. The other engines ignore lyrics (the flag gates UI).
    lyrics: true,
    // ACE-Step resolves a single foundation checkpoint via its own checkpoint_dir
    // (NOT a from_pretrained repo id), so an arbitrary HF repo can't be swapped
    // in like the diffusers/MLX engines. Custom-model install/selection is
    // therefore disabled for it (customModels falsy) — the sidecar ignores
    // --model by design.
    customModels: false,
  },
});

export const DEFAULT_ENGINE_ID = 'musicgen';

// Resolve a requested engine id to its registry entry, falling back to the
// default engine for unknown/absent ids (the route validates against the known
// set, but generateMusic can be called directly).
export function getEngine(engineId) {
  return ENGINES[engineId] || ENGINES[DEFAULT_ENGINE_ID];
}

// Look up a model within a specific engine. Returns null for unknown ids so the
// caller can fall back to the engine's default.
export function getEngineModel(engineId, modelId) {
  const engine = getEngine(engineId);
  return engine.models.find((m) => m.id === modelId) || null;
}

// Back-compat: MusicGen-specific model lookup (pre-multi-engine callers/tests).
export function getMusicgenModel(modelId) {
  return MUSICGEN_MODELS.find((m) => m.id === modelId) || null;
}

// Whether a backend's opt-in venv is provisioned. The UI gates its "Generate"
// affordance on this so users see an install hint instead of a 503 after typing
// a prompt. Cheap (an existsSync probe behind the resolver's cache) — safe to
// call per request.
export function isEngineReady(engineId) {
  return getEngine(engineId).resolvePython() !== null;
}

// Back-compat: MusicGen readiness probe.
export function isMusicGenReady() {
  return resolveMusicgenPython() !== null;
}

// Clamp a requested duration into an engine's usable window. Non-finite input
// falls back to that engine's default rather than throwing — the route
// validates shape, this guards the math. `engineId` defaults to the module's
// default engine so the back-compat signature `clampDuration(seconds)` keeps
// the original MusicGen window.
export function clampDuration(durationSec, engineId = DEFAULT_ENGINE_ID) {
  const engine = getEngine(engineId);
  const n = Number(durationSec);
  if (!Number.isFinite(n)) return engine.defaultDurationSec;
  return Math.max(engine.minDurationSec, Math.min(engine.maxDurationSec, n));
}

/**
 * Build the `{ bin, args }` for a backend's sidecar. Pure — unit-tested without
 * spawning Python. All sidecars share the same base flag contract
 * (`--model/--text/--duration/--output/--runtime-dir`), so one builder serves
 * every engine; `engineId` selects the duration window + script + runtime dir.
 * Lyric-aware engines (`engine.lyrics`, e.g. ACE-Step) additionally get
 * `--lyrics`; non-lyric engines never receive the flag (their sidecars don't
 * define it), so a stray lyrics arg can't break a MusicGen/AudioLDM2 spawn.
 */
export function buildSidecarArgs({ engineId = DEFAULT_ENGINE_ID, pythonPath, scriptPath, runtimeDir, repo, prompt, lyrics, durationSec, outputPath }) {
  const engine = getEngine(engineId);
  const args = [
    scriptPath ?? engine.scriptPath,
    '--model', repo,
    '--text', prompt,
    '--duration', String(clampDuration(durationSec, engine.id)),
    '--output', outputPath,
    '--runtime-dir', runtimeDir ?? engine.runtimeDir,
  ];
  if (engine.lyrics) args.push('--lyrics', typeof lyrics === 'string' ? lyrics : '');
  return { bin: pythonPath, args };
}

/**
 * Back-compat wrapper: build the MusicGen sidecar argv. Pre-existing callers
 * and tests use this name; it forwards to the engine-agnostic builder pinned to
 * the `musicgen` engine.
 */
export function buildMusicGenArgs({ pythonPath, scriptPath = SIDECAR_SCRIPT, runtimeDir = MUSICGEN_RUNTIME_DIR, repo, prompt, durationSec, outputPath }) {
  return buildSidecarArgs({ engineId: 'musicgen', pythonPath, scriptPath, runtimeDir, repo, prompt, durationSec, outputPath });
}

// Pull the saved path + actual duration out of the sidecar's `RESULT:<json>`
// line. Returns null when no parseable result line is present so the caller
// can fail with a useful message instead of a malformed success.
function parseResultLine(stdout) {
  const line = (stdout || '').split(/\r?\n/).reverse().find((l) => l.startsWith('RESULT:'));
  if (!line) return null;
  try {
    return JSON.parse(line.slice('RESULT:'.length));
  } catch {
    return null;
  }
}

/**
 * Generate a background-music track and land it in the shared music library.
 * Returns `{ filename, durationSec, modelId, model, engine }`. Throws a
 * ServerError (503) when the selected backend's venv isn't provisioned, or
 * (500) when the sidecar exits non-zero / produces no result.
 *
 * `engine` selects the backend (`musicgen` | `audioldm2` | `acestep`); unknown
 * ids fall back to the default. `modelId` is resolved within that engine's
 * registry. `lyrics` is forwarded only to lyric-aware engines (ACE-Step); other
 * engines ignore it. `signal` (optional AbortSignal) SIGTERMs the child — wired
 * through so a cancel button can abort a long render. `onActivity` (optional)
 * fires once per `STAGE:` line the sidecar emits — the media-job queue's
 * generic idle watchdog resets its timer off it via the audio job-kind
 * adapter (server/services/audioGen/local.js), the same way the image/video
 * sidecars' stderr lines do, so a slow first-run model download doesn't trip a
 * flat timeout. Callers outside the queue (the Pipeline Audio routes) omit it
 * and behave exactly as before.
 */
export async function generateMusic({ prompt, lyrics, engine: engineId = DEFAULT_ENGINE_ID, durationSec, modelId, repo, signal, onActivity } = {}) {
  const text = (prompt || '').trim();
  if (!text) {
    throw new ServerError('prompt is required', { status: 400, code: 'PIPELINE_MUSIC_EMPTY_PROMPT' });
  }
  const engine = getEngine(engineId);
  // `repo` (when given) is an explicit HF checkpoint — used for USER-INSTALLED
  // models that aren't in the shipped ENGINES registry (the caller resolved it
  // from the audio-models registry). It overrides the registry lookup so an
  // installed model actually renders instead of silently falling back to the
  // engine default. `modelId` is still reported for metadata.
  const shippedModel = getEngineModel(engine.id, modelId) || getEngineModel(engine.id, engine.defaultModelId);
  const model = repo
    ? { id: modelId || repo, repo, name: modelId || repo }
    : shippedModel;
  const resolvedDuration = durationSec ?? engine.defaultDurationSec;
  const pythonPath = engine.resolvePython();
  if (!pythonPath) {
    throw new ServerError(
      `${engine.name} runtime not found. Run \`${engine.installEnv}=1 bash scripts/setup-image-video.sh\` to bootstrap it (expected venv at ${engine.venvDefault}).`,
      { status: 503, code: 'PIPELINE_MUSIC_RUNTIME_MISSING' },
    );
  }

  await ensureDir(PATHS.music);
  const filename = `music-gen-${randomUUID()}.wav`;
  const outputPath = join(PATHS.music, filename);
  const { bin, args } = buildSidecarArgs({ engineId: engine.id, pythonPath, repo: model.repo, prompt: text, lyrics, durationSec: resolvedDuration, outputPath });

  console.log(`🎼 Generating music [${engine.id}/${model.id}] ${clampDuration(resolvedDuration, engine.id)}s: "${text.slice(0, 60)}"`);
  // The default backends use ungated HF weights (facebook/* and cvssp/*), so a
  // token isn't required — but pass it through when the user has one set so the
  // first download doesn't hit anonymous HF rate limits.
  const env = safeChildProcessEnv(await hfTokenEnv());
  const result = await runSidecarProcess({ bin, args, env, signal, engineId: engine.id, onActivity });
  // A clean exit isn't enough — the sidecar could exit 0 yet write nothing (or
  // a truncated file) if the runtime changes shape. Require both a parsed
  // RESULT line AND a non-empty file on disk before we persist the library
  // pointer; otherwise unlink the partial and fail, so the audio stage never
  // attaches a dangling/empty track.
  const parsed = result.ok ? parseResultLine(result.stdout) : null;
  const wroteFile = existsSync(outputPath) && statSync(outputPath).size > 0;
  if (!result.ok || !parsed || !wroteFile) {
    await unlink(outputPath).catch(() => {});
    const reason = !result.ok ? result.reason : (!wroteFile ? 'sidecar wrote no audio' : 'sidecar returned no result');
    throw new ServerError(`Music generation failed: ${reason}`, {
      status: 500, code: 'PIPELINE_MUSIC_GEN_FAILED',
    });
  }
  return {
    filename,
    durationSec: Number.isFinite(parsed.durationSec) ? parsed.durationSec : clampDuration(resolvedDuration, engine.id),
    modelId: model.id,
    model: model.name,
    engine: engine.id,
  };
}

// Spawn a backend sidecar and resolve `{ ok, stdout, reason? }`. STAGE: lines
// on stderr are echoed to pm2 logs so a stuck first-run model download is
// visible (mirrors the image/video sidecars). Captures stdout for the RESULT
// line and a bounded stderr tail for the failure reason. Not a route handler —
// the spawn-error / close branches must not throw (they run outside the Express
// lifecycle), so they resolve a structured result instead.
function runSidecarProcess({ bin, args, env, signal, engineId = DEFAULT_ENGINE_ID, onActivity }) {
  return new Promise((resolve) => {
    // A cancel arriving between the caller awaiting up to here and this Promise
    // executor running (e.g. the audio job-kind adapter's controller is aborted
    // in the same tick it was created) would otherwise be silently missed —
    // the 'abort' listener below is only attached AFTER spawn, so an
    // already-aborted signal would let the sidecar spawn, run to completion,
    // and report success despite the cancel. Check synchronously before
    // spawning anything.
    if (signal?.aborted) {
      resolve({ ok: false, reason: 'cancelled (aborted before spawn)', stdout: '' });
      return;
    }
    const proc = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderrTail = '';
    const STDERR_TAIL = 4000;
    let settled = false;
    const finish = (val) => { if (!settled) { settled = true; cleanup(); resolve(val); } };

    let onAbort = null;
    const cleanup = () => { if (signal && onAbort) signal.removeEventListener('abort', onAbort); };
    if (signal) {
      onAbort = () => proc.kill('SIGTERM');
      signal.addEventListener('abort', onAbort, { once: true });
    }

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      stderrTail = (stderrTail + s).slice(-STDERR_TAIL);
      for (const line of s.split(/\r?\n/)) {
        const t = line.trim();
        if (t.startsWith('STAGE:')) {
          console.log(`🎼 ${engineId} ${t.slice('STAGE:'.length)}`);
          onActivity?.();
        }
      }
    });
    proc.on('error', (err) => finish({ ok: false, reason: `spawn failed: ${err.message}`, stdout }));
    proc.on('close', (code, sig) => {
      if (sig === 'SIGTERM' || sig === 'SIGKILL') { finish({ ok: false, reason: `cancelled (${sig})`, stdout }); return; }
      if (code !== 0) {
        const tail = stderrTail.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
        finish({ ok: false, reason: tail || `exit ${code}`, stdout });
        return;
      }
      finish({ ok: true, stdout });
    });
  });
}
