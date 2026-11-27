/** Plan and report measured loudness mastering for PortOS audio exports. */

import { runFfmpegProcess } from './process.js';

// Loudness mastering for audio PortOS itself produces (#10249): the platform
// target a social feed normalizes toward, and the true-peak ceiling that keeps
// the AAC encode from clipping.
export const MASTER_LOUDNESS = Object.freeze({ targetLufs: -14, truePeakDb: -1.5, lra: 11 });
// Below this integrated loudness a soundtrack is treated as silent.
export const SILENT_LUFS = -50;

// loudnorm aims half a dB under the ceiling: the AAC encode that follows can
// overshoot its input's true peak by a tenth of a dB or so.
const AAC_HEADROOM_DB = 0.5;
const loudnormTarget = `I=${MASTER_LOUDNESS.targetLufs}:TP=${MASTER_LOUDNESS.truePeakDb - AAC_HEADROOM_DB}:LRA=${MASTER_LOUDNESS.lra}`;
const roundDb = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : n);
// loudnorm prints numbers as strings and "-inf" for silence.
const parseDb = (v) => (/-\s*inf/i.test(String(v)) ? -Infinity : /inf/i.test(String(v)) ? Infinity : Number(v));

/**
 * Read the JSON block `loudnorm=print_format=json` writes to stderr. Returns
 * the unrounded measurement, or null when no block is present.
 */
function parseLoudnormJson(stderr) {
  const block = String(stderr ?? '').match(/\{[^{}]*"input_i"[^{}]*\}/g)?.pop();
  if (!block) return null;
  let raw;
  try { raw = JSON.parse(block); } catch { return null; }
  return {
    integratedLufs: parseDb(raw.input_i), truePeakDb: parseDb(raw.input_tp), loudnessRange: parseDb(raw.input_lra),
    thresholdDb: parseDb(raw.input_thresh), offsetDb: parseDb(raw.target_offset),
  };
}

/**
 * Measurement pass: run `inputArgs` (ffmpeg input options plus `-i`) through
 * an optional `prefilter` and loudnorm in analysis mode, discarding the audio.
 * Resolves `{ ok: true, measured }` (values rounded to 0.1 for reporting;
 * `raw` keeps full precision for the apply pass) or `{ ok: false, reason }`.
 */
async function measureLoudness({ bin, inputArgs, prefilter = '', durationSec, signal, run = runFfmpegProcess }) {
  const filter = [prefilter, `loudnorm=${loudnormTarget}:print_format=json`].filter(Boolean).join(',');
  const result = await run({
    bin, signal, returnStderr: true, stderrTailBytes: 8000,
    args: ['-hide_banner', '-nostats', ...inputArgs, '-vn', '-af', filter, ...(durationSec ? ['-t', String(durationSec)] : []), '-f', 'null', '-'],
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  const raw = parseLoudnormJson(result.stderr);
  if (!raw) return { ok: false, reason: 'loudness measurement produced no result' };
  return { ok: true, raw, measured: { integratedLufs: roundDb(raw.integratedLufs), truePeakDb: roundDb(raw.truePeakDb), loudnessRange: roundDb(raw.loudnessRange) } };
}

/** Apply pass: loudnorm in linear mode fed the numbers the measurement pass found. */
function loudnormApplyFilter(raw) {
  const n = (v) => Math.round(v * 100) / 100;
  return `loudnorm=${loudnormTarget}:measured_I=${n(raw.integratedLufs)}:measured_TP=${n(raw.truePeakDb)}:measured_LRA=${n(raw.loudnessRange)}:measured_thresh=${n(raw.thresholdDb)}:offset=${n(raw.offsetDb)}:linear=true,aresample=48000`;
}

/**
 * Measure-then-apply for one audio source. Resolves `{ filter, before }`:
 * `filter` goes into the encode's `-af`, `before` holds the rounded pre-master
 * numbers. Preserve dynamics when mastering an already approved mix: achieve
 * as much gain as the peak budget allows without changing its envelope.
 */
export async function planLoudnessMaster({ preserveDynamics = false, ...options }) {
  const result = await measureLoudness(options);
  if (!result.ok) throw new Error(`Audio mastering could not measure the soundtrack: ${result.reason}`);
  if (!(result.raw.integratedLufs > SILENT_LUFS)) {
    throw new Error(`Soundtrack is silent: measured ${Number.isFinite(result.raw.integratedLufs) ? `${result.measured.integratedLufs} LUFS` : 'no signal'} (below ${SILENT_LUFS} LUFS)`);
  }
  if (!preserveDynamics) return { filter: loudnormApplyFilter(result.raw), before: result.measured };
  const { integratedLufs, truePeakDb } = result.raw;
  const gain = Math.min(MASTER_LOUDNESS.targetLufs - integratedLufs, MASTER_LOUDNESS.truePeakDb - AAC_HEADROOM_DB - truePeakDb);
  return { filter: `volume=${gain.toFixed(2)}dB`, before: result.measured };
}

/**
 * Measure a finished render's audio and report it beside the pre-master
 * numbers. Throws when the file has no measurable (or only silent) audio.
 */
export async function reportMasteredLoudness({ bin, outputPath, before, signal, run }) {
  const result = await measureLoudness({ bin, inputArgs: ['-i', outputPath], signal, run });
  if (!result.ok) throw new Error(`Rendered video has no measurable audio: ${result.reason}`);
  if (!(result.raw.integratedLufs > SILENT_LUFS)) throw new Error(`Rendered soundtrack is silent: measured ${result.measured.integratedLufs} LUFS`);
  return { ...result.measured, masteredFrom: { integratedLufs: before.integratedLufs, truePeakDb: before.truePeakDb }, targetLufs: MASTER_LOUDNESS.targetLufs };
}

// A clip cut from mid-song (a social cut) starts and stops on a hard edge; a
// short fade in and a longer fade out keep it from clicking. Returned as an
// `-af` chain fragment (leading comma) so callers append it to their trim.
export const edgeFadeFilter = (durationSec, { inSec = 0.08, outSec = 0.6 } = {}) => {
  const out = Math.min(outSec, Math.max(0, durationSec / 2));
  const fadeIn = Math.min(inSec, Math.max(0, durationSec / 2));
  return `,afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${Math.max(0, durationSec - out).toFixed(3)}:d=${out}`;
};
