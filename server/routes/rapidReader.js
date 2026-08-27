import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { getAccelerandoBook } from '../services/rapidReader.js';

const router = Router();

router.get('/accelerando', asyncHandler(async (_req, res) => {
  const book = await getAccelerandoBook();
  res.set('Cache-Control', 'private, no-store');
  res.json(book);
}));

export default router;
