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
import { findFfmpeg, runFfmpegProcess, hasAudioStream, safeUnder } from '../../lib/ffmpeg.js';
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
  const out = [];
  for (const l of lines) {
    if (!l?.audioFilename || !isPlacedOffset(l.offsetSec)) continue;
    // Validate the filename is a safe basename under PATHS.audio before building
    // an ffmpeg input path — VO line state can arrive from a synced peer, so a
    // traversal/absolute filename must be dropped rather than handed to ffmpeg
    // (mirrors the selectPlacedCues guard below).
    const path = safeUnder(PATHS.audio, l.audioFilename);
    if (!path) continue;
    out.push({ path, offsetSec: l.offsetSec });
  }
  return out;
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

// Build the VO-mix sub-graph: delay each VO line to its offset, resample, and
// (for 2+ lines) amix at full level. `firstInputIdx` is the ffmpeg input index
// of the FIRST VO line (1 when VO follows the video directly, cues.length+1 when
// cues precede it). Appends to `chains` and returns the label of the mixed VO
// track. Shared by buildVoMuxArgs (VO are inputs 1..N) and buildCueMuxArgs (VO
// follow the cues) so the delay/amix contract can't drift between them.
function appendVoMixChain(chains, voLines, firstInputIdx) {
  voLines.forEach((line, i) => {
    const ms = Math.round(Number(line.offsetSec) * 1000);
    // adelay `:all=1` delays every channel by `ms` regardless of layout, so a
    // mono VO WAV doesn't need an explicit per-channel delay list.
    chains.push(`[${firstInputIdx + i}:a]adelay=${ms}:all=1,${AFMT}[vo${i}]`);
  });
  if (voLines.length === 1) return '[vo0]';
  const ins = voLines.map((_, i) => `[vo${i}]`).join('');
  chains.push(`${ins}amix=inputs=${voLines.length}:normalize=0[vomix]`);
  return '[vomix]';
}

