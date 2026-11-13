import * as film from '../../film/sync.js';
import { musicVideoFilmOwner } from './owner.js';
export const startBlenderSync = (id, ...args) => film.startBlenderSync(musicVideoFilmOwner(id), ...args);
