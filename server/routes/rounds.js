/**
 * Rounds API
 *
 *   GET    /api/rounds        → { rounds }
 *   GET    /api/rounds/:id    → { round }
 *   POST   /api/rounds        → { round }   (body: roundInputSchema)
 *   PATCH  /api/rounds/:id    → { round }   (body: roundInputSchema.partial())
 *   DELETE /api/rounds/:id    → { id }
 *
 * The a cappella round workbench: write/arrange rounds and track which voice
 * layers you're learning. Bounds come from services/rounds.js so the Zod schema
 * here and the service-layer sanitizer agree by construction (the dashboard-
 * layouts pattern).
 */

import {
  roundInputSchema,
  generateSchema,
  evaluateSchema,
  derivePartsSchema,
  referenceAudioImportSchema,
  transcribeMidiSchema,
} from '../lib/roundsRouteValidation.js';
import { Router } from 'express';
import { assertCancelResult } from '../lib/cancelResponse.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { isPaginationRequested, paginateArray, paginationQuerySchema } from '../lib/queryValidation.js';
import * as svc from '../services/rounds.js';
import { generateRound, evaluateRound, deriveRoundParts } from '../services/roundsAI.js';
import {
  startReferenceAudioImport,
  attachReferenceAudioSseClient,
  cancelReferenceAudioImport,
} from '../services/roundReferenceAudioImport.js';
import { startMidiTranscription, attachMidiTranscriptionSseClient, cancelMidiTranscription } from '../services/audioMidiTranscription.js';
import { PATHS } from '../lib/fileUtils.js';
import { safeUnder } from '../lib/ffmpeg.js';

const router = Router();

// Map a service error (carries a `code`) to the right HTTP status. Without
// this, asyncHandler defaults everything to 500.
const mapRoundError = (err) => {
  if (err?.code === svc.ERR_NOT_FOUND) return new ServerError(err.message, { status: 404, code: err.code });
  if (err?.code === svc.ERR_NOT_BUILTIN) return new ServerError(err.message, { status: 400, code: err.code });
  return err;
};
const rethrowRoundError = (err) => { throw mapRoundError(err); };

router.get('/', asyncHandler(async (req, res) => {
  const query = validateRequest(paginationQuerySchema, req.query);
  const rounds = await svc.listRounds();
  res.json(isPaginationRequested(query) ? paginateArray(rounds, query, { maxLimit: 500 }) : { rounds });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const round = await svc.getRound(req.params.id);
  if (!round) throw new ServerError('Round not found', { status: 404, code: svc.ERR_NOT_FOUND });
  res.json({ round });
}));

router.post('/reference-audio/import', asyncHandler(async (req, res) => {
  const { url, roundId, referenceId } = validateRequest(referenceAudioImportSchema, req.body || {});
  res.status(202).json(await startReferenceAudioImport(url, { roundId, referenceId }));
}));

router.get('/reference-audio/import/:jobId/events', (req, res) => {
  if (!attachReferenceAudioSseClient(req.params.jobId, res)) {
    throw new ServerError('Import job not found or expired', { status: 404, code: 'NOT_FOUND' });
  }
});

router.post('/reference-audio/import/:jobId/cancel', (req, res) => {
  res.json(assertCancelResult(cancelReferenceAudioImport(req.params.jobId), { notFoundMessage: 'Reference audio import not found' }));
});

router.post('/reference-audio/transcribe-midi', asyncHandler(async (req, res) => {
  const { filename, model } = validateRequest(transcribeMidiSchema, req.body || {});
  // The filename is a stored uploads basename — validate it can't escape the
  // uploads dir (same posture as musicVideo's resolveAudioPath).
  const audioPath = safeUnder(PATHS.uploads, filename);
  if (!audioPath) throw new ServerError('Invalid audio filename', { status: 400, code: 'VALIDATION_ERROR' });
  const outputName = filename.replace(/\.[^.]+$/, '') || 'reference';
  res.status(202).json(await startMidiTranscription({ audioPath, outputName, model }));
}));

