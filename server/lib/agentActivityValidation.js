/**
 * Zod schemas for the agent-activity timeline and per-agent stats routes.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { emptyToUndefined, isSafeRecordId } from './zodCompat.js';
import { csvIdsParam } from './sharedSchemas.js';

// The activity log is a per-agent, per-day tree of JSON files under
// `data/agents/activity/<agentId>/<YYYY-MM-DD>.json`. Two things follow:
// `agentId` is interpolated into a filesystem path, so it is held to a bare
// filename segment (`isSafeRecordId` on top of the charset, so `..` can't turn
// a read into a traversal); and the read limits are CLAMPED here rather than in
// the service, because every handler slices an already-loaded array — an
// unbounded `limit` is a memory/response-size problem, not a query cost.
const AGENT_ACTIVITY_MAX_LIMIT = 500;
const agentActivityLimit = (defaultLimit) =>
  z.coerce.number().int().min(1).max(AGENT_ACTIVITY_MAX_LIMIT).default(defaultLimit);
// A blank query value (`?action=` from an unset form field) reads as absent
// rather than as a 400 — it was `action || null` before this schema existed.
const agentActivityAction = z.preprocess(emptyToUndefined, z.string().trim().min(1).max(64).optional());
const agentActivityIds = csvIdsParam({ max: 50, maxIdLength: 128 });

// GET /api/agents/activity
export const agentActivityQuerySchema = z.object({
  limit: agentActivityLimit(50),
  agentIds: agentActivityIds,
  action: agentActivityAction,
}).strict();

// GET /api/agents/activity/timeline — `before` is an infinite-scroll cursor the
// client echoes back from a row's `timestamp`, so it is a full ISO instant.
export const agentActivityTimelineQuerySchema = z.object({
  limit: agentActivityLimit(50),
  agentIds: agentActivityIds,
  // One action or a comma-separated list (the Moltworld history asks for every mw_* kind).
  action: csvIdsParam({ max: 10, maxIdLength: 64 }),
  before: z.preprocess(emptyToUndefined, z.string().datetime().optional()),
}).strict();

export const agentActivityAgentParamsSchema = z.object({
  agentId: z.string().trim().min(1).max(128)
    .regex(/^[A-Za-z0-9._-]+$/, 'agentId must be alphanumeric with . _ -')
    .refine(isSafeRecordId, 'agentId must be a bare filename segment'),
}).strict();

// GET /api/agents/activity/agent/:agentId/stats — one file read per day, so the
// window is capped at a year rather than left open.
export const agentActivityStatsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(7),
}).strict();
