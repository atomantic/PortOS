/**
 * Shared `req.query` schemas (pagination, cache/force flags, scalar filters) for routes whose handlers parse values leniently themselves.
 *
 * Each field is a bare string: Express yields an array or object for `?k=a&k=b` / `?k[x]=1`, and
 * that is the only malformed shape rejected (400). Value leniency (a bad or absent `limit` falls
 * back to the default in `parsePagination`) stays with the handler so clients that send today's
 * values see no change; unknown keys are stripped, never rejected, for older clients and peers.
 */
import { z } from 'zod';

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
