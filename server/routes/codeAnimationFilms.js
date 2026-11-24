/** Standalone films in Code Animation Production. */
import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { createFilmSchema, patchFilmSchema, filmAudioSchema, promoteFilmSchema, createShowcaseFilmSchema } from '../lib/codeAnimationFilms.js';
import { createFilmRoutes } from './filmRoutes.js';
import { attachFilmAudio, codeAnimationFilmOwner, createFilmProject, patchFilmProject, getFilmState } from '../services/codeAnimation/films.js';

const router = Router();
// Declared before '/:id' routes: starts no job; the client opens the film it returns.
router.post('/showcase', asyncHandler(async (req, res) => {
  const { modelId, title } = validateRequest(createShowcaseFilmSchema, req.body ?? {});
  const { createShowcaseFilm } = await import('../services/codeAnimation/showcase.js');
  res.status(201).json(await createShowcaseFilm(modelId, { title }));
}));
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
