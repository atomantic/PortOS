/**
 * Chiptune score service (#2911) — LLM generation, offline render into the
 * shared music library, and publish into a managed app's repo.
 *
 *   generateChiptuneScore — prompt + any configured AI provider/model →
 *     validated score JSON persisted on the track (`chiptuneScore` +
 *     `chiptunePrompt`). User-triggered only (no cold-bootstrap LLM calls).
 *   renderChiptuneTrack — score → WAV (lib/chiptuneRender) → OGG via the
 *     system ffmpeg when available (WAV fallback otherwise), landed in the
 *     shared music library and appended to the track's render history.
 *   publishChiptuneTrack — render the CURRENT score straight into a managed
 *     app's repoPath (default `game/assets/music/`) as `<slug>.ogg` +
 *     `<slug>.score.json`, path-safety anchored to the app's repo. The game
 *     repo owns its own git — we only write files.
 */

import { unlink, stat } from 'fs/promises';
import { join, resolve, isAbsolute } from 'path';
import { randomUUID } from 'crypto';
import { ServerError } from '../lib/errorHandler.js';
import { PATHS, atomicWrite, isPathInsideDir } from '../lib/fileUtils.js';
import { findFfmpeg, runFfmpegProcess } from '../lib/ffmpeg.js';
import { chiptuneScoreSchema, CHIPTUNE_LIMITS, CHIPTUNE_NOISE_PRESETS, scoreDurationSec } from '../lib/chiptuneScore.js';
import { renderScoreToWav } from '../lib/chiptuneRender.js';
import { resolveProviderAndModel, assertProvider, runPromptThroughProvider } from '../lib/promptRunner.js';
import * as tracks from './tracks/index.js';
import { getAppById, PORTOS_APP_ID } from './apps.js';

export const DEFAULT_PUBLISH_SUBDIR = 'game/assets/music';

const requireTrack = async (trackId) => {
  const track = await tracks.getTrack(trackId);
  if (!track) throw new ServerError('Track not found', { status: 404, code: 'NOT_FOUND' });
  return track;
};

const requireScore = (track) => {
  if (!track.chiptuneScore) {
    throw new ServerError('This track has no chiptune score yet — generate one first', {
      status: 400, code: 'CHIPTUNE_NO_SCORE',
    });
  }
  return track.chiptuneScore;
};

/** The generation contract sent to the LLM. Exported for tests. */
export function buildChiptunePrompt({ prompt, currentScore }) {
  const iterate = currentScore
    ? `\nCURRENT SCORE (revise this per the request above — keep what works, change what's asked):\n${JSON.stringify(currentScore)}\n`
    : '';
  return `You are a chiptune composer writing a seamlessly LOOPING 8-bit background-music score for a game.

MUSIC REQUEST: ${prompt}
${iterate}
Return ONLY a JSON object (no prose, no code fence) in exactly this shape:
{
  "version": 1,
  "title": "<short title>",
  "bpm": <number ${CHIPTUNE_LIMITS.BPM_MIN}-${CHIPTUNE_LIMITS.BPM_MAX}>,
  "stepsPerBeat": <int 1-${CHIPTUNE_LIMITS.STEPS_PER_BEAT_MAX}, 4 = sixteenth notes>,
  "beatsPerBar": <int 1-${CHIPTUNE_LIMITS.BEATS_PER_BAR_MAX}, usually 4>,
  "channels": [
    {"id": "pulse1", "wave": "square", "duty": 0.5, "gain": 0.5},
    {"id": "pulse2", "wave": "square", "duty": 0.25, "gain": 0.4},
    {"id": "triangle", "wave": "triangle", "gain": 0.55},
    {"id": "noise", "wave": "noise", "gain": 0.35}
  ],
  "patterns": {
    "A": {"bars": <int 1-${CHIPTUNE_LIMITS.BARS_PER_PATTERN_MAX}>, "notes": {
      "pulse1": [{"step": 0, "pitch": "C5", "len": 2, "vel": 0.8}, ...],
      "noise":  [{"step": 0, "pitch": "kick", "len": 1}, ...]
    }}
  },
  "order": ["A", "A", "B", "A"]
}

Rules:
- pulse1 carries melody, pulse2 harmony/counter-melody, triangle the bassline, noise the drums.
- Tonal pitches are scientific notation ("C5", "F#3", "Bb2"). Noise pitches are ONLY: ${CHIPTUNE_NOISE_PRESETS.join(', ')}.
- "step" is the note's onset within its pattern (0-indexed, stepsPerBeat × beatsPerBar × bars steps per pattern); "len" is its length in steps. Notes must fit inside their pattern.
- 1-${CHIPTUNE_LIMITS.PATTERNS_MAX} patterns, order length 1-${CHIPTUNE_LIMITS.ORDER_MAX}, total loop under ${CHIPTUNE_LIMITS.MAX_LOOP_SEC}s. Aim for a 15-40 second loop that ends back where it starts musically (the playback loops the whole order seamlessly).
- Write real music: a memorable melody, movement in the bass, drums that groove. Vary velocity for feel.`;
}

