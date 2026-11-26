import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { filmStyleParamsSchema } from '../lib/filmStyleGrammarValidation.js';
import {
  FILM_STYLE_GRAMMARS, getFilmStyleGrammar, summarizeFilmStyleGrammar,
} from '../lib/filmStyleGrammars.js';

// Read-only film style grammar catalog (#10252). The list is the picker
// projection; `/:id` returns the full record; `/:id/prompt` previews the
// rendered prompt section an authoring stage would receive.
const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(FILM_STYLE_GRAMMARS.map(summarizeFilmStyleGrammar));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(filmStyleParamsSchema, req.params);
  const grammar = getFilmStyleGrammar(id);
  if (!grammar) throw new ServerError('Film style grammar not found', { status: 404, code: 'NOT_FOUND' });
  res.json(grammar);
}));

export default router;
