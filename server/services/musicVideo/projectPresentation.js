/**
 * The read presentation of a Music Video project: what `GET /:id` adds to the stored record
 * (take staleness, cast-and-sets and run pins, readiness, song-audio drift, a Blender film's state).
 *
 * Split into the reads it needs (`readPresentationInputs`) and a pure step (`presentProjectRecord`)
 * so an edit can present its before and after records from one set of reads (editResult.js).
 */

import { presentMusicVideoDependencies } from '../../lib/musicVideoDependencies.js';
import { productionReadiness } from './productionReview.js';
import { presentProjectCastAndSets } from './castAndSetsService.js';
import { presentProjectAutonomousRun } from './autonomousService.js';

import { withCatalogCheckin } from './catalogCheckin.js';
/**
 * What presentation reads off this machine for a record: a Blender film's shot renders on disk and
 * whether the track's audio was replaced under the timing (#14793). Neither depends on the shots.
 */
export async function readPresentationInputs(project) {
  let film = null;
  if (project?.composition?.mode === 'blender') {
    const { blenderFilmReadState } = await import('./blender/renderIndex.js');
    film = await blenderFilmReadState(project);
  }
  const { projectSongAudioChange } = await import('./songAudio.js');
  return { film, songAudioChange: await projectSongAudioChange(project) };
}

/** The presented record from a stored one (with its catalog check-in resolved) and its read inputs. */
export function presentProjectRecord(project, { film = null, songAudioChange = null } = {}) {
  const current = film ? { ...project, blenderShots: film.shots } : project;
  const dependencies = presentMusicVideoDependencies(current);
  // The final video is joined from shot renders the record does not hold, so its evidence cannot
  // see a shot that went out of date or was rendered again since: the film's own reading adds that.
  const presented = presentProjectAutonomousRun(presentProjectCastAndSets(film?.finalStale === true ? { ...dependencies, renderDependencyState: {
    status: 'stale', reasons: [...new Set([...(dependencies.renderDependencyState?.reasons || []), 'Blender shots changed or were rendered again after this final was joined'])],
  } } : dependencies));
  return { ...presented, productionReadiness: productionReadiness(presented), songAudioChange };
}

// Approvals decide stage completion and only the server computes them (#10136), so the read
// response carries `productionReadiness`: stages derive from one record, never "not done" while a
// second request is in flight. A restart archives a thumbnail paint without clearing `pending`;
// heal on read, and only when one is present, so a project list does not load the image stack.
// `catalogCheckinResolved`: the project came from getProject in this request, which already
// resolved its catalog check-in; resolving it again only repeats every linked catalog read (#16210).
export async function presentProjectForRead(project, { catalogCheckinResolved = false } = {}) {
  let current = project;
  if (project?.publishKit?.youtubeThumbnail?.pending) {
    const { reconcileInterruptedYoutubeThumbnail } = await import('./youtubeThumbnail.js');
    current = await reconcileInterruptedYoutubeThumbnail(project);
  }
  if (current?.castAndSets?.source === 'catalog' && !(catalogCheckinResolved && current.castAndSets.catalogCheckin)) {
    current = await withCatalogCheckin(current);
  }
  return presentProjectRecord(current, await readPresentationInputs(current));
}
