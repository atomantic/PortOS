import { createContext, useContext } from 'react';
import { musicVideoFilmApi } from '../../../services/apiMusicVideo.js';

export const FilmApiContext = createContext(musicVideoFilmApi);
export const useFilmApi = () => useContext(FilmApiContext);
