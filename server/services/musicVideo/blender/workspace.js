/** Music Video compatibility boundary for the shared film engine. */
export * from '../../film/workspace.js';
import * as film from '../../film/workspace.js';
import { musicVideoFilmOwner } from './owner.js';
export const blenderWorkspaceDir = (id, ...args) => film.blenderWorkspaceDir(musicVideoFilmOwner(id), ...args);
export const blenderWorkspaceLabel = (id, ...args) => film.blenderWorkspaceLabel(musicVideoFilmOwner(id), ...args);
export const blenderSrcDir = (id, ...args) => film.blenderSrcDir(musicVideoFilmOwner(id), ...args);
export const blenderRendersDir = (id, ...args) => film.blenderRendersDir(musicVideoFilmOwner(id), ...args);
export const blenderManifestFile = (id, ...args) => film.blenderManifestFile(musicVideoFilmOwner(id), ...args);
export const blenderSongFile = (id, ...args) => film.blenderSongFile(musicVideoFilmOwner(id), ...args);
export const blenderShotDir = (id, ...args) => film.blenderShotDir(musicVideoFilmOwner(id), ...args);
export const blenderScratchDir = (id, ...args) => film.blenderScratchDir(musicVideoFilmOwner(id), ...args);
export const blenderMediaPath = (id, ...args) => film.blenderMediaPath(musicVideoFilmOwner(id), ...args);
export const resolveBlenderSourceFile = (id, ...args) => film.resolveBlenderSourceFile(musicVideoFilmOwner(id), ...args);
export const resolveBlenderMedia = (id, ...args) => film.resolveBlenderMedia(musicVideoFilmOwner(id), ...args);
