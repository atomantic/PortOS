/** Request schemas for Music Video DCPs, review excerpts, and social cuts. */

import { z } from 'zod';

export { musicVideoExcerptRequestSchema } from '../musicVideoValidation.js';

export const musicVideoDcpRequestSchema = z.object({ grade: z.enum(['rec709', 'rec1886']), renderHistoryId: z.string().min(1), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

// ---- Draft excerpt render (#8986) -------------------------------------------
// A director-chosen `[startSec, endSec)` window re-rendered through the same
// composed pipeline as a full render, plus a cut/cue contact sheet and
// timecoded review notes against the excerpt's OWN timeline (0 = its start).
// See services/musicVideo/excerpt.js / excerptRender.js.
const MUSIC_VIDEO_EXCERPT_NOTE_VERDICTS = ['flagged', 'approved'];

// #9280: hook-window suggestions for social cuts.
export const musicVideoSocialCutsQuerySchema = z.object({
  count: z.coerce.number().int().min(1).max(10).optional(),
  minSec: z.coerce.number().min(3).max(120).optional(),
  maxSec: z.coerce.number().min(5).max(180).optional(),
}).strict().refine((q) => q.minSec == null || q.maxSec == null || q.maxSec >= q.minSec, { message: 'maxSec must be at least minSec' });

export const musicVideoExcerptNoteSchema = z.object({
  atSec: z.number().min(0).max(36000),
  note: z.string().min(1).max(2000),
  verdict: z.enum(MUSIC_VIDEO_EXCERPT_NOTE_VERDICTS).nullable().optional(),
}).strict();

export const musicVideoExcerptNoteUpdateSchema = z.object({
  atSec: z.number().min(0).max(36000).optional(),
  note: z.string().min(1).max(2000).optional(),
  verdict: z.enum(MUSIC_VIDEO_EXCERPT_NOTE_VERDICTS).nullable().optional(),
}).strict().refine((r) => r.atSec !== undefined || r.note !== undefined || r.verdict !== undefined, { message: 'atSec, note or verdict is required' });
