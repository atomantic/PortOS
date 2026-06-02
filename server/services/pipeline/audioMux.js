/**
 * Pipeline audio mux — second-pass overlay of pipeline-stage audio onto the
 * already-stitched episode video.
 *
 * Phase 4d v1 (`muxMusicBed`) covers **background-music bedding**: stripping
 * the timeline's silent track and laying the user-picked music file underneath
 * the video at a configurable gain, looped to fill + cut to the video length.
 *
 * Phase 4d.2 (`muxVoLines`) adds **voice-over muxing**: each rendered VO line
 * is delayed to its per-line offset and mixed onto the episode, and — when a
 * music bed is present — the music is **ducked** under the dialogue via
 * sidechain compression so speech stays intelligible. `muxVoLines` supersedes
 * `muxMusicBed` whenever the issue has placed VO lines; music-only issues still
 * take the simpler `muxMusicBed` path.
 *
 * Clip-audio preservation: `muxVoLines` also keeps the stitched video's *own*
 * soundtrack (LTX-2 audio-to-video can carry one) — when the input video has an
 * audio stream it's mixed in as another bed and ducked under VO via the same
 * sidechain key as the music. Probed with `hasAudioStream` first, because
 * referencing `[0:a]` against a silent AI-gen clip would abort the whole graph.
 * (`muxMusicBed` still replaces the track — it's the no-VO music-only path.)
 *
 * Failure handling: this is a value-add overlay, not a correctness gate. If
 * the mux pass throws (ffmpeg missing, malformed audio, etc.), callers
 * should log and leave the silent video in place — graceful degradation
 * beats blocking the whole stitch on an optional cosmetic step.
 *
 * ffmpeg floor: the VO graph uses `amix ... normalize=0` + `sidechaincompress`
 * (ffmpeg 4.4+, 2021). On an older ffmpeg `muxVoLines` returns ok:false and the
 * CD stitch falls back to `muxMusicBed`, which uses only `aresample`/`aformat`
 * and works on every ffmpeg — so the fallback is never broken on the same host.
 */

import { join } from 'path';
import { rename, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { PATHS } from '../../lib/fileUtils.js';
import { findFfmpeg, runFfmpegProcess, hasAudioStream } from '../../lib/ffmpeg.js';
import { statMusicTrack } from './musicLibrary.js';

// 0.5 ≈ -6 dB — quiet enough to sit under dialogue once VO mixing lands
// (4d.2), but not so quiet the user wonders if it's there.
const DEFAULT_MUSIC_GAIN = 0.5;

// Sidechain-ducking defaults — the music bed (sidechain input) is compressed
// whenever the VO track (sidechain key) exceeds the threshold. ratio=8 +
// a low threshold pulls the bed well down under speech; release=300ms lets the
// music swell back smoothly in the gaps between lines.
const DEFAULT_DUCK = Object.freeze({ threshold: 0.05, ratio: 8, attack: 20, release: 300 });

// Shared aformat target so every chain mixes at one sample rate / layout —
// sidechaincompress + amix both require their inputs to agree.
const AFMT = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';

/**
 * Resolve a library music filename to its absolute path on disk, or null
 * when the file is missing / the filename fails validation. Graceful
 * degradation: callers should fall through to the silent video.
 */
export async function resolveMusicTrackPath(trackFilename) {
  const entry = await statMusicTrack(trackFilename).catch(() => null);
  return entry ? join(PATHS.music, entry.filename) : null;
}

/**
 * Pure: map an issue's raw `stages.audio.lines` to the VO lines that are
 * actually muxable — *rendered* (have an `audioFilename`) AND *placed* (have a
 * finite, >= 0 `offsetSec`). Returns `[{ path, offsetSec }]` with each
 * filename resolved under PATHS.audio. The single source of truth for "what
 * counts as a placed VO line", shared by the CD stitch and any future batch
 * export so the predicate can't drift across call sites.
 */
// A line is "placed" only with a real numeric offset >= 0. `typeof === 'number'`
// (not Number(x)) so a null offset — the sanitizer's "not placed yet" sentinel —
// is excluded rather than coerced to 0 and stacked at the episode start
// (Number(null) === 0). Single source of the scalar test so the two call sites
// (selectPlacedVoLines, muxVoLines) can't drift on the placement rule.
const isPlacedOffset = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;

export function selectPlacedVoLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines
    .filter((l) => l?.audioFilename && isPlacedOffset(l.offsetSec))
    .map((l) => ({ path: join(PATHS.audio, l.audioFilename), offsetSec: l.offsetSec }));
}

