/** Music Video compatibility boundary for the shared film engine. */
export * from '../../film/manifest.js';
import * as film from '../../film/manifest.js';
import { musicVideoFilmOwner } from './owner.js';
export const readBlenderManifest = (id, ...args) => film.readBlenderManifest(musicVideoFilmOwner(id), ...args);
export const writeBlenderManifest = (id, ...args) => film.writeBlenderManifest(musicVideoFilmOwner(id), ...args);
