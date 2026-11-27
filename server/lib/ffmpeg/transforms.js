/** Build FFmpeg clip transforms and run thumbnail, trim, upscale, and streaming encodes. */

import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import { dirname, join, resolve as resolvePath } from 'path';
import { ensureDir, PATHS } from '../fileUtils.js';
import { BT709_CONTAINER_ARGS, bt709TagFilter, findFfmpeg, vfrSyncArgs } from './discovery.js';
import { FFMPEG_FRAME_TIMEOUT_MS, FFMPEG_SCAN_TIMEOUT_MS, installEncodedVideo, runFfmpegProcess } from './process.js';
import { hasAudioStream, probeFrameCount, probeVideoDuration, probeVideoStreamInfo } from './probe.js';

// The standard H.264 encode profile re-encoding paths share. Visually
// lossless to most viewers and plays everywhere — but the reason it's a
// constant rather than three inlined copies is that clips encoded by DIFFERENT
// paths get concatenated together (a chained render's trimmed chunks join its
// untrimmed ones), and a mismatch there shows up as one segment being graded
// differently from its neighbours. Callers append their own `-c:a`. The film
// look finishing pass has one gated WebCodecs exception: it checks encoded
// quality against this profile and the output's codec/timing before using it;
// otherwise it falls back to the shared composition encoder.
export const H264_ENCODE_ARGS = Object.freeze([
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium',
]);
export const AAC_ENCODE_ARGS = Object.freeze(['-c:a', 'aac', '-b:a', '192k']);

// even when the clip itself is fine. Mid-clip is reliably the visual peak.
//
// Strategy: probe duration via ffprobe and seek to duration/2 (capped at
// 2.5s — the canonical mid-point of a 5s 24fps LTX clip). When ffprobe is
// unavailable or returns a tiny duration we fall back to a fixed -ss 1.0
// rather than frame 0, since 1s is still past the LTX fade-in on every
// useful clip length. `-ss` BEFORE `-i` is the fast-seek path (keyframe
// step), which is fine for thumbnails — exact-frame accuracy isn't needed.
//
// Returns the basename on success, null when ffmpeg is missing or fails —
// callers should treat null as "no thumbnail" rather than aborting the
// parent operation.
export const generateThumbnail = async (videoPath, jobId, { atSec } = {}) => {
  await ensureDir(PATHS.videoThumbnails);
  const thumbFilename = `${jobId}.jpg`;
  const thumbPath = join(PATHS.videoThumbnails, thumbFilename);
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return null;
  const duration = await probeVideoDuration(videoPath);
  // Cap at 2.5s — the midpoint of a 5s 24fps LTX clip (121 frames). For
  // longer clips (Extend mode, 10s+) 2.5s is still past the LTX fade-in
  // and not at an unreliable boundary. For short clips (<2s) seek to the
  // actual midpoint. Fall back to 1s when ffprobe is unavailable.
  const stream = Number.isFinite(atSec) && duration ? await probeVideoStreamInfo(videoPath) : null;
  const lastFrameSec = duration ? Math.max(0, duration - (stream?.fps > 0 ? 1 / stream.fps : 0.001)) : atSec;
  const seekSec = Number.isFinite(atSec)
    ? Math.max(0, Math.min(atSec, lastFrameSec))
    : duration ? Math.min(2.5, Math.max(0.5, duration / 2)) : 1.0;
  const result = await runFfmpegProcess({
    bin: ffmpeg,
    args: ['-ss', seekSec.toFixed(Number.isFinite(atSec) ? 6 : 2), '-i', videoPath, '-vframes', '1', '-q:v', '5', '-y', thumbPath],
    stderrTailBytes: 0,
    timeoutMs: FFMPEG_FRAME_TIMEOUT_MS,
  });
  if (!result.ok && result.reason?.startsWith('spawn failed: ')) {
    console.log(`⚠️ ffmpeg thumbnail failed to spawn: ${result.reason.slice('spawn failed: '.length)}`);
  }
  return result.ok ? thumbFilename : null;
};

