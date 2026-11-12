export * from '../../film/film.js';
import { readBlenderFilm as readFilm } from '../../film/film.js';
import { musicVideoFilmOwner } from './owner.js';
export const readBlenderFilm = (project) => readFilm(musicVideoFilmOwner(project.id));