/**
 * Generate (or iterate on) a track's chiptune score with the chosen provider.
 * When the track already has a score and `fresh` is not set, the current score
 * is included so the LLM revises rather than starting over.
 */
export async function generateChiptuneScore({ trackId, prompt, providerId, model, fresh = false }) {
  const track = await requireTrack(trackId);
  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  assertProvider(provider, {
    message: 'No AI provider available for chiptune generation',
    code: 'CHIPTUNE_NO_PROVIDER',
  });

  const currentScore = fresh ? null : track.chiptuneScore;
  const run = await runPromptThroughProvider({
    provider,
    prompt: buildChiptunePrompt({ prompt, currentScore }),
    source: 'chiptune-score',
    model: selectedModel ?? undefined,
    responseSchema: chiptuneScoreSchema,
  });

  // The runner validated/coerced the response against the schema; a failure
  // here means the runner contract broke — surface it rather than persisting.
  const parsed = chiptuneScoreSchema.safeParse(JSON.parse(run.text));
  if (!parsed.success) {
    throw new ServerError('Chiptune response failed schema validation after runner coercion', {
      status: 502, code: 'CHIPTUNE_BAD_RESPONSE',
    });
  }

  const updated = await tracks.updateTrack(trackId, { chiptuneScore: parsed.data, chiptunePrompt: prompt });
  return { track: updated, providerId: run.provider?.id || provider.id, model: run.model ?? selectedModel ?? null };
}

// Render the score to an audio file in `dir` as `<basename>.ogg` (via ffmpeg)
// or `<basename>.wav` when ffmpeg isn't installed. Returns the filename used.
async function renderScoreToFile(score, dir, basename) {
  const wavPath = join(dir, `${basename}.wav`);
  await atomicWrite(wavPath, renderScoreToWav(score)); // ensureDir + temp-rename
  const bin = await findFfmpeg();
  if (!bin) return `${basename}.wav`;
  const oggPath = join(dir, `${basename}.ogg`);
  const result = await runFfmpegProcess({ bin, args: ['-y', '-i', wavPath, '-c:a', 'libvorbis', '-q:a', '5', oggPath] });
  if (!result.ok) {
    console.error(`❌ Chiptune OGG encode failed (keeping WAV): ${result.reason}`);
    return `${basename}.wav`;
  }
  await unlink(wavPath).catch(() => {});
  return `${basename}.ogg`;
}

/**
 * Render the track's current score into the shared music library and append
 * it to the render history (same contract as the diffusion generate route).
 */
export async function renderChiptuneTrack({ trackId }) {
  const track = await requireTrack(trackId);
  const score = requireScore(track);
  const filename = await renderScoreToFile(score, PATHS.music, `music-${randomUUID()}`);
  const durationSec = Math.max(1, Math.round(scoreDurationSec(score)));

  // Re-read so the append lands on the freshest history (musicGen route pattern).
  const current = (await tracks.getTrack(trackId)) ?? track;
  const { renders } = tracks.buildRenderAppend(current, {
    audioFilename: filename,
    prompt: track.chiptunePrompt,
    engine: 'chiptune',
    durationSec,
  });
  const updated = await tracks.updateTrack(trackId, {
    audioFilename: filename,
    engine: 'chiptune',
    modelId: '',
    durationSec,
    renders,
  });
  return { track: updated, filename, durationSec };
}

