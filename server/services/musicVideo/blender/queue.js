/** Music Video compatibility boundary for the shared film engine. */
export * from '../../film/queue.js';
import * as film from '../../film/queue.js';
import { musicVideoFilmOwner } from './owner.js';
export const enqueueBlenderRenders = (id, ...args) => film.enqueueBlenderRenders(musicVideoFilmOwner(id), ...args);
export const cancelBlenderJob = (id, ...args) => film.cancelBlenderJob(musicVideoFilmOwner(id), ...args);
export const cancelBlenderProjectJobs = (id, ...args) => film.cancelBlenderProjectJobs(musicVideoFilmOwner(id), ...args);
export const resumePendingBlenderRenders = (ids, ...args) => film.resumePendingBlenderRenders(ids.map(musicVideoFilmOwner), ...args);
