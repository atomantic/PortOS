/**
 * The audio-bed mix chain shared by the video timeline render (`local.js`)
 * and the Music Video render's optional sound-design bed (#8988).
 *
 * Each bed is trimmed from its own offset, faded on its own clock, then
 * delayed to its project-time start and mixed under the main audio.
 * `amix … duration=first` keeps the main audio's length (a bed can never
 * extend the output), and `normalize=0` keeps adding a bed from silently
 * attenuating everything already in the mix.
 *
 * Pure: returns the ffmpeg `-i` args for the beds and the filter strings, so
 * each caller owns its own input numbering and graph labels.
 */

/** MASTER_LOUDNESS.truePeakDb (-1.5 dB) as a linear amplitude, for alimiter's `limit`. */
export const PEAK_CEILING_LINEAR = 0.8414;

/** ffmpeg-safe number formatting (six decimals, no exponent). */
export const fmtSec = (n) => String(Math.round(Number(n) * 1e6) / 1e6);

// Every audio branch entering a mix/concat must present identical link parameters.
export const AUDIO_NORM = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';

/**
 * @param {object} opts
 * @param {Array<{assetPath:string, offsetSec:number, durationSec:number, startSec?:number, volume?:number, fadeInSec?:number, fadeOutSec?:number}>} opts.beds
 * @param {number} opts.firstInputIdx  ffmpeg input index the first bed will take
 * @param {string} opts.mainLabel      the main audio's filter label, e.g. `[ca]`
 * @param {string} opts.outLabel       the mixed output label, e.g. `[outa]`
 * @param {boolean} [opts.limitPeak]   end the mix with an `alimiter` at the -1.5 dB ceiling (#10249).
 *   Only peaks above the ceiling are touched; the main audio gets no gain change.
 * @returns {{ inputs: string[], filters: string[] }}
 */
export function buildAudioBedMix({ beds, firstInputIdx, mainLabel, outLabel, limitPeak = false }) {
  const inputs = [];
  const filters = [];
  const bedLabels = [];
  (beds || []).forEach((tr, j) => {
    inputs.push('-i', tr.assetPath);
    const parts = [
      'aresample=48000',
      'aformat=sample_fmts=fltp:channel_layouts=stereo',
      `atrim=start=${fmtSec(tr.offsetSec)}:end=${fmtSec(tr.offsetSec + tr.durationSec)}`,
      'asetpts=PTS-STARTPTS',
    ];
    const volume = tr.volume == null ? 1 : tr.volume;
    if (volume !== 1) parts.push(`volume=${fmtSec(volume)}`);
    if (tr.fadeInSec > 0) parts.push(`afade=t=in:st=0:d=${fmtSec(tr.fadeInSec)}`);
    if (tr.fadeOutSec > 0) {
      parts.push(`afade=t=out:st=${fmtSec(Math.max(0, tr.durationSec - tr.fadeOutSec))}:d=${fmtSec(tr.fadeOutSec)}`);
    }
    if (tr.startSec > 0) {
      const ms = Math.round(tr.startSec * 1000);
      parts.push(`adelay=${ms}|${ms}`);
    }
    filters.push(`[${firstInputIdx + j}:a]${parts.join(',')}[bed${j}]`);
    bedLabels.push(`[bed${j}]`);
  });
  if (bedLabels.length > 0) {
    const mixed = limitPeak ? '[bedmix]' : outLabel;
    filters.push(`${mainLabel}${bedLabels.join('')}amix=inputs=${bedLabels.length + 1}:duration=first:dropout_transition=0:normalize=0${mixed}`);
    if (limitPeak) filters.push(`${mixed}alimiter=limit=${PEAK_CEILING_LINEAR}:level=disabled,${AUDIO_NORM}${outLabel}`);
  }
  return { inputs, filters };
}
