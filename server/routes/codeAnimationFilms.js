/** Standalone films in Code Animation Production. */
import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { createFilmSchema, patchFilmSchema, filmAudioSchema, promoteFilmSchema } from '../lib/codeAnimationFilms.js';
import { createFilmRoutes } from './filmRoutes.js';
import { attachFilmAudio, codeAnimationFilmOwner, createFilmProject, patchFilmProject, getFilmState } from '../services/codeAnimation/films.js';

const router = Router();
router.post('/', asyncHandler(async (req, res) => {
  res.status(201).json(await createFilmProject(validateRequest(createFilmSchema, req.body ?? {})));
}));
router.patch('/:id', asyncHandler(async (req, res) => {
  res.json(await patchFilmProject(req.params.id, validateRequest(patchFilmSchema, req.body ?? {})));
}));
router.post('/:id/audio', asyncHandler(async (req, res) => {
  res.json(await attachFilmAudio(req.params.id, validateRequest(filmAudioSchema, req.body ?? {})));
}));
router.post('/:id/promote', asyncHandler(async (req, res) => {
  const { promoteFilm } = await import('../services/codeAnimation/promoteFilm.js');
  res.status(201).json(await promoteFilm(req.params.id, validateRequest(promoteFilmSchema, req.body ?? {})));
}));
const filmRouter = createFilmRoutes({
  resolveOwner: codeAnimationFilmOwner,
  readState: getFilmState,
  async startCut(owner, input) {
    const { startFilmCut } = await import('../services/codeAnimation/filmCut.js');
    return startFilmCut(owner, input);
  },
});
router.use(filmRouter);
export default router;
