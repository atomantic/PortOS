/** Music Video compatibility boundary for the shared film engine. */
export * from '../../film/sources.js';
import * as film from '../../film/sources.js';
import { musicVideoFilmOwner } from './owner.js';
export const walkBlenderSources = (id, ...args) => film.walkBlenderSources(musicVideoFilmOwner(id), ...args);
export const listBlenderFiles = (id, ...args) => film.listBlenderFiles(musicVideoFilmOwner(id), ...args);
export const readBlenderFile = (id, ...args) => film.readBlenderFile(musicVideoFilmOwner(id), ...args);
export const writeBlenderFile = (id, ...args) => film.writeBlenderFile(musicVideoFilmOwner(id), ...args);
export const deleteBlenderFile = (id, ...args) => film.deleteBlenderFile(musicVideoFilmOwner(id), ...args);
export const scaffoldBlenderWorkspace = (id, ...args) => film.scaffoldBlenderWorkspace(musicVideoFilmOwner(id), ...args);