const SLUG_RE = /[^a-z0-9-]+/g;
const slugify = (s) => String(s || '').toLowerCase().trim().replace(SLUG_RE, '-').replace(/^-+|-+$/g, '').slice(0, 64);

// A publish subdir must stay inside the app repo: relative, no traversal, no
// backslashes (Windows-style separators would dodge the segment check).
function assertSafeSubdir(subdir) {
  if (isAbsolute(subdir) || subdir.includes('\\') || subdir.split('/').some((seg) => seg === '..')) {
    throw new ServerError('Publish subdir must be a relative path inside the app repo', {
      status: 400, code: 'CHIPTUNE_BAD_SUBDIR',
    });
  }
}

/**
 * Render the track's current score directly into a managed app's repo:
 * `<repoPath>/<subdir>/<slug>.ogg` + `<slug>.score.json` (the editable source
 * travels with the audio). Path-safety anchored to the app's repoPath.
 */
export async function publishChiptuneTrack({ trackId, appId, subdir, slug }) {
  const track = await requireTrack(trackId);
  const score = requireScore(track);

  const app = await getAppById(appId);
  if (!app || !app.repoPath) {
    throw new ServerError('Managed app not found (or it has no repo path)', { status: 404, code: 'CHIPTUNE_APP_NOT_FOUND' });
  }
  // Enforce the publishable-target policy server-side (the panel's app filter
  // is just a mirror of this rule): never write generated assets into PortOS's
  // own working tree, and archived apps aren't valid destinations.
  if (app.id === PORTOS_APP_ID || app.archived) {
    throw new ServerError('That app is not a publishable target', { status: 400, code: 'CHIPTUNE_APP_NOT_PUBLISHABLE' });
  }
  const repoRoot = resolve(app.repoPath);
  const repoStat = await stat(repoRoot).catch(() => null);
  if (!repoStat?.isDirectory()) {
    throw new ServerError(`App repo path does not exist: ${app.repoPath}`, { status: 400, code: 'CHIPTUNE_APP_REPO_MISSING' });
  }

  // Validate the RAW subdir before any normalization — stripping a leading
  // slash first would launder an absolute path into a relative-looking one.
  const rawSubdir = subdir || DEFAULT_PUBLISH_SUBDIR;
  assertSafeSubdir(rawSubdir);
  const cleanSubdir = rawSubdir.replace(/\/+$/g, '');
  const targetDir = resolve(repoRoot, cleanSubdir);
  if (targetDir !== repoRoot && !isPathInsideDir(repoRoot, targetDir)) {
    throw new ServerError('Publish target escapes the app repo', { status: 400, code: 'CHIPTUNE_BAD_SUBDIR' });
  }

  const name = slugify(slug) || slugify(track.title) || 'track';
  const audioFilename = await renderScoreToFile(score, targetDir, name);
  const scoreFilename = `${name}.score.json`;
  await atomicWrite(join(targetDir, scoreFilename), `${JSON.stringify(score, null, 2)}\n`);

  const rel = (f) => (cleanSubdir ? `${cleanSubdir}/${f}` : f);
  const isOgg = audioFilename.endsWith('.ogg');
  console.log(`🎮 Published chiptune "${name}" to app ${app.name} (${rel(audioFilename)})`);
  return {
    appId: app.id,
    appName: app.name,
    files: [rel(audioFilename), rel(scoreFilename)],
    format: isOgg ? 'ogg' : 'wav',
    note: isOgg
      ? 'Godot auto-imports the OGG; enable "Loop" in its import settings for seamless background playback.'
      : 'ffmpeg was not found, so the loop was published as WAV. Install ffmpeg for OGG output.',
  };
}
