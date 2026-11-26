/** Resolves scratch space for Music Video film renders. */
import * as film from '../../film/workspace.js';
import { musicVideoFilmOwner } from './owner.js';
export const blenderScratchDir = (id, ...args) => film.blenderScratchDir(musicVideoFilmOwner(id), ...args);
