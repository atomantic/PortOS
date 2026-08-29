import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { getAccelerandoBook } from '../services/rapidReader.js';
import { validateRequest, rapidReaderLibraryParamsSchema, rapidReaderLibraryCreateSchema, rapidReaderLibraryFetchSchema } from '../lib/validation.js';
import { listRapidReaderLibrary, getRapidReaderLibraryEntry, createPastedRapidReaderEntry, fetchRapidReaderEntry, deleteRapidReaderLibraryEntry } from '../services/rapidReaderLibrary.js';

const router = Router();

router.get('/accelerando', asyncHandler(async (_req, res) => {
  const book = await getAccelerandoBook();
  res.set('Cache-Control', 'private, no-store');
  res.json(book);
}));
router.get('/library', asyncHandler(async (_req, res) => res.json(await listRapidReaderLibrary())));
router.post('/library', asyncHandler(async (req, res) => res.status(201).json(await createPastedRapidReaderEntry(validateRequest(rapidReaderLibraryCreateSchema, req.body)))));
router.post('/library/fetch', asyncHandler(async (req, res) => res.status(201).json(await fetchRapidReaderEntry(validateRequest(rapidReaderLibraryFetchSchema, req.body)))));
router.get('/library/:id', asyncHandler(async (req, res) => res.json(await getRapidReaderLibraryEntry(validateRequest(rapidReaderLibraryParamsSchema, req.params).id))));
router.delete('/library/:id', asyncHandler(async (req, res) => { await deleteRapidReaderLibraryEntry(validateRequest(rapidReaderLibraryParamsSchema, req.params).id); res.status(204).end(); }));

export default router;
