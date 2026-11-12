/** Music Video compatibility boundary for the shared film engine. */
export * from '../../film/usage.js';
import * as film from '../../film/usage.js';
import { musicVideoFilmOwner } from './owner.js';
export const getBlenderDiskUsage = (id, ...args) => film.getBlenderDiskUsage(musicVideoFilmOwner(id), ...args);
export const clearBlenderFrames = (id, ...args) => film.clearBlenderFrames(musicVideoFilmOwner(id), ...args);
export const dropBlenderFramesOutside = (id, ...args) => film.dropBlenderFramesOutside(musicVideoFilmOwner(id), ...args);
