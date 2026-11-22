/**
 * The read presentation of a Music Video project: what `GET /:id` adds to the stored record
 * (take staleness, cast-and-sets and run pins, readiness, song-audio drift, a Blender film's state).
 *
 * Split into the reads it needs (`readPresentationInputs`) and a pure step (`presentProjectRecord`)
 * so an edit can present its before and after records from one set of reads (editResult.js).
 */

import { musicVideoRenderDependencyState, presentMusicVideoDependencies } from '../../lib/musicVideo/musicVideoDependencies.js';
import { productionReadiness } from './productionReview.js';
import { presentProjectCastAndSets } from './castAndSetsService.js';
import { presentProjectAutonomousRun } from './autonomousService.js';

import { withCatalogCheckin } from './catalogCheckin.js';
import { musicVideoCompletionOverride } from '../../lib/musicVideo/musicVideoCompletion.js';

/** Classify only final render evidence, without projecting historical takes or reading unrelated ledgers. */
export async function readProjectCompletion(project, { reads, requireCatalog = false } = {}) {
  const marked = musicVideoCompletionOverride(project);
  if (marked !== null) return marked;
  const usesCatalog = project.castAndSets?.source === 'catalog'
    && Array.isArray(project.renderDependencies?.references)
    && project.renderDependencies.references.some(({ role }) => role === 'clipReferences');
  const current = usesCatalog ? await withCatalogCheckin(project, { reads }) : project;
  if (requireCatalog && current.castAndSets?.catalogCheckin?.problems?.some(({ code }) => code === 'CATALOG_UNAVAILABLE')) {
    const err = new Error('Catalog references are unavailable. Try again.');
    err.status = 503;
    throw err;
  }
  if (musicVideoRenderDependencyState(current)?.status === 'stale') return false;
  if (project.composition?.mode === 'blender') {
    const { blenderFilmReadState } = await import('./blender/renderIndex.js');
    if ((await blenderFilmReadState(project)).finalStale === true) return false;
  }
  return true;
}
/**
 * What presentation reads off this machine for a record: a Blender film's shot renders on disk,
 * whether the track's audio was replaced under the timing (#14793), and this install's render
 * spend ledger for the project (#16506). None depends on the shots' presentation.
 */
export async function readPresentationInputs(project) {
  let film = null;
  if (project?.composition?.mode === 'blender') {
    const { blenderFilmReadState } = await import('./blender/renderIndex.js');
    film = await blenderFilmReadState(project);
  }
  const [{ projectSongAudioChange }, { readProjectRenderSpend }] = await Promise.all([import('./songAudio.js'), import('./renderSpend.js')]);
  const [songAudioChange, renderSpend] = await Promise.all([projectSongAudioChange(project), readProjectRenderSpend(project)]);
  return { film, songAudioChange, renderSpend };
}

/** The presented record from a stored one (with its catalog check-in resolved) and its read inputs. */
export function presentProjectRecord(project, { film = null, songAudioChange = null, renderSpend = null } = {}) {
  const current = film ? { ...project, blenderShots: film.shots } : project;
  const dependencies = presentMusicVideoDependencies(current);
  // The final video is joined from shot renders the record does not hold, so its evidence cannot
  // see a shot that went out of date or was rendered again since: the film's own reading adds that.
  const presented = presentProjectAutonomousRun(presentProjectCastAndSets(film?.finalStale === true ? { ...dependencies, renderDependencyState: {
    status: 'stale', reasons: [...new Set([...(dependencies.renderDependencyState?.reasons || []), 'Blender shots changed or were rendered again after this final was joined'])],
  } } : dependencies));
  // `renderSpend` is read-time like `blenderShots`: machine-local, never stored or synced.
  return { ...presented, productionReadiness: productionReadiness(presented), songAudioChange, ...(renderSpend ? { renderSpend } : {}) };
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
