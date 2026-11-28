/**
 * Music Video project workflows that reach past the project store: importing a
 * standalone film, cloning a project with its Blender film, refreshing the song
 * style from Suno, and listing completion for the catalog.
 *
 * They sit above projects.js and import it downward, so the store never loads
 * the film, Blender, Suno or presentation layers (server/lib/importScoping.test.js
 * SELECTION_CUTS).
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { normalizeBlenderRecord } from '../../lib/musicVideo/musicVideoBlender.js';
import { updateTrack } from '../tracks/index.js';
import { cloneProjectWith, createProjectWith, getProject, getStoredProjectRecord, getProjectSummariesByIds, listCompletionCandidateIds, updateProject } from './projects.js';

/** `{ id, name, isCompleted }` for complete projects, optionally only those casting `ingredientIds` or matching a name. */
export async function listProjectCompletion({ ingredientIds, matchesName } = {}) {
  const ids = await listCompletionCandidateIds(ingredientIds);
  if (!ids.length) return [];
  const [{ readProjectCompletion }, { createCatalogReads }] = await Promise.all([
    import('./projectPresentation.js'),
    import('./catalogCheckin.js'),
  ]);
  const reads = createCatalogReads();
  const states = [];
  const batchSize = 30;
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const records = await getProjectSummariesByIds(ids.slice(offset, offset + batchSize));
    const candidates = records.filter(project => project.status === 'complete' && (!matchesName || matchesName(project)));
    states.push(...await Promise.all(candidates.map(async (project) => ({
      id: project.id,
      name: project.name,
      isCompleted: await readProjectCompletion(project, { reads, requireCatalog: !!ingredientIds }),
    }))));
  }
  return states;
}

/** Import a standalone film into a fresh, unanalyzed project; never starts work. */
export async function createProjectFromFilm(input, sourceOwner, settings) {
  const [{ copyBlenderFilm, removeBlenderFilmCopy }, { musicVideoFilmOwner, writeBlenderSong }, { readBlenderManifest, writeBlenderManifest }] = await Promise.all([
    import('../film/fork.js'), import('./blender/owner.js'), import('../film/manifest.js'),
  ]);
  let target = null;
  return createProjectWith(input, {
    prepare: async ({ id }) => {
      target = musicVideoFilmOwner(id);
      const [{ lstat }, { join }] = await Promise.all([import('node:fs/promises'), import('node:path')]);
      const copied = await copyBlenderFilm(sourceOwner, target);
      if (!copied || !(await lstat(join(target.workspaceDir, 'src', 'film.py')).catch(() => null))?.isFile()) {
        throw new ServerError('Create the film workspace before sending it to Music Video', { status: 409, code: 'MUSIC_VIDEO_BLENDER_NO_FILM' });
      }
      const manifest = await readBlenderManifest(target);
      // Keep the authored shot/options inventory, but its timing has never been synced to this song.
      if (manifest) await writeBlenderManifest(target, { ...manifest, syncedAt: null });
      return { blender: { settings }, sourceFilm: { kind: sourceOwner.kind, projectId: sourceOwner.id } };
    },
    finish: (project) => writeBlenderSong(project, normalizeBlenderRecord(project.blender).settings),
    rollback: () => (target ? removeBlenderFilmCopy(target) : null),
  });
}

// A Blender film's scripts live in the source's workspace. A new version gets its own copy,
// placed under the id it is about to take, so the record never exists without its film.
// Resolves null when the source has no film to copy (the clone then keeps only its settings).
async function forkBlenderFilm(sourceId) {
  const source = await getStoredProjectRecord(sourceId);
  if (!source?.blender || source.deleted) return null;
  const { copyBlenderFilm, removeBlenderFilmCopy } = await import('./blender/fork.js');
  const id = `mv-${randomUUID()}`;
  if (!(await copyBlenderFilm(sourceId, id))) return null;
  return { id, discard: () => removeBlenderFilmCopy(id) };
}

/** A new version of a project; a Blender film comes with it unless the clone is a footage adaptation. */
export async function cloneProject(id, options = {}) {
  const cloneOptions = { ...options };
  delete cloneOptions.id;
  delete cloneOptions.blenderFilm;
  // A footage adaptation leaves the film behind: its shots become footage.
  const film = cloneOptions.variant === 'video-generation' ? null : await forkBlenderFilm(id);
  const writeSong = film ? (await import('./blender/owner.js')).writeBlenderSong : null;
  return cloneProjectWith(id, { ...cloneOptions, id: film?.id ?? `mv-${randomUUID()}`, blenderFilm: Boolean(film) }, {
    // The copied song.json names the source project; publish the fork only after its own is written.
    finish: writeSong ? (project) => writeSong(project, normalizeBlenderRecord(project.blender).settings) : null,
    rollback: () => film?.discard(),
  });
}

/**
 * Re-read the song's style from its Suno link, excluded styles included, for a
 * song imported before they were captured. Sets the project's song style and
 * the linked track's style prompt, so later projects on the track get it too.
 */
export async function refreshSongStyleFromSuno(id, url) {
  const project = await getProject(id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const { readSunoSongStyle } = await import('../trackSunoImport.js');
  const { style, excludedStylesKnown } = await readSunoSongStyle(url);
  if (project.trackId) await updateTrack(project.trackId, { prompt: style });
  const updated = await updateProject(id, { concept: { songStyle: style.slice(0, 2000) } });
  return { project: updated, excludedStylesKnown };
}
