/**
 * Music Video — the cold open's sound (lib/musicVideoColdOpen.js). Each
 * cold-open shot gets a mix of exactly its length: silence, the clip's own
 * audio at the director's level, and any sound layers placed in it (an effect
 * ffmpeg synthesizes, or a music-library track). The shots' mixes play back to
 * back as one WAV, which the final render lays in front of the song and the
 * animatic plays before it, so both hear the same thing.
 */

import { createHash, randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readdir, rename, rm, stat } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { findFfmpeg, hasAudioStream, runFfmpegProcess, safeUnder } from '../../lib/ffmpeg.js';
import { coldOpenPlan, coldOpenScenes, normalizePreMusic, preMusicEffect } from '../../lib/musicVideoColdOpen.js';
import { nameShots } from './productionReview.js';
import { shotSegmentDir } from './shotSegmentPaths.js';

const RATE = 48000;
const FORMAT = `aresample=${RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;
const round3 = (n) => Math.round(n * 1000) / 1000;

// atempo takes 0.5..2 per stage; a clip played at 3x or 0.25x chains two.
function atempoChain(rate) {
  const stages = [];
  let left = rate;
  while (left > 2) { stages.push(2); left /= 2; }
  while (left < 0.5) { stages.push(0.5); left /= 0.5; }
  if (Math.abs(left - 1) > 1e-6) stages.push(round3(left));
  return stages.map((r) => `atempo=${r}`).join(',');
}

/**
 * Pure: the ffmpeg args that mix the cold open's shots into one WAV at
 * `outputPath`. `shots[i]` is `{ durationSec, clip?, layers }`: `clip`
 * `{ path, sourceInSec, rate, leadSec, loop, reverse, volume }` is the take's
 * own audio, `layers[j]` is `{ source }` (a lavfi graph) or `{ path }` with
 * `{ atSec, durationSec, volume }`. Every shot is exactly its length, so the
 * mix lines up with the cut frame for frame.
 */
function buildColdOpenAudioArgs(shots, outputPath) {
  if (!Array.isArray(shots) || !shots.length) throw new Error('buildColdOpenAudioArgs: no shots');
  const inputs = [];
  const filters = [];
  let next = 0;
  const addInput = (path, { loop = false } = {}) => {
    if (loop) inputs.push('-stream_loop', '-1');
    inputs.push('-i', path);
    return next++;
  };
  shots.forEach((shot, i) => {
    const dur = round3(shot.durationSec);
    const legs = [`[base${i}]`];
    filters.push(`anullsrc=r=${RATE}:cl=stereo,atrim=0:${dur}[base${i}]`);
    const clip = shot.clip;
    if (clip) {
      const idx = addInput(clip.path, { loop: clip.loop });
      const tempo = clip.rate && clip.rate !== 1 ? `,${atempoChain(clip.rate)}` : '';
      const lead = clip.leadSec > 0 ? `,adelay=${Math.round(clip.leadSec * 1000)}:all=1` : '';
      filters.push(`[${idx}:a]${clip.reverse ? 'areverse,' : ''}atrim=start=${round3(clip.sourceInSec || 0)},asetpts=PTS-STARTPTS${tempo},${FORMAT},volume=${clip.volume}${lead}[clip${i}]`);
      legs.push(`[clip${i}]`);
    }
    (shot.layers || []).forEach((layer, j) => {
      const at = round3(layer.atSec || 0);
      if (at >= dur) return;
      const len = round3(Math.min(layer.durationSec ?? dur, dur - at));
      if (!(len > 0)) return;
      const head = layer.source ? `${layer.source},` : `[${addInput(layer.path)}:a]`;
      const delay = at > 0 ? `,adelay=${Math.round(at * 1000)}:all=1` : '';
      filters.push(`${head}atrim=0:${len},asetpts=PTS-STARTPTS,${FORMAT},volume=${layer.volume}${delay}[layer${i}_${j}]`);
      legs.push(`[layer${i}_${j}]`);
    });
    // duration=first: the silent base sets the shot's length; normalize=0 keeps every level as set.
    const mix = legs.length > 1 ? `${legs.join('')}amix=inputs=${legs.length}:duration=first:dropout_transition=0:normalize=0,` : `${legs[0]}`;
    filters.push(`${mix}${legs.length > 1 ? '' : 'anull,'}atrim=0:${dur},asetpts=PTS-STARTPTS[shot${i}]`);
  });
  filters.push(`${shots.map((_, i) => `[shot${i}]`).join('')}concat=n=${shots.length}:v=0:a=1[a]`);
  return ['-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', filters.join(';'),
    '-map', '[a]', '-c:a', 'pcm_s16le', '-ar', String(RATE), '-ac', '2', '-y', outputPath];
}

async function layerSources(project, preMusic) {
  const { getTrack } = await import('../tracks/index.js');
  const layers = [];
  for (const layer of preMusic.layers) {
    if (layer.effect) {
      const effect = preMusicEffect(layer.effect);
      layers.push({ source: effect.source, atSec: layer.atSec, durationSec: layer.durationSec ?? effect.oneShotSec ?? null, volume: layer.volume });
      continue;
    }
    const track = await getTrack(layer.trackId);
    const path = track?.audioFilename ? safeUnder(PATHS.music, track.audioFilename) : null;
    if (!path || !existsSync(path)) return { missing: true };
    layers.push({ path, atSec: layer.atSec, durationSec: layer.durationSec, volume: layer.volume });
  }
  return { layers };
}

/**
 * The cold open's audio shots, one per `entries[i]` `{ sceneId, clip, durationSec }`
 * in play order: `clip` is the render's resolved clip (null for a shot with
 * no footage to hear), `durationSec` its span on the frame grid. A sound layer
 * whose library track is gone refuses, naming the shot.
 */
export async function coldOpenAudioShots(project, entries) {
  const scenes = new Map(coldOpenScenes(project).map((scene) => [scene.sceneId, scene]));
  const shots = [];
  const missing = [];
  for (const { sceneId, clip, durationSec } of entries) {
    const scene = scenes.get(sceneId);
    const preMusic = normalizePreMusic(scene?.preMusic) || normalizePreMusic({});
    const { layers, missing: gone } = await layerSources(project, preMusic);
    if (gone) { missing.push(sceneId); continue; }
    const withClip = !!clip?.videoPath && preMusic.clipVolume > 0 && await hasAudioStream(clip.videoPath);
    shots.push({
      sceneId,
      durationSec,
      clip: withClip ? {
        path: clip.videoPath, rate: clip.rate || 1, leadSec: clip.leadSec || 0, loop: clip.loop !== false, reverse: !!clip.reverse,
        // The footage's in-point is on the output clock; the audio is read on the source's.
        sourceInSec: Math.max(0, (clip.inSec || 0) * (clip.rate || 1)),
        volume: preMusic.clipVolume,
      } : null,
      layers,
    });
  }
  if (missing.length) {
    throw new ServerError(`${nameShots(project, missing)}: a sound layer's library track is missing. Pick another sound or remove the layer`,
      { status: 404, code: 'PRE_MUSIC_SOUND_MISSING', context: { sceneIds: missing } });
  }
  return shots;
}

