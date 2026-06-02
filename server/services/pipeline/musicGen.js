/**
 * Local OSS music generation — MusicGen via MLX (Pipeline Audio Phase 4c.2).
 *
 * The first generator behind the audio stage's `source: 'gen'` library entry.
 * Meta's MusicGen (MLX port) renders bounded text-conditioned clips on-device:
 * no network, no API key — the same "local OSS first" posture as the Kokoro /
 * Piper voice path in `audio.js`. A future 3rd-party engine (Suno, etc.) would
 * plug in here as a sibling generator behind the same `generateMusic` contract;
 * we ship local-only for now per the product decision.
 *
 * Runtime: the MLX MusicGen code lives in ml-explore/mlx-examples (not a pip
 * package), so generation needs the opt-in venv + clone from
 * `INSTALL_MUSICGEN=1 bash scripts/setup-image-video.sh`. When that isn't set
 * up, `generateMusic` throws a 503 with the install hint rather than a bare
 * spawn error — exactly like the FLUX.2 venv gate.
 *
 * Output: a 32 kHz mono WAV written into the shared music library (PATHS.music)
 * under a `music-gen-<uuid>.wav` basename, so the picker treats a generated
 * track identically to an uploaded one.
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
import { resolveMusicgenPython, MUSICGEN_RUNTIME_DIR, MUSICGEN_VENV_DEFAULT } from '../../lib/pythonSetup.js';
import { ServerError } from '../../lib/errorHandler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/generate_musicgen.py lives at the repo root — resolve module-relative
// so the path is correct regardless of the server process's cwd.
const SIDECAR_SCRIPT = join(__dirname, '../../../scripts/generate_musicgen.py');

// Practical clip-length window. MusicGen was trained on 30s windows and
// degrades past that; the floor keeps at least one decoder step.
export const MIN_DURATION_SEC = 1;
export const MAX_DURATION_SEC = 30;
export const DEFAULT_DURATION_SEC = 12;

// Registry of selectable generators. "Pick generator first" (the PLAN's
// gating decision) resolves to MusicGen across three size tiers; medium is the
// default — a quality/speed balance that fits comfortably in unified memory.
// Kept as a small in-module constant rather than threaded through the
// image/video `media-models.json` registry, whose seed/merge/migration
// machinery doesn't apply to a one-shot audio generator.
export const MUSICGEN_MODELS = Object.freeze([
  { id: 'musicgen-small',  repo: 'facebook/musicgen-small',  name: 'MusicGen Small (~2 GB, fastest)' },
  { id: 'musicgen-medium', repo: 'facebook/musicgen-medium', name: 'MusicGen Medium (~6 GB, balanced)' },
  { id: 'musicgen-large',  repo: 'facebook/musicgen-large',  name: 'MusicGen Large (~13 GB, best quality)' },
]);
export const DEFAULT_MUSICGEN_MODEL_ID = 'musicgen-medium';

export function getMusicgenModel(modelId) {
  return MUSICGEN_MODELS.find((m) => m.id === modelId) || null;
}

// Whether the opt-in MusicGen venv is provisioned. The UI gates its "Generate"
// affordance on this so users see an install hint instead of a 503 after
// typing a prompt. Cheap (an existsSync probe behind resolveMusicgenPython's
// cache) — safe to call per request.
export function isMusicGenReady() {
  return resolveMusicgenPython() !== null;
}

// Clamp a requested duration into the model's usable window. Non-finite input
// falls back to the default rather than throwing — the route validates shape,
// this guards the math.
export function clampDuration(durationSec) {
  const n = Number(durationSec);
  if (!Number.isFinite(n)) return DEFAULT_DURATION_SEC;
  return Math.max(MIN_DURATION_SEC, Math.min(MAX_DURATION_SEC, n));
}

/**
 * Build the `{ bin, args }` for the MusicGen sidecar. Pure — unit-tested
 * without spawning Python. `runtimeDir` is the mlx-examples musicgen/ package
 * dir the sidecar adds to sys.path.
 */
export function buildMusicGenArgs({ pythonPath, scriptPath = SIDECAR_SCRIPT, runtimeDir = MUSICGEN_RUNTIME_DIR, repo, prompt, durationSec, outputPath }) {
  return {
    bin: pythonPath,
    args: [
      scriptPath,
      '--model', repo,
      '--text', prompt,
      '--duration', String(clampDuration(durationSec)),
      '--output', outputPath,
      '--runtime-dir', runtimeDir,
    ],
  };
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
 * Returns `{ filename, durationSec, modelId, model }`. Throws a ServerError
 * (503) when the MusicGen venv isn't provisioned, or (500) when the sidecar
 * exits non-zero / produces no result.
 *
 * `signal` (optional AbortSignal) SIGTERMs the child — wired through so a
 * future cancel button can abort a long render.
 */
export async function generateMusic({ prompt, durationSec = DEFAULT_DURATION_SEC, modelId = DEFAULT_MUSICGEN_MODEL_ID, signal } = {}) {
  const text = (prompt || '').trim();
  if (!text) {
    throw new ServerError('prompt is required', { status: 400, code: 'PIPELINE_MUSIC_EMPTY_PROMPT' });
  }
  const model = getMusicgenModel(modelId) || getMusicgenModel(DEFAULT_MUSICGEN_MODEL_ID);
  const pythonPath = resolveMusicgenPython();
  if (!pythonPath) {
    throw new ServerError(
      `MusicGen runtime not found. Run \`INSTALL_MUSICGEN=1 bash scripts/setup-image-video.sh\` to bootstrap it (expected venv at ${MUSICGEN_VENV_DEFAULT}).`,
      { status: 503, code: 'PIPELINE_MUSIC_RUNTIME_MISSING' },
    );
  }

  await ensureDir(PATHS.music);
  const filename = `music-gen-${randomUUID()}.wav`;
  const outputPath = join(PATHS.music, filename);
  const { bin, args } = buildMusicGenArgs({ pythonPath, repo: model.repo, prompt: text, durationSec, outputPath });

  console.log(`🎼 Generating music [${model.id}] ${clampDuration(durationSec)}s: "${text.slice(0, 60)}"`);
  // MusicGen's facebook/* weights are ungated, so a token isn't required — but
  // pass it through when the user has one set so the first download doesn't hit
  // anonymous HF rate limits.
  const env = safeChildProcessEnv(await hfTokenEnv());
  const result = await runMusicGenProcess({ bin, args, env, signal });
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
    durationSec: Number.isFinite(parsed.durationSec) ? parsed.durationSec : clampDuration(durationSec),
    modelId: model.id,
    model: model.name,
  };
}

// Spawn the sidecar and resolve `{ ok, stdout, reason? }`. STAGE: lines on
// stderr are echoed to pm2 logs so a stuck first-run model download is visible
// (mirrors the image/video sidecars). Captures stdout for the RESULT line and
// a bounded stderr tail for the failure reason. Not a route handler — the
// spawn-error / close branches must not throw (they run outside the Express
// lifecycle), so they resolve a structured result instead.
function runMusicGenProcess({ bin, args, env, signal }) {
  return new Promise((resolve) => {
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
        if (t.startsWith('STAGE:')) console.log(`🎼 musicgen ${t.slice('STAGE:'.length)}`);
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
