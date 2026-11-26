import * as film from '../../film/state.js';
import { requireProject } from '../requireProject.js';
import { blenderFinalStale } from './renderIndex.js';
import { musicVideoFilmOwner } from './owner.js';
export async function getBlenderState(id) {
  const project = await requireProject(id);
  const state = await film.getBlenderState(musicVideoFilmOwner(id));
  return { ...state, finalStale: state.manifest ? blenderFinalStale(project, state.manifest.shots, state.renders) : null };
}
