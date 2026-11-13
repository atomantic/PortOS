/**
 * The sound under a film's lead-in shots. The film supplies the picture; the
 * Board's cold-open controls supply the sound, mixed by the footage path.
 */
import { blenderShotFrameRange, normalizeBlenderRecord } from '../../../lib/musicVideoBlender.js';
import { coldOpenAudioShots, ensureColdOpenAudio } from '../coldOpen.js';
import { shotSegmentDir } from '../shotSegmentPaths.js';
import { blenderLeadSec, blenderLeadShots } from './manifest.js';

/** `{ leadSec, leadPath }` for `shots`, or a zero lead when the film starts on the song. */
export async function blenderLeadAudio(project, shots, fps) {
  const lead = blenderLeadShots(shots);
  if (!lead.length) return { leadSec: 0, leadPath: null };
  const map = normalizeBlenderRecord(project.blender).sceneMap || {};
  const entries = lead.map((shot) => ({
    sceneId: map[shot.id],
    clip: null,
    durationSec: blenderShotFrameRange(shot, fps).frameCount / fps,
  }));
  const mixed = await coldOpenAudioShots(project, entries);
  const leadPath = await ensureColdOpenAudio(mixed, shotSegmentDir(project.id));
  return { leadSec: blenderLeadSec(shots), leadPath };
}
