/** Music Video compatibility boundary for the shared film engine. */
export * from '../../film/jobs.js';
import * as film from '../../film/jobs.js';
import { musicVideoFilmOwner } from './owner.js';
export const createBlenderJob = (id, ...args) => film.createBlenderJob(musicVideoFilmOwner(id), ...args);
export const blenderJobEntry = (id, ...args) => film.blenderJobEntry(musicVideoFilmOwner(id), ...args);
export const activeBlenderJobs = (id, ...args) => film.activeBlenderJobs(musicVideoFilmOwner(id), ...args);
export const hasBlenderSync = (id, ...args) => film.hasBlenderSync(musicVideoFilmOwner(id), ...args);
export const reserveBlenderSync = (id, ...args) => film.reserveBlenderSync(musicVideoFilmOwner(id), ...args);
export const listBlenderJobs = (id, ...args) => film.listBlenderJobs(musicVideoFilmOwner(id), ...args);
