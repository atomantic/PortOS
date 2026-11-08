/**
 * Mouth-lead correction for local audio-to-video (a2v) renders (#15409).
 *
 * a2v models (the LTX-2 family, MiniMax H3 Ref2VA) tend to move the mouth
 * 0–6 frames (typically ~2) ahead of the conditioning audio, and the lead
 * varies per clip, so no fixed offset fixes it. After the render, measure it:
 * cross-correlate per-frame motion energy in a mouth-region proxy with the
 * rate of change of the speech-band envelope of the clip's own soundtrack.
 * When the peak is a confident mouth-first lag, hold the first frame for that
 * many frames (`tpad` clone) and drop as many from the tail, so the clip keeps
 * its exact frame count. The soundtrack is stream-copied, never shifted.
 *
 * This changes DELIVERY of the model's output only; the audio and prompt the
 * model was conditioned on are untouched. Best-effort: anything that cannot be
 * measured or verified leaves the render exactly as the model wrote it.
 */

import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import {
  findFfmpeg, runFfmpegProcess, probeFrameCount, probeVideoStreamInfo, hasAudioStream,
  installEncodedVideo, bt709TagFilter, H264_ENCODE_ARGS, BT709_CONTAINER_ARGS, FFMPEG_SCAN_TIMEOUT_MS,
} from './ffmpeg.js';

/** Largest mouth-first lead corrected, in frames (the observed model range). */
export const LIPSYNC_MAX_LEAD_FRAMES = 6;
// Fewer analysed frames than this (~1 s at 24 fps) cannot support a verdict.
const MIN_FRAMES = 24;
const MIN_PEAK_SCORE = 0.3;
// Fisher z (atanh(r)·√(n−3)) at the peak — roughly p < 0.002.
const MIN_FISHER_Z = 3;
// The peak must beat the zero-lag correlation by this much; a broad peak is not a lead.
const MIN_GAIN = 0.05;

// Mouth-region proxy: the lower-centre of the frame, where a framed talking or
// singing subject's mouth sits. There is no face tracking; the confidence gates
// below are what keep camera or body motion from being read as a lead.
const ROI_FILTER = 'crop=w=iw/2:h=ih/2:x=iw/4:y=ih*0.35,scale=64:32:flags=area,format=gray';
const ROI_FRAME_BYTES = 64 * 32;
const AUDIO_RATE = 16000;
// Speech band; keeps bass and cymbals in a music bed from dominating the envelope.
const SPEECH_BAND_FILTER = 'highpass=f=300,lowpass=f=3400';
const FLAT_EPSILON = 1e-9;

const noShift = (reason, extra = {}) => ({ shiftFrames: 0, lag: null, peakScore: null, reason, ...extra });

const variance = (values) => {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
};

const pearson = (a, b) => {
  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) { meanA += a[i]; meanB += b[i]; }
  meanA /= n;
  meanB /= n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  return varA <= FLAT_EPSILON || varB <= FLAT_EPSILON ? 0 : cov / Math.sqrt(varA * varB);
};

/**
 * Pearson correlation of `motion[t]` with `onset[t + lag]` for every lag in
 * `[-maxLag, maxLag]`. A positive lag means the motion comes first: the mouth
 * leads the audio by `lag` frames.
 */
function lagCorrelations(motion, onset, maxLag) {
  const n = Math.min(motion.length, onset.length);
  const out = [];
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const start = Math.max(0, -lag);
    const end = Math.min(n, n - lag);
    const count = end - start;
    out.push({ lag, n: count, r: count > 3 ? pearson(motion.slice(start, end), onset.slice(start + lag, end + lag)) : 0 });
  }
  return out;
}

/**
 * Decide the frame hold for a clip from its two per-frame signals (aligned by
 * frame index). Returns `{ shiftFrames, lag, peakScore, reason }`; `shiftFrames`
 * is non-zero only for a confident mouth-first lead within
 * `LIPSYNC_MAX_LEAD_FRAMES`.
 */
