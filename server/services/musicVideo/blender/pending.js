/** Music Video compatibility boundary for the shared film engine. */
export * from '../../film/pending.js';
import * as film from '../../film/pending.js';
import { musicVideoFilmOwner } from './owner.js';
export const readPendingBlenderRenders = (id, ...args) => film.readPendingBlenderRenders(musicVideoFilmOwner(id), ...args);
export const writePendingBlenderRenders = (id, ...args) => film.writePendingBlenderRenders(musicVideoFilmOwner(id), ...args);
export const removePendingBlenderShots = (id, ...args) => film.removePendingBlenderShots(musicVideoFilmOwner(id), ...args);