/**
 * Mix a music bed onto `inputVideoPath`, replacing the file in place.
 * Returns `{ ok: true }` on success, `{ ok: false, reason }` on failure.
 * `musicGain` is a linear amplitude (1.0 = full volume); default ~-6 dB.
 */
export async function muxMusicBed(inputVideoPath, { musicPath, musicGain = DEFAULT_MUSIC_GAIN, signal } = {}) {
  if (!inputVideoPath || !existsSync(inputVideoPath)) {
    return { ok: false, reason: 'input video missing' };
  }
  if (!musicPath || !existsSync(musicPath)) {
    return { ok: false, reason: 'music track missing' };
  }
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg not on PATH' };

  // UUID suffix keeps parallel mux passes against the same file from
  // racing on the temp output — single-instance today, but the cost of
  // the UUID is one stack alloc.
  const tmpOut = `${inputVideoPath}.muxing.${randomUUID()}.mp4`;
  const args = [
    '-i', inputVideoPath,
    '-stream_loop', '-1',
    '-i', musicPath,
    '-filter_complex', `[1:a]volume=${Number(musicGain).toFixed(3)},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[bed]`,
    '-map', '0:v',
    '-map', '[bed]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    '-y',
    tmpOut,
  ];

  const result = await runFfmpegProcess({ bin: ffmpeg, args, signal });
  if (!result.ok) {
    await unlink(tmpOut).catch(() => {});
    return result;
  }
  // Rename only after ffmpeg confirms success — a crashed mux pass leaves
  // the silent original intact rather than a half-written video.
  await rename(tmpOut, inputVideoPath);
  return { ok: true };
}

/**
 * Build the ffmpeg argv for a VO-line mux. Pure — unit-tested without spawning.
 *
 * Input order is fixed: video is input 0, each VO line is inputs 1..N (in the
 * order given), and the optional looped music bed is input N+1. `voLines` MUST
 * already be filtered to entries with an on-disk `path` and a finite, >= 0
 * `offsetSec` (muxVoLines does this) — this builder trusts its input.
 *
 * Filter graph:
 *   - each VO line: delayed to its offset, resampled to the shared format
 *   - VO lines mixed into one track (`amix normalize=0` so speech stays at full
 *     level rather than being attenuated by 1/N)
 *   - beds to duck under VO: the (gained) music bed when `musicPath` is set, and
 *     the stitched video's own soundtrack (`[0:a]`) when `clipAudio` is set
 *   - with one or more beds: the padded VO track is split into a "mixed back"
 *     copy plus one sidechain key per bed (sidechaincompress consumes its key,
 *     so each bed needs its own copy). Each bed is `sidechaincompress`-ed
 *     against a VO key, then all ducked beds are mixed back over the VO
 *   - the final audio is `apad`-ed to infinity and paired with `-shortest` so
 *     the output always matches the VIDEO length (never truncates the episode
 *     to the last VO line, never trails silence past the video)
 */