/** Each section of a cut cold open with the clip it plays and its length on the frame grid. */
export const cutEntries = (clips, sections) => sections.map((section) => ({
  sceneId: section.sceneId, clip: clips.find((clip) => clip.sceneId === section.sceneId) || null, durationSec: section.endSec - section.startSec,
}));

/**
 * The cold open's sound as the animatic plays it: every marked shot at its
 * set length, with its clip's audio when it has a clip. Resolves the WAV's
 * path, or null when no shot is marked before the song.
 */
export async function coldOpenPreviewAudio(project) {
  const plan = coldOpenPlan(project);
  if (!plan.length) return null;
  const { resolveColdOpenClips } = await import('./render.js');
  const layered = project.composition?.mode === 'composed';
  const resolved = await resolveColdOpenClips(project, { layered, stillForMissingClip: true });
  const entries = plan.map(({ scene, preMusic }) => ({ sceneId: scene.sceneId, durationSec: preMusic.durationSec,
    clip: resolved?.clips.find((clip) => clip.sceneId === scene.sceneId) || null }));
  return ensureColdOpenAudio(await coldOpenAudioShots(project, entries), shotSegmentDir(project.id));
}

const shotsKey = (shots) => createHash('sha256').update(JSON.stringify(shots)).digest('hex').slice(0, 32);

/**
 * Mix the cold open's sound into `dir` (cached by everything that reaches it)
 * and resolve its path. Mixes written before this one started are dropped;
 * a newer mix that an overlapping request finished first is kept.
 */
