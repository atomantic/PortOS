import { createContext, useContext } from 'react';
import * as musicVideoApi from '../../../services/apiMusicVideo.js';

export const FilmApiContext = createContext(musicVideoApi);
export const useFilmApi = () => useContext(FilmApiContext);