// `data/video-thumbnails/`. Returns the array of basenames in timeline order
// on success, or `[]` on any failure — callers should fall back to the
// single-frame thumbnail rather than aborting.
//
// Why this exists: i2v scenes whose intent develops mid-or-late (archway
// appears at 60%, light bloom at 80%) get rejected by the evaluator when it
// only sees frame 0. Sampling 5 frames lets the agent judge intent across
// the entire timeline rather than just the opening pose.
export const extractEvaluationFrames = async (videoPath, jobId, count = 5) => {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return [];

  const totalFrames = await probeFrameCount(videoPath);
  if (!totalFrames) return [];

  await ensureDir(PATHS.videoThumbnails);

  const frameIndices = totalFrames <= count
    ? Array.from({ length: totalFrames }, (_, i) => i)
    : (() => {
        const last = totalFrames - 1;
        // Quartile sampling (start, 25%, 50%, 75%, end). Generalizes to any
        // `count` ≥ 2 — for count=5 this matches the spec exactly.
        const positions = [];
        if (count === 1) return [0];
        for (let i = 0; i < count; i++) {
          positions.push(Math.round((i * last) / (count - 1)));
        }
        // Dedup in case rounding collapses adjacent indices on tiny clips.
        return Array.from(new Set(positions));
      })();

  // Filter expression: select frames matching any of the target indices.
  // Single-quoting the expression lets ffmpeg's filter parser treat the
  // commas inside `eq(n,X)` as expression args rather than filter-chain
  // separators. VFR sync prevents the image2 muxer from padding output
  // to maintain input fps (which would re-emit each match repeatedly).
  const selectExpr = frameIndices.map((i) => `eq(n,${i})`).join('+');
  const outPattern = join(PATHS.videoThumbnails, `${jobId}-f%d.jpg`);

  const result = await runFfmpegProcess({
    bin: ffmpeg,
    args: ['-i', videoPath, '-vf', `select='${selectExpr}'`, ...await vfrSyncArgs(ffmpeg), '-q:v', '5', '-y', outPattern],
    stderrTailBytes: 0,
    timeoutMs: FFMPEG_SCAN_TIMEOUT_MS,
  });
  if (!result.ok && result.reason?.startsWith('spawn failed: ')) {
    console.log(`⚠️ ffmpeg multi-frame extract failed to spawn: ${result.reason.slice('spawn failed: '.length)}`);
  }
  if (!result.ok) return [];
  // ffmpeg's image2 muxer numbers output starting at 1 in match order, so
  // the basenames map 1:1 to our frameIndices in timeline order.
  return frameIndices.map((_, i) => `${jobId}-f${i + 1}.jpg`);
};

// Append a filter to a comma-separated ffmpeg filter chain, tolerating both an
// empty chain and a `null` filter (the unsupported-build case).
const appendFilter = (chain, filter) => {
  if (!filter) return chain;
  return chain ? `${chain},${filter}` : filter;
};