// Build the sidechain-duck sub-graph: pad the VO mix to infinity, split it into
// a "mixed back" copy + one sidechain key per bed, sidechaincompress each bed
// against its key, then amix the ducked beds back over the VO. The apad-before-
// split keeps each bed alive past the last VO line (sidechaincompress ends with
// its shortest input). Appends to `chains` and returns the final `[aout]` label.
// Shared by both mux builders so the (tricky, load-bearing) pad/split/duck graph
// stays identical. `keyPrefix` namespaces the intermediate labels.
function appendDuckChain(chains, voMixLabel, beds, duck, keyPrefix) {
  const keys = beds.map((_, i) => `[${keyPrefix}sck${i}]`);
  chains.push(`${voMixLabel}apad,asplit=${beds.length + 1}[vomain]${keys.join('')}`);
  const ducked = beds.map((bed, i) => {
    chains.push(`${bed}${keys[i]}sidechaincompress=threshold=${duck.threshold}:ratio=${duck.ratio}:attack=${duck.attack}:release=${duck.release}[${keyPrefix}ducked${i}]`);
    return `[${keyPrefix}ducked${i}]`;
  });
  chains.push(`${ducked.join('')}[vomain]amix=inputs=${beds.length + 1}:normalize=0[aout]`);
  return '[aout]';
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
  // VO are inputs 1..N (directly after the video).
  const voMixLabel = appendVoMixChain(chains, voLines, 1);

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
    appendDuckChain(chains, voMixLabel, beds, duck, 'vo');
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

// ── Multi-cue bed (audioMode: 'generated') ────────────────────────────────
// Whole-episode audio (issue #863, step 4): the 'generated' mode assembles an
// ordered cues[] onto an ABSOLUTE timeline — each rendered cue laid at its
// startSec with a fade in/out, then amix-ed into one bed. This is NOT
// acrossfade: acrossfade is sequential concatenation (splices two streams
// back-to-back, ignoring absolute offsets), so it can't place cues at arbitrary
// timeline positions. The delayed + faded cues are combined with
// `amix=normalize=0` (so cues keep their level rather than being attenuated by
// 1/N), and the resulting bed is ducked under VO via the same machinery as the
// music bed when placed VO lines exist.

// Fade length at each cue boundary. A short fade in/out blends adjacent cues at
// act turns without an audible click; kept well under the shortest plausible
// cue so it never swallows a whole cue.
const CUE_FADE_SEC = 1.5;

/**
 * Pure: map an issue's raw `stages.audio.cues` to the cues that are actually
 * muxable — *rendered* (have a `trackFilename`) AND *placed* (have a finite,
 * >= 0 `startSec`). Returns `[{ path, startSec, endSec, gain }]` with each
 * filename resolved under PATHS.music. Single source of truth for "what counts
 * as a placed+rendered cue", shared by the stitch runner and the arg builder so
 * the predicate can't drift.
 */
export function selectPlacedCues(cues) {
  if (!Array.isArray(cues)) return [];
  const out = [];
  for (const c of cues) {
    if (!c?.trackFilename || !isPlacedOffset(c.startSec)) continue;
    // Validate the filename is a safe basename under PATHS.music before building
    // an ffmpeg input path — cue state can arrive from a synced peer, so a
    // traversal/absolute filename must be dropped rather than handed to ffmpeg.
    const path = safeUnder(PATHS.music, c.trackFilename);
    if (!path) continue;
    out.push({
      path,
      startSec: c.startSec,
      // endSec is advisory for fade timing; null when un-placed.
      endSec: isPlacedOffset(c.endSec) && c.endSec > c.startSec ? c.endSec : null,
      // null gain → fall back to the stage default; 0 is a real "muted" value.
      gain: typeof c.gain === 'number' && Number.isFinite(c.gain) && c.gain >= 0 ? c.gain : null,
    });
  }
  return out;
}

/**
 * Build the ffmpeg argv for the multi-cue 'generated' bed. Pure — unit-tested
 * without spawning.
 *
 * Input order: video is input 0, each cue is inputs 1..N (in the order given),
 * and — when present — the placed VO lines are inputs N+1..N+M. `cues` MUST
 * already be filtered to placed+rendered entries (selectPlacedCues does this).
 *
 * Graph:
 *   - each cue: looped (`-stream_loop -1`) then trimmed to its placed span so a
 *     short rendered clip fills its whole timeline slot instead of going silent
 *     partway through; delayed to its startSec (`adelay`); faded in at its start
 *     and out at its end (`afade`); resampled to the shared format; gained
 *   - all cues `amix=normalize=0` into one absolute-timeline bed
 *   - the clip's own soundtrack (`[0:a]`) is preserved when `clipAudio` is set:
 *     mixed into the bed (no VO) or ducked alongside the cue bed (with VO)
 *   - when VO lines are present: the bed(s) are ducked under VO via
 *     `sidechaincompress` (same key machinery as buildVoMuxArgs), and the VO is
 *     mixed back over the ducked bed
 *   - `-shortest` pins the output to the video length
 */
export function buildCueMuxArgs({ inputVideoPath, cues, voLines = [], musicGain = DEFAULT_MUSIC_GAIN, duck = DEFAULT_DUCK, clipAudio = false, outPath }) {
  const args = ['-i', inputVideoPath];
  // Loop each cue input so a cue rendered shorter than its placed span still
  // fills the slot — the per-cue `atrim` below cuts it back to the exact span.
  for (const cue of cues) args.push('-stream_loop', '-1', '-i', cue.path);
  for (const line of voLines) args.push('-i', line.path);

  const chains = [];
  // Each cue: trim the (looped) source to its placed span, delay to its absolute
  // start, fade in/out, resample, gain.
  cues.forEach((cue, i) => {
    const inputIdx = i + 1; // 0 is the video
    const delayMs = Math.round(Number(cue.startSec) * 1000);
    const gain = Number(cue.gain ?? musicGain).toFixed(3);
    const span = (typeof cue.endSec === 'number' && cue.endSec > cue.startSec)
      ? cue.endSec - cue.startSec
      : null;
    const filters = [];
    // Trim the looped stream to the placed span first (atrim is on the cue's
    // own timeline, before adelay shifts it onto the episode timeline). Without
    // a known span we don't loop-trim — leave the single play, bounded by amix
    // + -shortest. (selectPlacedCues only loses endSec when it's not placed.)
    if (span) filters.push(`atrim=0:${span.toFixed(3)}`);
    filters.push(`adelay=${delayMs}:all=1`);
    // Fade IN at the cue's absolute start (post-delay timeline). Fade OUT just
    // before endSec when we know the span.
    filters.push(`afade=t=in:st=${(cue.startSec).toFixed(3)}:d=${CUE_FADE_SEC}`);
    if (span && span > CUE_FADE_SEC) {
      const fadeOutStart = (cue.endSec - CUE_FADE_SEC).toFixed(3);
      filters.push(`afade=t=out:st=${fadeOutStart}:d=${CUE_FADE_SEC}`);
    }
    filters.push(`volume=${gain}`, AFMT);
    chains.push(`[${inputIdx}:a]${filters.join(',')}[cue${i}]`);
  });

  // Mix the cues into one bed. A single cue needs no amix.
  let bedLabel;
  if (cues.length === 1) {
    bedLabel = '[cue0]';
  } else {
    const ins = cues.map((_, i) => `[cue${i}]`).join('');
    chains.push(`${ins}amix=inputs=${cues.length}:normalize=0[cuebed]`);
    bedLabel = '[cuebed]';
  }

  if (voLines.length) {
    // VO are inputs (cues.length+1)..(cues.length+voLines.length) — after the
    // cues. Mix them, then duck the cue bed (and clip audio, when present) under
    // VO via the shared duck graph. `cue` prefix namespaces the duck labels so
    // they can't collide with a VO-only mux's labels.
    const voMixLabel = appendVoMixChain(chains, voLines, cues.length + 1);
    const beds = [bedLabel];
    if (clipAudio) {
      chains.push(`[0:a]${AFMT}[clip]`);
      beds.push('[clip]');
    }
    appendDuckChain(chains, voMixLabel, beds, duck, 'cue');
  } else if (clipAudio) {
    // No VO but the clip carries its own soundtrack — the design preserves it
    // under the generated cues (not replace). Mix [0:a] in alongside the cue
    // bed rather than ducking (no dialogue to duck under). apad so -shortest
    // pins the result to the video length.
    chains.push(`[0:a]${AFMT}[clip]`);
    chains.push(`${bedLabel}[clip]amix=inputs=2:normalize=0,apad[aout]`);
  } else {
    // No VO, silent clip — the cue bed is the whole soundtrack. apad so
    // -shortest pins it to the video length rather than the last cue.
    chains.push(`${bedLabel}apad[aout]`);
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
 * Mix the placed+rendered cues (and, when present, ducked VO + clip audio) onto
 * `inputVideoPath`, replacing the file in place. Returns `{ ok: true, cueCount }`
 * on success or `{ ok: false, reason }` on any failure (graceful degradation —
 * the caller keeps the prior video).
 *
 * `cues` is `[{ path, startSec, endSec, gain }]`; entries without an on-disk file
 * or a finite, >= 0 startSec are dropped. With no usable cues this returns
 * ok:false so the caller can leave the (clip-audio) video as-is.
 */
export async function muxCueBed(inputVideoPath, { cues = [], voLines = [], musicGain = DEFAULT_MUSIC_GAIN, duck = DEFAULT_DUCK, signal } = {}) {
  if (!inputVideoPath || !existsSync(inputVideoPath)) {
    return { ok: false, reason: 'input video missing' };
  }
  const placedCues = (Array.isArray(cues) ? cues : []).filter((c) => (
    c?.path && existsSync(c.path) && isPlacedOffset(c.startSec)
  ));
  if (!placedCues.length) return { ok: false, reason: 'no placed+rendered cues' };
  const placedVo = (Array.isArray(voLines) ? voLines : []).filter((l) => (
    l?.path && existsSync(l.path) && isPlacedOffset(l.offsetSec)
  ));

  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg not on PATH' };

  // Preserve the clip's own soundtrack whenever it has one — the design's
  // 'generated' row keeps clip audio (mixed under the cues with no VO, ducked
  // alongside the cue bed with VO). Probe unconditionally: referencing [0:a]
  // against a silent clip aborts the graph, so we only set clipAudio when a
  // stream is actually present (a probe failure safely returns false).
  const clipAudio = await hasAudioStream(inputVideoPath);

  const tmpOut = `${inputVideoPath}.cuemux.${randomUUID()}.mp4`;
  const args = buildCueMuxArgs({ inputVideoPath, cues: placedCues, voLines: placedVo, musicGain, duck, clipAudio, outPath: tmpOut });

  const result = await runFfmpegProcess({ bin: ffmpeg, args, signal });
  if (!result.ok) {
    await unlink(tmpOut).catch(() => {});
    return result;
  }
  await rename(tmpOut, inputVideoPath);
  return { ok: true, cueCount: placedCues.length, ducked: placedVo.length > 0, clipAudio };
}

/**
 * Strip ALL audio from the episode, replacing the file in place. This is the
 * `audioMode: 'silent'` path with no placed VO — the design specifies a silent
 * episode strips the clip's own soundtrack (LTX-2 audio-to-video) rather than
 * preserving it. `-an` drops the audio stream; the video is stream-copied so
 * there's no re-encode. Graceful degradation: returns `{ ok: false, reason }`
 * on any failure so the caller keeps the prior output.
 */
export async function muxStripAudio(inputVideoPath, { signal } = {}) {
  if (!inputVideoPath || !existsSync(inputVideoPath)) {
    return { ok: false, reason: 'input video missing' };
  }
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg not on PATH' };
  const tmpOut = `${inputVideoPath}.silent.${randomUUID()}.mp4`;
  const args = [
    '-i', inputVideoPath,
    '-map', '0:v',
    '-an',
    '-c:v', 'copy',
    '-movflags', '+faststart',
    '-y',
    tmpOut,
  ];
  const result = await runFfmpegProcess({ bin: ffmpeg, args, signal });
  if (!result.ok) {
    await unlink(tmpOut).catch(() => {});
    return result;
  }
  await rename(tmpOut, inputVideoPath);
  return { ok: true };
}

export { DEFAULT_MUSIC_GAIN, DEFAULT_DUCK };
