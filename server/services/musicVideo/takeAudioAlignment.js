/**
 * Line a performance take's picture up with the song by its own soundtrack
 * (#11210).
 *
 * A performance take's edit in/out points are planned on the assumption that
 * the provider's clip starts exactly where the submitted audio window starts.
 * Some providers pad the clip instead: fal OmniHuman v1.5 returns a clip a
 * second longer than its audio with the speech starting ~0.4–0.7 s in, so a
 * take placed by the planned in-point sings late. The clip's mouth motion
 * follows the clip's OWN audio track, so that track — matched against the
 * window it was conditioned on — says where the song really sits in the clip.
 *
 * `alignPerformanceInstruction` runs when a take lands (the scene-video hook),
 * for any provider whose clip carries audio. It shifts `edit.inSec` /
 * `edit.outSec` by the measured offset — every renderer, preview and handoff
 * reads those as clip times, and every later trim (beat snap, planned span,
 * intercut, repair prefix) is taken relative to `edit.inSec`, so they all stay
 * aligned — and records `alignment` with the planned points it replaced. Code
 * that maps clip time back to song time subtracts `clipAudioOffsetSec`.
 *
 * Best-effort: no audio track, an unreadable file, or a weak match leaves the
 * instruction exactly as planned.
 */

import { existsSync } from 'fs';
import { PATHS } from '../../lib/fileUtils.js';
import { hasAudioStream, safeUnder } from '../../lib/ffmpeg.js';
import { computeRmsEnvelope, envelopeOffsetSec, FINGERPRINT_RATE_HZ } from '../../lib/audioFingerprint.js';

export const TAKE_ALIGNMENT_VERSION = 1;
// Under a frame at 24 fps the planned points already sit on the song.
const APPLY_MIN_SEC = 0.02;

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * `instruction` with its edit points moved onto the clip's audio, or
 * `instruction` unchanged. `clipPath` is the finished take's file.
 */
export async function alignPerformanceInstruction(instruction, clipPath) {
  const edit = instruction?.edit;
  const window = instruction?.audioWindow;
  const sourceName = instruction?.audio?.conditioning?.filename;
  if (instruction?.shotMode !== 'performance' || instruction.alignment || !Number.isFinite(edit?.inSec) || !Number.isFinite(edit?.outSec)
    || !Number.isFinite(window?.startSec) || !Number.isFinite(window?.endSec) || typeof sourceName !== 'string') return instruction;
  const sourcePath = safeUnder(PATHS.music, sourceName);
  if (!sourcePath || !existsSync(sourcePath) || !clipPath || !existsSync(clipPath) || !(await hasAudioStream(clipPath))) return instruction;

  const [song, clip] = await Promise.all([computeRmsEnvelope(sourcePath), computeRmsEnvelope(clipPath)]);
  const startFrame = Math.ceil(window.startSec * FINGERPRINT_RATE_HZ - 1e-6);
  const endFrame = Math.min(song.length, Math.floor(window.endSec * FINGERPRINT_RATE_HZ + 1e-6));
  if (!(endFrame > startFrame)) return instruction;
  const match = envelopeOffsetSec(song.subarray(startFrame, endFrame), clip);
  if (!match) return instruction;
  // The envelope grid starts a few ms after the window does.
  const offsetSec = round3(match.offsetSec - (startFrame / FINGERPRINT_RATE_HZ - window.startSec));
  // A clip that starts early can only be pulled back to its first frame.
  const appliedSec = Math.abs(offsetSec) < APPLY_MIN_SEC ? 0 : round3(Math.max(offsetSec, -edit.inSec));
  return {
    ...instruction,
    edit: { ...edit, inSec: round3(edit.inSec + appliedSec), outSec: round3(edit.outSec + appliedSec) },
    alignment: {
      version: TAKE_ALIGNMENT_VERSION,
      method: 'rms-envelope-xcorr',
      offsetSec: appliedSec,
      measuredSec: offsetSec,
      correlation: match.correlation,
      planned: { inSec: edit.inSec, outSec: edit.outSec },
    },
  };
}
