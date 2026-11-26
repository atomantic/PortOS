import * as film from '../../film/record.js';
import { musicVideoFilmOwner } from './owner.js';
export const announceBlenderState = (id, ...args) => film.announceBlenderState(musicVideoFilmOwner(id), ...args);
