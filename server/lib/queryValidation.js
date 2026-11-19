/**
 * Shared `req.query` schemas (pagination, cache/force flags, scalar filters) for routes whose handlers parse values leniently themselves.
 *
 * Each field is a bare string: Express yields an array or object for `?k=a&k=b` / `?k[x]=1`, and
 * that is the only malformed shape rejected (400). Value leniency (a bad or absent `limit` falls
 * back to the default in `parsePagination`) stays with the handler so clients that send today's
 * values see no change; unknown keys are stripped, never rejected, for older clients and peers.
 */
import { z } from 'zod';
import { ServerError } from './errorHandler.js';

const scalar = z.string().optional();

/** `?limit=&offset=` as read by `parsePagination` / `isPaginationRequested` / `paginateArray`. */
export const paginationQuerySchema = z.object({ limit: scalar, offset: scalar });

/** `?limit=` alone, for handlers that only take a count. */
export const limitQuerySchema = z.object({ limit: scalar });

/** `?refresh=1|true` cache-bypass flag. */
export const refreshQuerySchema = z.object({ refresh: scalar });

/** `?fresh=1` cache-bypass flag. */
export const freshQuerySchema = z.object({ fresh: scalar });

/** `?confirm=true` guard on a destructive bulk action. */
export const confirmQuerySchema = z.object({ confirm: scalar });

/** `?force=true` override on a protected-delete guard. */
export const forceQuerySchema = z.object({ force: scalar });

/** `?runtime=` naming a local runtime to install or inspect. */
export const runtimeQuerySchema = z.object({ runtime: scalar });

/** GET /api/apps/:id/work-items. */
export const workItemsQuerySchema = z.object({ issueAuthorFilter: scalar });

/** GET /api/apps/:id/vite-host-check. */
export const viteHostCheckQuerySchema = z.object({ host: scalar });

/** GET /api/platform-accounts. */
export const platformAccountsQuerySchema = z.object({ agentId: scalar, platform: scalar });

/** GET /api/review/items. */
export const reviewItemsQuerySchema = z.object({ status: scalar, type: scalar });

/** GET /api/sharing/subscriptions. */
export const sharingSubscriptionsQuerySchema = z.object({ bucketId: scalar, recordKind: scalar, recordId: scalar });

/** GET /api/spotify/oauth/callback (provider redirect: `code` on success, `error` on denial). */
export const spotifyOauthCallbackQuerySchema = z.object({ code: scalar, error: scalar });

/** GET /api/voice/voices and the public voice listing. */
export const voiceEngineQuerySchema = z.object({ engine: scalar });

/** GET /api/writers-room/exercises: `workId` may repeat and the handler keeps the first non-empty value. */
export const writersRoomExercisesQuerySchema = z.object({ workId: z.union([z.string(), z.array(z.string())]).optional() });

/** GET /api/providers/readiness. */
export const providerReadinessQuerySchema = z.object({ providerId: scalar });

/** POST /api/providers/readiness/setup. */
export const providerReadinessSetupQuerySchema = z.object({ provider: scalar, runtime: scalar, action: scalar });

/** POST /api/providers/readiness/serve-model. */
export const providerServeModelQuerySchema = z.object({ provider: scalar });

export const searchQuerySchema = z.object({
  q: z.string().min(2).max(200).trim()
});

/**
 * Parse a zero-based array index from an Express route parameter.
 * @param {unknown} raw - Route parameter value
 * @returns {number}
 */
export function parseIndexParam(raw) {
  const index = Number(raw);
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(index)) {
    throw new ServerError('Invalid index', { status: 400, code: 'INVALID_INDEX' });
  }
  return index;
}

/**
 * Parse limit/offset pagination from query params with defaults and clamping.
 * @param {object} query - req.query object
 * @param {object} options - { defaultLimit, maxLimit }
 * @returns {{ limit: number, offset: number }}
 */
export function parsePagination(query, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const rawLimit = parseInt(query?.limit, 10);
  const rawOffset = parseInt(query?.offset, 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, maxLimit) : defaultLimit;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  return { limit, offset };
}

/**
 * Did the caller explicitly ask for pagination? True when either `limit` or
 * `offset` is present in the query string. Lets a list endpoint stay
 * backward-compatible (return the full array when neither is set) while opting
 * into a bounded `{ items, total, limit, offset }` envelope the moment a client
 * passes a pagination param.
 * @param {object} query - req.query object
 * @returns {boolean}
 */
export function isPaginationRequested(query) {
  return query?.limit !== undefined || query?.offset !== undefined;
}

/**
 * Slice an array into a bounded page using the same limit/offset parsing as
 * `parsePagination`. Returns the page plus the metadata needed to render the
 * envelope every paginated PortOS list endpoint shares.
 * @param {Array} items - the full list (already filtered/sorted by the caller)
 * @param {object} query - req.query object
 * @param {object} options - { defaultLimit, maxLimit }
 * @returns {{ items: Array, total: number, limit: number, offset: number }}
 */
export function paginateArray(items, query, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const { limit, offset } = parsePagination(query, options);
  return { items: list.slice(offset, offset + limit), total: list.length, limit, offset };
}