export async function ensureColdOpenAudio(shots, dir, { ffmpeg = null, signal } = {}) {
  const bin = ffmpeg || await findFfmpeg();
  if (!bin) throw new ServerError('ffmpeg not found on PATH', { status: 500, code: 'FFMPEG_MISSING' });
  const name = `cold-open-${shotsKey(shots)}.wav`;
  const path = join(dir, name);
  if (existsSync(path)) return path;
  await mkdir(dir, { recursive: true });
  const startedAt = Date.now();
  const partial = `${path}.${randomUUID()}.partial.wav`;
  try {
    const result = await runFfmpegProcess({ bin, signal, args: buildColdOpenAudioArgs(shots, partial) });
    signal?.throwIfAborted();
    if (!result.ok) throw new ServerError(`Mixing the cold open's sound failed: ${result.reason}`, { status: 500, code: 'PRE_MUSIC_MIX_FAILED' });
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true }).catch(() => {});
  }
  for (const old of await readdir(dir).catch(() => [])) {
    if (old === name || !/^cold-open-[0-9a-f]{32}\.wav$/.test(old)) continue;
    const written = await stat(join(dir, old)).then((s) => s.mtimeMs, () => Infinity);
    if (written < startedAt) await rm(join(dir, old), { force: true }).catch(() => {});
  }
  return path;
}

/**
 * Put the cold open in front of a finished cut at `path` (a footage render
 * that does not go through the segment cache): its shots on the cut's frame
 * with their own sound, then the cut. Resolves the seconds it added (0 when
 * `coldOpen` is null).
 */
export async function prependColdOpen({ project, coldOpen, path, ffmpeg, jobId, signal }) {
  if (!coldOpen?.clips?.length) return 0;
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error('Invalid cold open job id');
  const [{ buildMusicVideoFfmpegArgs }, { probeVideoGeometry }, { filterGraphViaFile }] = await Promise.all([
    import('./render.js'), import('../../lib/ffmpeg.js'), import('../../lib/ffmpegFilterGraph.js')]);
  const geometry = await probeVideoGeometry(path);
  if (!geometry) throw new ServerError('The rendered video could not be measured for its cold open', { status: 500, code: 'PRE_MUSIC_PROBE' });
  const { width, height, fps } = geometry;
  const options = { frameGrid: true, canvas: { width, height, fps }, aspect: null };
  const { sections } = buildMusicVideoFfmpegArgs(coldOpen.clips, null, '@plan', options);
  const leadSec = round3(sections.reduce((sum, section) => sum + section.endSec - section.startSec, 0));
  const shots = await coldOpenAudioShots(project, cutEntries(coldOpen.clips, sections));
  const audio = `${path}.cold-open.wav`;
  const clip = `${path}.cold-open.mp4`;
  const joined = `${path}.cold-open-joined.mp4`;
  const graphPath = `${path}.cold-open.filtergraph`;
  try {
    const mixed = await runFfmpegProcess({ bin: ffmpeg, signal, args: buildColdOpenAudioArgs(shots, audio) });
    signal?.throwIfAborted();
    if (!mixed.ok) throw new ServerError(`Mixing the cold open's sound failed: ${mixed.reason}`, { status: 500, code: 'PRE_MUSIC_MIX_FAILED' });
    const { args } = buildMusicVideoFfmpegArgs(coldOpen.clips, audio, clip, { ...options, audioDurationSec: leadSec });
    const encode = await filterGraphViaFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], graphPath);
    const cut = await runFfmpegProcess({ bin: ffmpeg, signal, args: encode.args });
    signal?.throwIfAborted();
    if (!cut.ok) throw new ServerError(`Cutting the cold open failed: ${cut.reason}`, { status: 500, code: 'PRE_MUSIC_CUT_FAILED' });
    const norm = `scale=${width}:${height},setsar=1,fps=${fps},format=yuv420p`;
    const sound = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
    const join2 = await runFfmpegProcess({
      bin: ffmpeg, signal,
      args: ['-hide_banner', '-loglevel', 'error', '-i', clip, '-i', path,
        '-filter_complex', `[0:v]${norm}[a0];[1:v]${norm}[b0];[0:a]${sound}[a1];[1:a]${sound}[b1];[a0][a1][b0][b1]concat=n=2:v=1:a=1[v][a]`,
        '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', joined],
    });
    signal?.throwIfAborted();
    if (!join2.ok) throw new ServerError(`Joining the cold open failed: ${join2.reason}`, { status: 500, code: 'PRE_MUSIC_JOIN' });
    await rename(joined, path);
    console.log(`🎞️ Music-video cold open [${jobId.slice(0, 8)}]: ${leadSec}s before the song`);
    return leadSec;
  } finally {
    for (const file of [audio, clip, joined, graphPath]) await rm(file, { force: true }).catch(() => {});
  }
}

/** A mixed cold-open WAV in the project's cache by its name, or null. */
export function coldOpenAudioFile(projectId, name) {
  if (typeof name !== 'string' || !/^cold-open-[0-9a-f]{32}\.wav$/.test(name)) return null;
  const path = join(shotSegmentDir(projectId), name);
  return existsSync(path) ? path : null;
}
