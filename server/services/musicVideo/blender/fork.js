import * as film from '../../film/fork.js';
import { musicVideoFilmOwner } from './owner.js';
export const copyBlenderFilm = (sourceId, targetId) => film.copyBlenderFilm(musicVideoFilmOwner(sourceId), musicVideoFilmOwner(targetId));
export const removeBlenderFilmCopy = (id) => film.removeBlenderFilmCopy(musicVideoFilmOwner(id));
