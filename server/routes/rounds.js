/**
 * Rounds API
 *
 *   GET    /api/rounds        → { rounds }
 *   GET    /api/rounds/:id    → { round }
 *   POST   /api/rounds        → { round }   (body: roundInputSchema)
 *   PUT    /api/rounds/:id    → { round }   (body: roundInputSchema.partial())
 *   DELETE /api/rounds/:id    → { id }
 *
 * The a cappella round workbench: write/arrange rounds and track which voice
 * layers you're learning. Bounds come from services/rounds.js so the Zod schema
 * here and the service-layer sanitizer agree by construction (the dashboard-
 * layouts pattern).
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as svc from '../services/rounds.js';
import { generateRound, evaluateRound, deriveRoundParts } from '../services/roundsAI.js';

const router = Router();

// Trim then cap, allowing empty (the client clears a field by sending '').
const str = (max) => z.string().trim().max(max);

const sectionSchema = z.object({
  id: str(svc.ID_MAX_LENGTH).optional(),
  label: str(svc.LABEL_MAX_LENGTH).optional().default(''),
  lyrics: str(svc.FIELD_MAX_LENGTH).optional().default(''),
});

const layerSchema = z.object({
  id: str(svc.ID_MAX_LENGTH).optional(),
  label: str(svc.LABEL_MAX_LENGTH).optional().default(''),
  part: str(svc.PART_MAX_LENGTH).optional().default(''),
  notes: str(svc.FIELD_MAX_LENGTH).optional().default(''),
});

// One downsampled tuner sample from a take's pitch trace (#1027). hz/cents/
// clarity are nullable so a silent frame round-trips; the service clamps tMs.
const pitchSampleSchema = z.object({
  tMs: z.number().optional(),
  hz: z.number().nullable().optional(),
  cents: z.number().nullable().optional(),
  clarity: z.number().nullable().optional(),
});

// Per-take color-match accuracy summary (#1027), mirroring colorMatch's
// summarizeAccuracy output. All fields optional/absent-tolerant; the service
// clamps the percentage and drops unrecognized grades.
const accuracySchema = z.object({
  percentInTune: z.number().optional(),
  graded: z.number().optional(),
  counts: z.object({
    'in-tune': z.number().optional(),
    close: z.number().optional(),
    off: z.number().optional(),
    missed: z.number().optional(),
  }).optional(),
  perNote: z.array(z.string()).max(svc.PER_NOTE_GRADES_MAX).optional(),
});

// A saved vocal take. `filename` is the /api/uploads file the audio is served
// from (the client uploads the WAV first, then PUTs the round with the returned
// filename). Numbers are accepted for the mixer; the service clamps them.
// `pitchTrack`/`accuracy` are optional per-take pitch analysis (#1027) — absent
// on legacy/unscored takes, persisted so the tuner history isn't recomputed.
const recordingSchema = z.object({
  id: str(svc.ID_MAX_LENGTH).optional(),
  layerId: str(svc.ID_MAX_LENGTH).optional().default(''),
  label: str(svc.LABEL_MAX_LENGTH).optional().default(''),
  filename: str(svc.URL_MAX_LENGTH),
  durationMs: z.number().nonnegative().optional(),
  peak: z.number().min(0).max(1).optional(),
  muted: z.boolean().optional(),
  createdAt: z.string().optional(),
  pitchTrack: z.array(pitchSampleSchema).max(svc.PITCH_TRACK_MAX).optional(),
  accuracy: accuracySchema.optional(),
});

// One training attempt — a graded take of one scope (#1028). The service clamps
// the percent and drops zero-note attempts; the schema only types the fields.
const attemptSchema = z.object({
  percentInTune: z.number().optional(),
  graded: z.number().optional(),
  at: z.string().optional(),
});

// Training progress (#1028): `{ history: { <scope>: [attempt…] } }`. A record
// of the scope → recent graded attempts; the service bounds both the per-scope
// history and the number of scopes, and recomputes derived stats client-side.
// `.passthrough()` is NOT used — only `history` is meaningful, and the service
// re-sanitizes regardless, but typing it keeps the contract explicit.
const progressSchema = z.object({
  history: z.record(z.string(), z.array(attemptSchema).max(svc.PROGRESS_HISTORY_MAX)).optional(),
}).optional();

// A sheet-music part — a harmony variation of the base score, in the same
// lead-sheet DSL. `score` is required (a part without notation is meaningless);
// `role` is a HARMONY_PARTS id when known but free-text-safe.
const scorePartSchema = z.object({
  id: str(svc.ID_MAX_LENGTH).optional(),
  label: str(svc.LABEL_MAX_LENGTH).optional().default(''),
  role: str(svc.ID_MAX_LENGTH).optional().default(''),
  score: str(svc.SCORE_MAX_LENGTH),
});

// One labeled time range on a reference's attached audio (#2106). The service
// clamps times and drops zero/negative-length spans; the schema only types the
// fields (startMs/endMs required — a span without both selects nothing).
const refSegmentSchema = z.object({
  layerId: str(svc.ID_MAX_LENGTH).optional().default(''),
  startMs: z.number(),
  endMs: z.number(),
});

// A reference link/video (e.g. a TikTok performance). `url` is required; the
// client renders TikTok urls as embeds and everything else as a link.
// `audioFilename`/`segments` are the optional reference-audio analysis fields
// (#2106) — absent on legacy references; the service omits empty values so
// pre-feature records round-trip unchanged.
const referenceSchema = z.object({
  id: str(svc.ID_MAX_LENGTH).optional(),
  url: str(svc.URL_MAX_LENGTH),
  label: str(svc.LABEL_MAX_LENGTH).optional().default(''),
  note: str(svc.FIELD_MAX_LENGTH).optional().default(''),
  audioFilename: str(svc.URL_MAX_LENGTH).optional(),
  segments: z.array(refSegmentSchema).max(svc.REF_SEGMENTS_MAX).optional(),
});

// No `.default('')` on these fields: `.partial()` (used for PUT) materializes a
// default for an *omitted* key, which would turn a single-field PUT into a
// wipe of every other field via updateRound's `'key' in patch` merge. Leaving
// them plain-optional keeps omitted keys absent (preserve) vs present-empty
// (clear); the service's `trimField` coerces a present `undefined`/'' anyway.
const roundInputSchema = z.object({
  title: str(svc.TITLE_MAX_LENGTH).optional(),
  artist: str(svc.ARTIST_MAX_LENGTH).optional(),
  key: str(svc.KEY_MAX_LENGTH).optional(),
  // null clears the tempo; a number is clamped server-side into the band.
  tempo: z.number().int().min(svc.TEMPO_MIN).max(svc.TEMPO_MAX).nullable().optional(),
  rhythmShapeId: str(svc.ID_MAX_LENGTH).optional(),
  notation: str(svc.FIELD_MAX_LENGTH).optional(),
  // Sheet-music notation (PortOS lead-sheet DSL) — bounded free text; the client
  // parses/renders it. Longer cap than `notation` since a full score is verbose.
  score: str(svc.SCORE_MAX_LENGTH).optional(),
  // Harmony variations of the base score (bass, mid/high harmonies). The service
  // drops parts with no notation and defaults the label; the schema bounds the list.
  scoreParts: z.array(scorePartSchema).max(svc.SCORE_PARTS_MAX).optional(),
  notes: str(svc.FIELD_MAX_LENGTH).optional(),
  learned: z.boolean().optional(),
  // Training progress (#1028) — per-scope rolling accuracy history. Optional and
  // absent-tolerant: a legacy/untrained round omits it; the service bounds + clamps.
  progress: progressSchema,
  sections: z.array(sectionSchema).max(svc.SECTIONS_MAX).optional(),
  layers: z.array(layerSchema).max(svc.LAYERS_MAX).optional(),
  recordings: z.array(recordingSchema).max(svc.RECORDINGS_MAX).optional(),
  references: z.array(referenceSchema).max(svc.REFERENCES_MAX).optional(),
  // Ids of other rounds sung together with this one (round-stack partners). The
  // service dedupes and drops self-references; the schema only bounds the list.
  partnerRoundIds: z.array(str(svc.ID_MAX_LENGTH)).max(svc.PARTNERS_MAX).optional(),
});

// AI generate/evaluate inputs. providerId/model are optional overrides; the
// service falls back to the active provider. Empty-string providerId (a UI
// "use default" sentinel) is coerced to undefined so it doesn't pin a bogus id.
const optProvider = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());
const generateSchema = z.object({
  title: str(svc.TITLE_MAX_LENGTH).optional(),
  artist: str(svc.ARTIST_MAX_LENGTH).optional(),
  brief: str(svc.FIELD_MAX_LENGTH).optional(),
  mood: str(svc.FIELD_MAX_LENGTH).optional(),
  // When true, the target round (route :id) is folded into the prompt so
  // "generate" expands the existing draft instead of starting blank.
  expandExisting: z.boolean().optional(),
  providerId: optProvider,
  model: optProvider,
});
const evaluateSchema = z.object({
  providerId: optProvider,
  model: optProvider,
});
// Derive harmony parts from the round's base score. `partIds` optionally restricts
// which harmony parts to generate (a HARMONY_PARTS id list); the service defaults
// to the full derivable set and only ever derives harmony (never the melody).
const derivePartsSchema = z.object({
  partIds: z.array(str(svc.ID_MAX_LENGTH)).max(svc.SCORE_PARTS_MAX).optional(),
  providerId: optProvider,
  model: optProvider,
});

// Map a service error (carries a `code`) to the right HTTP status. Without
// this, asyncHandler defaults everything to 500.
const mapRoundError = (err) => {
  if (err?.code === svc.ERR_NOT_FOUND) return new ServerError(err.message, { status: 404, code: err.code });
  if (err?.code === svc.ERR_NOT_BUILTIN) return new ServerError(err.message, { status: 400, code: err.code });
  return err;
};
const rethrowRoundError = (err) => { throw mapRoundError(err); };

router.get('/', asyncHandler(async (req, res) => {
  const rounds = await svc.listRounds();
  res.json({ rounds });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const round = await svc.getRound(req.params.id);
  if (!round) throw new ServerError('Round not found', { status: 404, code: svc.ERR_NOT_FOUND });
  res.json({ round });
}));

router.post('/', asyncHandler(async (req, res) => {
  const input = validateRequest(roundInputSchema, req.body || {});
  const round = await svc.createRound(input).catch(rethrowRoundError);
  res.json({ round });
}));

router.put('/:id', asyncHandler(async (req, res) => {
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
