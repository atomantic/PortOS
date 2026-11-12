/** Music Video compatibility boundary for the shared film engine. */
export * from '../../film/driver.js';
import * as film from '../../film/driver.js';
import { musicVideoFilmOwner } from './owner.js';
export const blenderJobBase = (id, ...args) => film.blenderJobBase(musicVideoFilmOwner(id), ...args);