export function buildVoMuxArgs({ inputVideoPath, voLines, musicPath, musicGain = DEFAULT_MUSIC_GAIN, duck = DEFAULT_DUCK, clipAudio = false, outPath }) {
  const args = ['-i', inputVideoPath];
  for (const line of voLines) args.push('-i', line.path);
  if (musicPath) args.push('-stream_loop', '-1', '-i', musicPath);

  const chains = [];
  voLines.forEach((line, i) => {
    const ms = Math.round(Number(line.offsetSec) * 1000);
    // adelay `:all=1` delays every channel by `ms` regardless of layout, so a
    // mono VO WAV doesn't need an explicit per-channel delay list.
    chains.push(`[${i + 1}:a]adelay=${ms}:all=1,${AFMT}[vo${i}]`);
  });

  let voMixLabel;
  if (voLines.length === 1) {
    voMixLabel = '[vo0]';
  } else {
    const ins = voLines.map((_, i) => `[vo${i}]`).join('');
    chains.push(`${ins}amix=inputs=${voLines.length}:normalize=0[vomix]`);
    voMixLabel = '[vomix]';
  }

  // Beds ducked under VO. The music bed is the looped final input; the clip
  // bed is the stitched video's own audio (`[0:a]`, gated on hasAudioStream
  // upstream so we never reference a missing stream). Both get resampled to
  // the shared format so amix/sidechaincompress inputs agree.
  const beds = [];
  if (musicPath) {
    const musicIdx = voLines.length + 1;
    const gain = Number(musicGain).toFixed(3);
    chains.push(`[${musicIdx}:a]volume=${gain},${AFMT}[bed]`);
    beds.push('[bed]');
  }
  if (clipAudio) {
    chains.push(`[0:a]${AFMT}[clip]`);
    beds.push('[clip]');
  }

  if (beds.length) {
    // Pad the VO to infinity (silence after the last line), then split it into
    // one "mixed back" copy plus a sidechain key per bed. sidechaincompress
    // ends with its shortest input, so a finite VO key would cut a ducked bed
    // off at the last line; an infinite (silence-padded) key keeps every bed
    // running the full video length — ducked under dialogue, full-level in the
    // gaps. Padding the mixed-back copy too is harmless (it just adds silence).
    const keys = beds.map((_, i) => `[vsck${i}]`);
    chains.push(`${voMixLabel}apad,asplit=${beds.length + 1}[vomain]${keys.join('')}`);
    const ducked = beds.map((bed, i) => {
      chains.push(`${bed}${keys[i]}sidechaincompress=threshold=${duck.threshold}:ratio=${duck.ratio}:attack=${duck.attack}:release=${duck.release}[ducked${i}]`);
      return `[ducked${i}]`;
    });
    // amix=longest keeps the (infinite) beds past the VO; -shortest then pins
    // the whole output to the video length.
    chains.push(`${ducked.join('')}[vomain]amix=inputs=${beds.length + 1}:normalize=0[aout]`);
  } else {
    chains.push(`${voMixLabel}apad[aout]`);
  }

  args.push(
    '-filter_complex', chains.join(';'),
    '-map', '0:v',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    '-y',
    outPath,
  );
  return args;
}

/**
 * Mix the placed VO lines (and, when present, a ducked music bed) onto
 * `inputVideoPath`, replacing the file in place. Returns `{ ok: true }` on
 * success or `{ ok: false, reason }` on any failure (graceful degradation —
 * the caller keeps the prior video).
 *
 * `voLines` is `[{ path, offsetSec }]`; entries without an on-disk file or a
 * finite, >= 0 offset are dropped (un-placed lines stay silent rather than
 * stacking at t=0). With no usable lines this returns ok:false so the caller
 * can fall back to the music-only `muxMusicBed` path.
 */
export async function muxVoLines(inputVideoPath, { voLines = [], musicPath = null, musicGain = DEFAULT_MUSIC_GAIN, duck = DEFAULT_DUCK, signal } = {}) {
  if (!inputVideoPath || !existsSync(inputVideoPath)) {
    return { ok: false, reason: 'input video missing' };
  }
  const placed = (Array.isArray(voLines) ? voLines : []).filter((l) => (
    l?.path && existsSync(l.path) && isPlacedOffset(l.offsetSec)
  ));
  if (!placed.length) return { ok: false, reason: 'no placed VO lines' };
  // A missing music file is not fatal — drop to a VO-only mux rather than
  // failing, so a stale `music.trackFilename` pointer can't suppress dialogue.
  const usableMusic = musicPath && existsSync(musicPath) ? musicPath : null;

  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg not on PATH' };

  // Preserve the stitched clip's own soundtrack (LTX-2 audio-to-video) by
  // mixing 0:a in, ducked under VO. Gate on hasAudioStream: referencing [0:a]
  // in the filter graph against a silent AI-gen clip would abort the whole
  // mux, and a probe failure (no ffprobe) safely defaults to the prior
  // replace-the-track behavior.
  const clipAudio = await hasAudioStream(inputVideoPath);

  const tmpOut = `${inputVideoPath}.vomux.${randomUUID()}.mp4`;
  const args = buildVoMuxArgs({ inputVideoPath, voLines: placed, musicPath: usableMusic, musicGain, duck, clipAudio, outPath: tmpOut });

  const result = await runFfmpegProcess({ bin: ffmpeg, args, signal });
  if (!result.ok) {
    await unlink(tmpOut).catch(() => {});
    return result;
  }
  await rename(tmpOut, inputVideoPath);
  return { ok: true, lineCount: placed.length, ducked: !!usableMusic, clipAudio };
}

export { DEFAULT_MUSIC_GAIN, DEFAULT_DUCK };
