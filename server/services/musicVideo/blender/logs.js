/** Music Video compatibility boundary for the shared film engine. */
export * from '../../film/logs.js';
import * as film from '../../film/logs.js';
import { musicVideoFilmOwner } from './owner.js';
export const openBlenderJobLog = (id, ...args) => film.openBlenderJobLog(musicVideoFilmOwner(id), ...args);
