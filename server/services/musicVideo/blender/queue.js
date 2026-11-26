/** Resumes pending renders for Music Video project owners. */
import * as film from '../../film/queue.js';
import { musicVideoFilmOwner } from './owner.js';
export const resumePendingBlenderRenders = (ids, ...args) => film.resumePendingBlenderRenders(ids.map(musicVideoFilmOwner), ...args);