router.get('/reference-audio/transcribe-midi/:jobId/events', (req, res) => {
  if (!attachMidiTranscriptionSseClient(req.params.jobId, res)) {
    throw new ServerError('Transcription job not found or expired', { status: 404, code: 'NOT_FOUND' });
  }
});

router.post('/reference-audio/transcribe-midi/:jobId/cancel', (req, res) => {
  res.json(assertCancelResult(cancelMidiTranscription(req.params.jobId), { notFoundMessage: 'MIDI transcription job not found' }));
});

router.post('/', asyncHandler(async (req, res) => {
  const input = validateRequest(roundInputSchema, req.body || {});
  const round = await svc.createRound(input).catch(rethrowRoundError);
  res.json({ round });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const patch = validateRequest(roundInputSchema.partial(), req.body || {});
  const round = await svc.updateRound(req.params.id, patch).catch(rethrowRoundError);
  res.json({ round });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await svc.deleteRound(req.params.id).catch(rethrowRoundError);
  res.json(result);
}));

// POST /api/rounds/:id/refresh-template → reset a built-in default round's shipped
// content (metadata/lyrics/layers/notation) to the current bundled template,
// preserving the user's own recordings + learned progress. 400 if not built-in.
router.post('/:id/refresh-template', asyncHandler(async (req, res) => {
  const round = await svc.refreshRoundFromTemplate(req.params.id).catch(rethrowRoundError);
  res.json({ round });
}));

// --- AI generate / evaluate -------------------------------------------------
// POST /api/rounds/generate → draft a brand-new arrangement from a brief. Does
// NOT persist — returns { round: <fields>, llm } the client merges/creates from.
// (Routed before /:id/* so a literal `/generate` can't be read as an id.)
router.post('/generate', asyncHandler(async (req, res) => {
  const body = validateRequest(generateSchema, req.body || {});
  const result = await generateRound(body);
  res.json(result);
}));

// POST /api/rounds/:id/generate → expand the stored round (when expandExisting)
// or draft fresh using its title/artist as the brief. Returns { round, llm };
// the client merges into the editor draft (does not auto-save).
router.post('/:id/generate', asyncHandler(async (req, res) => {
  const body = validateRequest(generateSchema, req.body || {});
  const existing = await svc.getRound(req.params.id);
  if (!existing) throw new ServerError('Round not found', { status: 404, code: svc.ERR_NOT_FOUND });
  const result = await generateRound({
    title: body.title ?? existing.title,
    artist: body.artist ?? existing.artist,
    brief: body.brief,
    mood: body.mood,
    existingRound: body.expandExisting ? existing : undefined,
    providerId: body.providerId,
    model: body.model,
  });
  res.json(result);
}));

// POST /api/rounds/:id/evaluate → critique the stored arrangement. Read-only:
// returns { evaluation, llm } without mutating the round.
router.post('/:id/evaluate', asyncHandler(async (req, res) => {
  const body = validateRequest(evaluateSchema, req.body || {});
  const round = await svc.getRound(req.params.id);
  if (!round) throw new ServerError('Round not found', { status: 404, code: svc.ERR_NOT_FOUND });
  const result = await evaluateRound({ song: round, providerId: body.providerId, model: body.model });
  res.json(result);
}));

// POST /api/rounds/:id/derive-parts → derive harmony parts (bass, mid/high
// harmonies) from the round's base melody. Returns { scoreParts, llm }; the
// client merges the parts into the editor draft (does NOT auto-save), matching
// the generate/expand flow. 400 if the round has no base score to derive from.
router.post('/:id/derive-parts', asyncHandler(async (req, res) => {
  const body = validateRequest(derivePartsSchema, req.body || {});
  const round = await svc.getRound(req.params.id);
  if (!round) throw new ServerError('Round not found', { status: 404, code: svc.ERR_NOT_FOUND });
  const result = await deriveRoundParts({
    song: round, partIds: body.partIds, providerId: body.providerId, model: body.model,
  });
  res.json(result);
}));

export default router;
