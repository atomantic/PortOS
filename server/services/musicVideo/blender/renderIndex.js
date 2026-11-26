import { blenderFinalsSignature, blenderFramesDir as filmFramesDir, readBlenderRenders as readFilmRenders } from '../../film/renderIndex.js';
import { normalizeBlenderRecord, summarizeBlenderShots } from '../../../lib/musicVideo/musicVideoBlender.js';
import { readBlenderManifest } from './manifest.js';
import { musicVideoFilmOwner } from './owner.js';
export const blenderFramesDir = (id, ...args) => filmFramesDir(musicVideoFilmOwner(id), ...args);
const readBlenderRenders = (id, ...args) => readFilmRenders(musicVideoFilmOwner(id), ...args);
/**
 * What a project read says about its Blender film: `shots` is how far the
 * final shots are (`{ total, finalReady, ready }`; `ready` is the Shots step:
 * every manifest shot has a complete, current final render), and `finalStale`
 * whether the project's final video no longer matches them: a shot went out
 * of date or was rendered again since that video was joined (null when the
 * project has no final this film recorded). Read-time only; a project without
 * a synced film is `{ 0, 0, false }`.
 */
export async function blenderFilmReadState(project) {
  const manifest = await readBlenderManifest(project.id);
  const { settings } = normalizeBlenderRecord(project.blender);
  const shots = manifest?.shots || [];
  const renders = shots.length ? await readBlenderRenders(project.id, manifest, { project, settings, finalsOnly: true }) : {};
  return { shots: summarizeBlenderShots(shots, renders), finalStale: blenderFinalStale(project, shots, renders) };
}

/**
 * Whether the project's final video no longer matches its film's shots; null
 * when the project's current final is not one this film recorded joining.
 */
export function blenderFinalStale(project, shots, renders) {
  const { final } = normalizeBlenderRecord(project.blender);
  if (!project.renderHistoryId || final?.jobId !== project.renderHistoryId) return null;
  return !summarizeBlenderShots(shots, renders).ready || final.signature !== blenderFinalsSignature(shots, renders);
}