function planLipsyncShift({ motion, onset, maxLead = LIPSYNC_MAX_LEAD_FRAMES }) {
  const n = Math.min(motion?.length ?? 0, onset?.length ?? 0);
  if (n < MIN_FRAMES) return noShift('too-short');
  const a = Array.from(motion).slice(0, n);
  const b = Array.from(onset).slice(0, n);
  if (variance(a) <= FLAT_EPSILON || variance(b) <= FLAT_EPSILON) return noShift('flat-signal');
  // Search one frame past the correctable range so a lead at exactly maxLead is
  // a real local peak, and a peak at the search edge is recognisably out of range.
  const correlations = lagCorrelations(a, b, maxLead + 1);
  const peak = correlations.reduce((best, c) => (
    c.r > best.r || (c.r === best.r && Math.abs(c.lag) < Math.abs(best.lag)) ? c : best
  ));
  const zero = correlations.find((c) => c.lag === 0);
  const result = { lag: peak.lag, peakScore: Math.round(peak.r * 1e4) / 1e4 };
  if (peak.lag <= 0) return { shiftFrames: 0, ...result, reason: 'no-lead' };
  const fisherZ = Math.atanh(Math.min(peak.r, 0.999999)) * Math.sqrt(peak.n - 3);
  const confident = peak.lag <= maxLead
    && peak.r >= MIN_PEAK_SCORE
    && fisherZ >= MIN_FISHER_Z
    && peak.r - zero.r >= MIN_GAIN;
  return confident
    ? { shiftFrames: peak.lag, ...result, reason: 'mouth-lead' }
    : { shiftFrames: 0, ...result, reason: 'low-confidence' };
}

/** Mean absolute luma change into each frame from the previous one (frames 1..N-1). */
function motionEnergy(gray, frameBytes = ROI_FRAME_BYTES) {
  const frames = Math.floor(gray.length / frameBytes);
  const out = [];
  for (let f = 1; f < frames; f++) {
    let sum = 0;
    const at = f * frameBytes;
    for (let i = 0; i < frameBytes; i++) sum += Math.abs(gray[at + i] - gray[at - frameBytes + i]);
    out.push(sum / frameBytes);
  }
  return out;
}

/**
 * Absolute change of the per-frame RMS envelope into each frame (frames
 * 1..N-1). Mouth motion is a rate — the mouth opening or closing — so it is
 * matched against the envelope's rate of change, not its level.
 */
function envelopeOnset(samples, { sampleRate, fps, frames }) {
  const perFrame = sampleRate / fps;
  const rms = [];
  for (let f = 0; f < frames; f++) {
    const start = Math.round(f * perFrame);
    const end = Math.min(samples.length, Math.round((f + 1) * perFrame));
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    rms.push(end > start ? Math.sqrt(sum / (end - start)) : 0);
  }
  return rms.slice(1).map((v, i) => Math.abs(v - rms[i]));
}

const readStdout = async (bin, args) => {
  const chunks = [];
  const run = await runFfmpegProcess({ bin, args, timeoutMs: FFMPEG_SCAN_TIMEOUT_MS, onStdout: (chunk) => chunks.push(chunk) });
  return run.ok ? Buffer.concat(chunks) : null;
};

/**
 * Decode a clip into the two signals `planLipsyncShift` takes. Resolves
 * `{ motion, onset, frames, fps }`, or `{ reason }` when it cannot.
 */
async function measureLipsyncSignals(videoPath) {
  if (typeof videoPath !== 'string' || !existsSync(videoPath)) return { reason: 'unmeasurable' };
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return { reason: 'unmeasurable' };
  if (!(await hasAudioStream(videoPath))) return { reason: 'no-audio' };
  const [info, frames] = await Promise.all([probeVideoStreamInfo(videoPath), probeFrameCount(videoPath)]);
  if (!info.fps || !frames) return { reason: 'unmeasurable' };
  const [gray, pcm] = await Promise.all([
    readStdout(ffmpeg, ['-v', 'error', '-i', videoPath, '-map', '0:v:0', '-vf', ROI_FILTER,
      '-frames:v', String(frames), '-f', 'rawvideo', '-pix_fmt', 'gray', '-']),
    readStdout(ffmpeg, ['-v', 'error', '-i', videoPath, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(AUDIO_RATE),
      '-af', SPEECH_BAND_FILTER, '-t', (frames / info.fps).toFixed(6), '-f', 'f32le', '-']),
  ]);
  if (!gray || !pcm) return { reason: 'unmeasurable' };
  const samples = new Float32Array(Math.floor(pcm.length / 4));
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readFloatLE(i * 4);
  const motion = motionEnergy(gray);
  const onset = envelopeOnset(samples, { sampleRate: AUDIO_RATE, fps: info.fps, frames: motion.length + 1 });
  return { motion, onset, frames, fps: info.fps };
}

