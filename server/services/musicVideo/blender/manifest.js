/** Reads a Music Video project’s film manifest. */
import * as film from '../../film/manifest.js';
import { musicVideoFilmOwner } from './owner.js';
export const readBlenderManifest = (id, ...args) => film.readBlenderManifest(musicVideoFilmOwner(id), ...args);
