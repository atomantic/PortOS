import { requireProject } from '../requireProject.js';
import * as film from '../../film/record.js';
import { musicVideoFilmOwner } from './owner.js';
export const announceBlenderState = (id, ...args) => film.announceBlenderState(musicVideoFilmOwner(id), ...args);
export async function saveBlenderSettings(id, ...args) {
  await film.saveBlenderSettings(musicVideoFilmOwner(id), ...args);
  return requireProject(id);
}
export async function saveBlenderShotNote(id, ...args) {
  await film.saveBlenderShotNote(musicVideoFilmOwner(id), ...args);
  return requireProject(id);
}