// Keep frames [startFrame, endFrame) of a clip (endFrame omitted = to the end).
//
// Both halves of the chained-render context window need exactly this cut: the
// tail window handed to LTX-2's extend pipeline is "keep the last N frames"
// (startFrame = total - N), and trimming the echoed context back off an extend
// render is "keep everything after the echo" (startFrame = prefix length). See
// `lib/videoContinuity.js` for how those indices are derived.
//
// Frame-exact by construction: the `trim` filter cuts on a frame INDEX rather
// than a timestamp, so the seam can't drift by a frame the way an `-ss` seek
// can — and a one-frame drift here is a visible stutter or a repeated frame in
// the stitched clip. `atrim` cuts the audio at the matching timestamp so LTX's
// jointly-generated soundtrack stays in sync; a silent clip takes `-an`
// instead, because referencing a missing audio stream aborts the whole run.
//
// Re-encodes (a frame-index cut can't be stream-copied — the new first frame
// is almost never a keyframe). Callers that then concat the result must
// re-encode at concat time too rather than relying on `-c copy`.
//
// `outPath` may be the input path: the encode goes to a sibling temp file and
// is renamed into place, so a failure leaves the original untouched.
//
// Returns `{ ok: true, outPath }` or `{ ok: false, reason }`.
export const trimVideoFromFrame = async (videoPath, outPath, { startFrame, endFrame, fps } = {}) => {
  if (typeof videoPath !== 'string' || !videoPath) return { ok: false, reason: 'invalid video path' };
  if (typeof outPath !== 'string' || !outPath) return { ok: false, reason: 'invalid output path' };
  if (!existsSync(videoPath)) return { ok: false, reason: 'video file missing' };
  const start = Math.max(0, Math.floor(Number(startFrame) || 0));
  const end = endFrame == null ? null : Math.floor(Number(endFrame));
  if (end !== null && !(end > start)) return { ok: false, reason: `invalid end frame: ${endFrame}` };
  const rate = Number(fps);
  if (!Number.isFinite(rate) || rate <= 0) return { ok: false, reason: `invalid fps: ${fps}` };
  let ffmpeg;
  try {
    ffmpeg = await findFfmpeg({ requiredEncoder: 'libx264' });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg not found' };

  const inPlace = resolvePath(videoPath) === resolvePath(outPath);
  const encodePath = inPlace ? `${videoPath}.trim.mp4` : outPath;
  if (!inPlace) await ensureDir(dirname(outPath));

  const audio = await hasAudioStream(videoPath);
  const colorFilter = await bt709TagFilter();
  const result = await runFfmpegProcess({
    bin: ffmpeg,
    args: [
      '-i', videoPath,
      '-vf', appendFilter(`trim=start_frame=${start}${end === null ? '' : `:end_frame=${end}`},setpts=PTS-STARTPTS`, colorFilter),
      ...(audio
        // atrim takes seconds; the frame index converts exactly because the
        // clips this runs on are CFR renders straight out of the model.
        ? ['-af', `atrim=start=${(start / rate).toFixed(6)}${end === null ? '' : `:end=${(end / rate).toFixed(6)}`},asetpts=PTS-STARTPTS`, ...AAC_ENCODE_ARGS]
        : ['-an']),
      ...H264_ENCODE_ARGS,
      ...BT709_CONTAINER_ARGS,
      '-movflags', '+faststart',
      '-y', encodePath,
    ],
  });
  if (!result.ok) {
    await unlink(encodePath).catch(() => {});
    return { ok: false, reason: `ffmpeg trim failed: ${result.reason}` };
  }
  if (!inPlace) return { ok: true, outPath };
  return installEncodedVideo(encodePath, videoPath, 'trimmed');
};

// Re-encode a clip through a spatial video filter (lib/handheldCamera.js's
// shake) into a NEW file, copying any audio untouched: the filter keeps every
// frame and its timing, so the soundtrack still lines up.
// Returns `{ ok: true, outPath }` or `{ ok: false, reason }`.
export const filterVideoFrames = async (videoPath, outPath, { filter, filterComplex, signal, label = 'filter' } = {}) => {
  if (typeof videoPath !== 'string' || !videoPath) return { ok: false, reason: 'invalid video path' };
  if (typeof outPath !== 'string' || !outPath || resolvePath(videoPath) === resolvePath(outPath)) return { ok: false, reason: 'invalid output path' };
  if (!existsSync(videoPath)) return { ok: false, reason: 'video file missing' };
  // `filterComplex` is a full graph whose single video output is labelled
  // `[outv]` (lib/verticalReframe.js); the audio stream is mapped through as is.
  if (typeof (filterComplex || filter) !== 'string' || !(filterComplex || filter)) return { ok: false, reason: 'no filter' };
  let ffmpeg;
  try {
    ffmpeg = await findFfmpeg({ requiredEncoder: 'libx264' });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg not found' };
  await ensureDir(dirname(outPath));
  const audio = await hasAudioStream(videoPath);
  const tag = await bt709TagFilter();
  const filterArgs = filterComplex
    ? ['-filter_complex', tag ? filterComplex.replace(/\[outv\]$/, `,${tag}[outv]`) : filterComplex, '-map', '[outv]', ...(audio ? ['-map', '0:a'] : [])]
    : ['-vf', appendFilter(filter, tag)];
  const result = await runFfmpegProcess({
    bin: ffmpeg,
    signal,
    args: [
      '-i', videoPath,
      ...filterArgs,
      ...(audio ? ['-c:a', 'copy'] : ['-an']),
      ...H264_ENCODE_ARGS,
      ...BT709_CONTAINER_ARGS,
      '-movflags', '+faststart',
      '-y', outPath,
    ],
  });
  if (!result.ok) {
    await unlink(outPath).catch(() => {});
    return { ok: false, reason: `ffmpeg ${label} failed: ${result.reason}` };
  }
  return { ok: true, outPath };
};

// Cut `[startSec, endSec)` of a clip into a new file (a music-video sequence
// take split onto its scenes, #14241). Re-encodes for the same reason as
// trimVideoFromFrame. Returns `{ ok: true, outPath }` or `{ ok: false, reason }`.
export const cutVideoSegment = async (videoPath, outPath, { startSec, endSec } = {}) => {
  if (typeof videoPath !== 'string' || !videoPath) return { ok: false, reason: 'invalid video path' };
  if (typeof outPath !== 'string' || !outPath || resolvePath(videoPath) === resolvePath(outPath)) return { ok: false, reason: 'invalid output path' };
  if (!existsSync(videoPath)) return { ok: false, reason: 'video file missing' };
  const start = Number(startSec);
  const end = Number(endSec);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return { ok: false, reason: `invalid span ${startSec}-${endSec}` };
  let ffmpeg;
  try {
    ffmpeg = await findFfmpeg({ requiredEncoder: 'libx264' });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg not found' };
  await ensureDir(dirname(outPath));
  const audio = await hasAudioStream(videoPath);
  const colorFilter = await bt709TagFilter();
  const span = `start=${start.toFixed(6)}:end=${end.toFixed(6)}`;
  const result = await runFfmpegProcess({
    bin: ffmpeg,
    args: [
      '-i', videoPath,
      '-vf', appendFilter(`trim=${span},setpts=PTS-STARTPTS`, colorFilter),
      ...(audio ? ['-af', `atrim=${span},asetpts=PTS-STARTPTS`, ...AAC_ENCODE_ARGS] : ['-an']),
      ...H264_ENCODE_ARGS,
      ...BT709_CONTAINER_ARGS,
      '-movflags', '+faststart',
      '-y', outPath,
    ],
  });
  if (!result.ok) {
    await unlink(outPath).catch(() => {});
    return { ok: false, reason: `ffmpeg cut failed: ${result.reason}` };
  }
  return { ok: true, outPath };
};

// Build the ffmpeg argv that concatenates a list of clips where SOME of them
// must drop a leading run of frames first (`startFrame > 0`).
//
// Why a filter graph rather than trimming the files and running the concat
// demuxer over them: a frame-index trim can't be stream-copied, so cutting
// each clip in place costs one full encode per clip — and it also knocks the
// trimmed clips out of codec lockstep with the untrimmed ones, forcing the
// concat itself to re-encode too. Doing the cut inside the concat's own graph
// collapses all of that into the single timeline encode that was going to
// happen anyway, and leaves the source clips byte-identical on disk.
//
// Mirrors the shape `services/videoTimeline/local.js` renders projects with —
// including the belt-and-suspenders normalization. `scale`+`pad`+`setsar` and
// `fps=` on the video leg, `aresample`+`aformat` on the audio leg, are what
// keep ffmpeg from aborting the whole run with "Input link parameters do not
// match" when the inputs disagree even slightly. `width`/`height`/`fps` are
// each applied only when they resolve to a usable number, so a caller that
// doesn't know a canonical value simply gets no normalization for it rather
// than an `undefined` in the graph.
//
// `withAudio` must be true only when EVERY input carries an audio stream
// (`hasAudioStream`): `concat=a=1` needs an audio leg from each input, and
// referencing `[k:a]` on a silent clip aborts the run. A mixed set takes the
// video-only graph, which is what a chain of silent AI renders wants anyway.
//
// `colorTagFilter` is the `setparams` string from `bt709TagFilter()` (or `null`
// on an ffmpeg build without the filter). It stays a PARAMETER rather than
// being probed in here so this builder remains pure and synchronously testable
// — the caller is already async and does the probe once. The container flags
// need no probe and are always emitted.
export const buildTrimConcatArgs = ({ inputs, outPath, width, height, fps, withAudio = false, colorTagFilter = null }) => {
  const clips = Array.isArray(inputs) ? inputs : [];
  if (clips.length < 2) return null;
  const canonW = Number(width);
  const canonH = Number(height);
  const rate = Number(fps);
  const hasDims = Number.isFinite(canonW) && canonW > 0 && Number.isFinite(canonH) && canonH > 0;
  const hasRate = Number.isFinite(rate) && rate > 0;
  // An audio leg on a trimmed input needs `atrim`'s start TIMESTAMP, which
  // only exists if we know the frame rate. Without one, drop the audio rather
  // than emit a graph whose audio and video are offset from each other.
  const trimsAudio = clips.some((c) => Math.floor(Number(c?.startFrame) || 0) > 0);
  const audio = Boolean(withAudio) && (hasRate || !trimsAudio);

  const filters = [];
  const concatStreams = [];
  clips.forEach((clip, i) => {
    const startFrame = Math.max(0, Math.floor(Number(clip?.startFrame) || 0));
    // `trim` leads the chain on purpose. `start_frame` is an index into the
    // frames the filter SEES, so cutting before `fps=` resamples keeps it an
    // index into the source — which is what the caller measured with
    // `probeFrameCount`. It also means the discarded frames never get scaled
    // or padded, which on a windowed chain is roughly half of every chunk.
    const video = [
      ...(startFrame > 0 ? [`trim=start_frame=${startFrame}`] : []),
      'setpts=PTS-STARTPTS',
      ...(hasDims ? [`scale=${canonW}:${canonH}:force_original_aspect_ratio=decrease,pad=${canonW}:${canonH}:(ow-iw)/2:(oh-ih)/2,setsar=1`] : []),
      ...(hasRate ? [`fps=${rate}`] : []),
    ];
    filters.push(`[${i}:v]${video.join(',')}[v${i}]`);
    if (audio) {
      const track = [
        // The frame index converts exactly because these are CFR renders.
        ...(startFrame > 0 ? [`atrim=start=${(startFrame / rate).toFixed(6)}`] : []),
        'asetpts=PTS-STARTPTS',
        'aresample=48000',
        'aformat=sample_fmts=fltp:channel_layouts=stereo',
      ];
      filters.push(`[${i}:a]${track.join(',')}[a${i}]`);
    }
    concatStreams.push(audio ? `[v${i}][a${i}]` : `[v${i}]`);
  });
  // Tag on the way OUT of the concat rather than per input: one stamp on the
  // joined stream is what the encoder reads, and stamping each leg would repeat
  // the filter N times for the same result. With an audio leg the concat emits
  // two pads, so the tag can't simply trail the concat — give the video pad its
  // own label and hang the filter off that in both shapes, so there is one code
  // path instead of two.
  // Only a real filter STRING earns the extra link — anything else would splice
  // `[cv]undefined[outv]` into the graph and fail the whole encode, which is a
  // far worse outcome than the untagged output it was meant to improve on.
  const tag = typeof colorTagFilter === 'string' && colorTagFilter ? colorTagFilter : null;
  const videoPad = tag ? '[cv]' : '[outv]';
  filters.push(`${concatStreams.join('')}concat=n=${clips.length}:v=1:a=${audio ? 1 : 0}${videoPad}${audio ? '[outa]' : ''}`);
  if (tag) filters.push(`[cv]${tag}[outv]`);

  return [
    ...clips.flatMap((clip) => ['-i', clip.path]),
    '-filter_complex', filters.join(';'),
    '-map', '[outv]',
    ...(audio ? ['-map', '[outa]'] : []),
    ...H264_ENCODE_ARGS,
    ...BT709_CONTAINER_ARGS,
    ...(audio ? AAC_ENCODE_ARGS : ['-an']),
    '-movflags', '+faststart',
    '-y', outPath,
  ];
};

// Lossless audio master kept beside an Extend output (see
// `services/videoGen/extendSplice.js`): FLAC at 24-bit, 48 kHz, so the next
// round's source span is decoded from PCM instead of from a prior AAC encode.
const MASTER_AUDIO_ARGS = Object.freeze(['-c:a', 'flac', '-sample_fmt', 's32']);

// The audio half of an Extend splice, shared by the re-encode and stream-copy
// builders. `sourceIdx` is the input carrying the source span's audio (the
// source clip, or its lossless master), `generatedIdx` the render's.
//
// The source span comes from `sourceIdx`, the new span from the render, joined by
// a short LINEAR crossfade (`crossfadeSec`) so the seam doesn't click. The source
// leg runs `crossfadeSec` past the seam so the overlap is source-vs-generated at
// the SAME timeline position, which keeps the output exactly as long as the render.
// Returns the filter chains plus whether a `[outm]` master pad was emitted.
const extendSpliceAudioFilters = ({ audio, sourceIdx, generatedIdx, keep, rate, crossfadeSec, withMaster }) => {
  if (audio !== 'splice' && audio !== 'generated') return [];
  const canonAudio = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const seamSec = keep / rate;
  const fade = Math.max(0.001, Number(crossfadeSec) || 0);
  const mixed = audio === 'splice'
    ? [
      // apad guards a source track that ends before the seam + overlap, which
      // acrossfade would otherwise reject as shorter than the fade.
      `[${sourceIdx}:a]atrim=end=${(seamSec + fade).toFixed(6)},asetpts=PTS-STARTPTS,${canonAudio},apad=whole_dur=${(seamSec + fade).toFixed(6)}[a0]`,
      `[${generatedIdx}:a]atrim=start=${seamSec.toFixed(6)},asetpts=PTS-STARTPTS,${canonAudio}[a1]`,
      `[a0][a1]acrossfade=d=${fade.toFixed(6)}:c1=tri:c2=tri`,
    ]
    : [`[${generatedIdx}:a]asetpts=PTS-STARTPTS,${canonAudio}`];
  // One decoded mix feeds both outputs, so the delivered AAC is encoded once
  // from the same samples the master keeps.
  const last = `${mixed.pop()}${withMaster ? ',asplit=2[outa][outm]' : '[outa]'}`;
  return [...mixed, last];
};

const validExtendSplice = ({ keepFrames, newStartFrame, fps, width, height }) => {
  const keep = Math.floor(Number(keepFrames));
  const start = Math.floor(Number(newStartFrame));
  const rate = Number(fps);
  const canonW = Number(width);
  const canonH = Number(height);
  const ok = Number.isFinite(keep) && keep > 0 && Number.isFinite(start) && start > 0
    && Number.isFinite(rate) && rate > 0 && Number.isFinite(canonW) && canonW > 0
    && Number.isFinite(canonH) && canonH > 0;
  return ok ? { keep, start, rate, canonW, canonH } : null;
};

const extendNormalizeFilter = ({ canonW, canonH, rate }) =>
  `scale=${canonW}:${canonH}:force_original_aspect_ratio=decrease,pad=${canonW}:${canonH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${rate}`;

// The two outputs every Extend builder shares: the delivered mp4 (video codec
// args vary by builder) and, when `masterOutPath` is given, the lossless master.
const extendOutputs = ({ audio, videoLabel, videoCodecArgs, outPath, masterOutPath }) => [
  '-map', videoLabel,
  ...(audio === 'none' ? [] : ['-map', '[outa]']),
  ...videoCodecArgs,
  ...(audio === 'none' ? ['-an'] : AAC_ENCODE_ARGS),
  '-movflags', '+faststart',
  '-y', outPath,
  ...(masterOutPath && audio !== 'none' ? ['-map', '[outm]', ...MASTER_AUDIO_ARGS, '-y', masterOutPath] : []),
];

// Build the argv that joins the ORIGINAL source of a native extend render to the
// model's new frames: input 0 is the source clip (kept for frames
// `[0, keepFrames)`), input 1 is the render (kept from `newStartFrame` on).
// Lets a plain Extend deliver the source as shot instead of the model's VAE
// decode of it; `lib/videoContinuity.js#planExtendSplice` supplies the indices.
//
// Video is one single encode of source + new — never a per-round compounding of
// the model's own decode. Geometry and rate normalize to the RENDER's, which is
// what the extension was generated at. Audio follows the same split (see
// `extendSpliceAudioFilters`).
//
// `audio` is 'splice' (both inputs have a track), 'generated' (only the render
// has one — the source region has nothing to keep, so the render's track stands)
// or 'none'. `sourceAudioPath` (optional) is a lossless master standing in for
// the source clip's own track as the source span's audio; `masterOutPath`
// (optional, must end in an audio extension like `.flac`) also writes this
// output's mix as a lossless master. Pure, like buildTrimConcatArgs: the caller
// probes and passes `colorTagFilter` from `bt709TagFilter()`.
export const buildExtendSpliceArgs = ({
  sourcePath, generatedPath, outPath, keepFrames, newStartFrame, width, height, fps,
  audio = 'none', crossfadeSec = 0.04, colorTagFilter = null, sourceAudioPath = null, masterOutPath = null,
}) => {
  if (!sourcePath || !generatedPath || !outPath) return null;
  const geometry = validExtendSplice({ keepFrames, newStartFrame, fps, width, height });
  if (!geometry) return null;
  const { keep, start, rate } = geometry;

  const normalize = extendNormalizeFilter(geometry);
  const tag = typeof colorTagFilter === 'string' && colorTagFilter ? colorTagFilter : null;
  const withMaster = !!masterOutPath && audio !== 'none';
  const filters = [
    `[0:v]trim=end_frame=${keep},setpts=PTS-STARTPTS,${normalize}[v0]`,
    `[1:v]trim=start_frame=${start},setpts=PTS-STARTPTS,${normalize}[v1]`,
    `[v0][v1]concat=n=2:v=1:a=0${tag ? '[cv]' : '[outv]'}`,
    ...(tag ? [`[cv]${tag}[outv]`] : []),
    ...extendSpliceAudioFilters({ audio, sourceIdx: sourceAudioPath ? 2 : 0, generatedIdx: 1, keep, rate, crossfadeSec, withMaster }),
  ];

  return [
    '-i', sourcePath, '-i', generatedPath,
    ...(sourceAudioPath && audio === 'splice' ? ['-i', sourceAudioPath] : []),
    '-filter_complex', filters.join(';'),
    ...extendOutputs({
      audio, videoLabel: '[outv]', outPath, masterOutPath,
      videoCodecArgs: [...H264_ENCODE_ARGS, ...BT709_CONTAINER_ARGS],
    }),
  ];
};

// Stream-copy counterpart of buildExtendSpliceArgs, in two steps so the source's
// frames stay bit-identical (the re-encode path rewrites them every round).
//
// 1. `buildExtendNewSpanArgs` encodes ONLY the render's new span (frames from
//    `newStartFrame`) as a silent mp4 with the shared H.264 profile — a fresh
//    GOP, so it starts on a keyframe by construction.
// 2. `buildExtendCopyArgs` joins the source (copied, never decoded) to that span
//    through the concat demuxer's `listPath`, pinning the source entry to
//    `keepFrames / fps` so the seam lands on the frame boundary, not on the
//    source file's (audio-padded) container duration. Audio is the same
//    crossfaded mix as the re-encode path.
//
// The caller proves the result (frame count and per-frame hashes) before it
// replaces anything — stream copy is only valid when both halves carry
// compatible codec parameters, which the encode cannot promise on its own.
export const buildExtendNewSpanArgs = ({ generatedPath, outPath, newStartFrame, width, height, fps, colorTagFilter = null }) => {
  if (!generatedPath || !outPath) return null;
  const geometry = validExtendSplice({ keepFrames: 1, newStartFrame, fps, width, height });
  if (!geometry) return null;
  const tag = typeof colorTagFilter === 'string' && colorTagFilter ? colorTagFilter : null;
  return [
    '-i', generatedPath,
    '-filter_complex', `[0:v]trim=start_frame=${geometry.start},setpts=PTS-STARTPTS,${extendNormalizeFilter(geometry)}${tag ? `,${tag}` : ''}[outv]`,
    '-map', '[outv]',
    ...H264_ENCODE_ARGS, ...BT709_CONTAINER_ARGS, '-an',
    '-movflags', '+faststart',
    '-y', outPath,
  ];
};

// One concat-demuxer list entry; single quotes inside a path are escaped per the
// demuxer's own quoting rules.
const concatEntry = (path) => `file '${String(path).replace(/'/g, "'\\''")}'`;

/** Body of the concat-demuxer list for `buildExtendCopyArgs`. */
export const buildExtendConcatList = ({ sourcePath, newSpanPath, keepFrames, fps }) =>
  `${[concatEntry(sourcePath), `duration ${(Number(keepFrames) / Number(fps)).toFixed(6)}`, concatEntry(newSpanPath)].join('\n')}\n`;

export const buildExtendCopyArgs = ({
  listPath, generatedPath, outPath, keepFrames, fps, audio = 'none', crossfadeSec = 0.04,
  sourceAudioPath = null, masterOutPath = null,
}) => {
  const keep = Math.floor(Number(keepFrames));
  const rate = Number(fps);
  if (!listPath || !generatedPath || !outPath) return null;
  if (!Number.isFinite(keep) || keep <= 0 || !Number.isFinite(rate) || rate <= 0) return null;
  // The concat input only carries the source's VIDEO, so a spliced mix names the
  // clip (or its master) that supplies the source span's audio explicitly.
  if (audio === 'splice' && !sourceAudioPath) return null;
  const withMaster = !!masterOutPath && audio !== 'none';
  const filters = extendSpliceAudioFilters({ audio, sourceIdx: 2, generatedIdx: 1, keep, rate, crossfadeSec, withMaster });
  return [
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-i', generatedPath,
    ...(audio === 'splice' ? ['-i', sourceAudioPath] : []),
    ...(filters.length ? ['-filter_complex', filters.join(';')] : []),
    ...extendOutputs({ audio, videoLabel: '0:v:0', outPath, masterOutPath, videoCodecArgs: ['-c:v', 'copy'] }),
  ];
};

// 2× Lanczos upscale of an MP4 in place. Doubles width and height while
// preserving the exact aspect ratio and the audio track. Used as a quick
// post-render export option for LTX renders that come out at sub-720p
// (e.g. 768×512, 640×384) so they read crisply on bigger screens without
// re-running the model. `+faststart` is preserved on the output.
//
// Returns `{ ok: true, outPath }` on success and `{ ok: false, reason }`
// on any failure — callers decide whether to surface the error.
//
// Encoding choice: H.264 yuv420p CRF 18 (visually lossless to most
// viewers, plays everywhere). The audio track is stream-copied so the
// LTX-2 audio bed survives untouched. ffmpeg's lanczos scaler is the
// classical "good default" for upscale — sharper than bicubic, no
// ringing artifacts on smooth gradients.
//
// Concurrency contract: `optimizeForStreaming` and `upscaleVideo2x` both
// rewrite the same file via a sibling tmp + atomic rename. Don't run them
// concurrently against the same path; the queue worker that produces a
// rendered clip already serializes both.
export const upscaleVideo2x = async (videoPath) => {
  if (typeof videoPath !== 'string' || !videoPath) {
    return { ok: false, reason: 'invalid video path' };
  }
  if (!existsSync(videoPath)) {
    return { ok: false, reason: 'video file missing' };
  }
  let ffmpeg;
  try {
    ffmpeg = await findFfmpeg({ requiredEncoder: 'libx264' });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg not found' };
  // -2 keeps the dimension on an even multiple (libx264 requires even
  // dimensions); pairing iw*2:-2 with the lanczos flag gives a clean
  // exact 2× width and the matching height. Avoiding `iw*2:ih*2` because
  // any user-supplied source with an odd dimension would otherwise fail.
  const tmpPath = `${videoPath}.up2x.mp4`;
  const result = await runFfmpegProcess({
    bin: ffmpeg,
    args: [
      '-i', videoPath,
      '-vf', appendFilter('scale=iw*2:-2:flags=lanczos', await bt709TagFilter()),
      ...H264_ENCODE_ARGS,
      ...BT709_CONTAINER_ARGS,
      '-c:a', 'copy',
      '-movflags', '+faststart',
      '-y', tmpPath,
    ],
  });
  if (!result.ok) {
    await unlink(tmpPath).catch(() => {});
    return { ok: false, reason: `ffmpeg upscale failed: ${result.reason}` };
  }
  return installEncodedVideo(tmpPath, videoPath, 'upscaled');
};

// MP4s with the moov atom at the END require browsers to download the entire
// file before they can render the first-frame poster on preload="metadata".
// Remux with -movflags +faststart to move moov to the front. Stream copy —
// no re-encoding.
export const optimizeForStreaming = async (videoPath) => {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return;
  const tmpPath = `${videoPath}.fs.mp4`;
  const result = await runFfmpegProcess({
    bin: ffmpeg,
    args: ['-i', videoPath, '-c', 'copy', '-movflags', '+faststart', '-y', tmpPath],
  });
  if (!result.ok) { await unlink(tmpPath).catch(() => {}); return; }
  // Best-effort: faststart is a nicety, so a failed install is logged and
  // swallowed rather than surfaced — the original clip is already restored.
  const installed = await installEncodedVideo(tmpPath, videoPath, 'streaming-optimized');
  if (!installed.ok) console.log(`⚠️ ${installed.reason} (at ${videoPath})`);
};
