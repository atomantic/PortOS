/** Music Video compatibility boundary for the shared film engine. */
export * from '../../film/open.js';
import * as film from '../../film/open.js';
import { musicVideoFilmOwner } from './owner.js';
export const openBlenderShot = (id, ...args) => film.openBlenderShot(musicVideoFilmOwner(id), ...args);
