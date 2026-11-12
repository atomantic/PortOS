/** Music Video compatibility boundary for the shared film engine. */
export * from '../../film/hashing.js';
import * as film from '../../film/hashing.js';
import { musicVideoFilmOwner } from './owner.js';
export const hashBlenderSources = (id, ...args) => film.hashBlenderSources(musicVideoFilmOwner(id), ...args);