/**
 * argv that delays the picture by `shiftFrames` (cloning frame 0) while keeping
 * `totalFrames` and stream-copying the soundtrack.
 */
const buildHoldArgs = ({ inPath, outPath, shiftFrames, totalFrames, colorTagFilter = null }) => [
  '-v', 'error', '-i', inPath, '-map', '0:v:0', '-map', '0:a:0',
  '-vf', `tpad=start=${shiftFrames}:start_mode=clone,trim=end_frame=${totalFrames},setpts=PTS-STARTPTS${colorTagFilter ? `,${colorTagFilter}` : ''}`,
  ...H264_ENCODE_ARGS, ...BT709_CONTAINER_ARGS, '-c:a', 'copy',
  '-movflags', '+faststart', '-y', outPath,
];

const holdLeadingFrames = async ({ videoPath, shiftFrames, totalFrames }) => {
  const tmpPath = `${videoPath}.lipsync.mp4`;
  try {
    const ffmpeg = await findFfmpeg({ requiredEncoder: 'libx264' }).catch(() => null);
    if (!ffmpeg) return { ok: false, reason: 'ffmpeg with libx264 not found' };
    const run = await runFfmpegProcess({
      bin: ffmpeg,
      args: buildHoldArgs({ inPath: videoPath, outPath: tmpPath, shiftFrames, totalFrames, colorTagFilter: await bt709TagFilter() }),
    });
    if (!run.ok) return run;
    const heldFrames = await probeFrameCount(tmpPath);
    if (heldFrames !== totalFrames) return { ok: false, reason: `held clip has ${heldFrames ?? '?'} frames, expected ${totalFrames}` };
    return await installEncodedVideo(tmpPath, videoPath, 'lip-sync aligned');
  } catch (err) {
    // A failed rollback leaves the original at a backup path: publication is
    // genuinely uncertain, so the render must fail rather than finalize.
    if (err?.backupPublicationUncertain) throw err;
    return { ok: false, reason: err.message };
  } finally {
    // installEncodedVideo moved the temp on success; otherwise it is a leftover.
    await unlink(tmpPath).catch(() => {});
  }
};

/**
 * Measure a finished a2v render in place and, on a confident mouth-first lead,
 * hold its opening frame to bring the picture back onto the soundtrack.
 * Resolves `{ shiftFrames, lag, peakScore, reason }`; `shiftFrames > 0` means the file was replaced.
 * `reason` is a fixed token, so a persisted result never carries an ffmpeg
 * message (which can name a path): mouth-lead, no-lead, low-confidence,
 * too-short, flat-signal, no-audio, unmeasurable, hold-failed.
 */
export async function alignLipsyncLead({ videoPath, label = '' }) {
  const tag = label ? ` [${label}]` : '';
  let measured;
  try {
    measured = await measureLipsyncSignals(videoPath);
  } catch (err) {
    console.warn(`⚠️ Lip-sync measurement failed, keeping the render${tag}: ${err.message}`);
    return noShift('unmeasurable');
  }
  if (measured.reason) {
    console.log(`⏭️ Lip-sync alignment skipped (${measured.reason})${tag}`);
    return noShift(measured.reason);
  }
  const plan = planLipsyncShift(measured);
  if (!plan.shiftFrames) {
    console.log(`⏭️ Lip-sync alignment not needed (${plan.reason}, lag ${plan.lag ?? '?'}, r ${plan.peakScore ?? '?'})${tag}`);
    return plan;
  }
  const held = await holdLeadingFrames({ videoPath, shiftFrames: plan.shiftFrames, totalFrames: measured.frames });
  if (!held.ok) {
    console.warn(`⚠️ Lip-sync frame hold failed, keeping the render${tag}: ${held.reason}`);
    return { ...plan, shiftFrames: 0, reason: 'hold-failed' };
  }
  console.log(`👄 Lip-sync aligned: held ${plan.shiftFrames} frame(s) for a mouth-first lead (r ${plan.peakScore})${tag}`);
  return plan;
}

// Test hook: the planner's input matrix is pinned on synthetic signals.
export { planLipsyncShift as _planLipsyncShift };
