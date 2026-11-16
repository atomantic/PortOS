/**
 * Zod schemas for the lenient query-string shapes shared by many list and action routes (pagination, refresh flags, scalar filters).
 *
 * Every field is an optional scalar string on purpose: handlers keep their historical value
 * parsing (`parsePagination` clamping, `=== '1'` flags), so only a repeated or nested key such as
 * `?limit=1&limit=2` is refused with a 400, and unknown keys are stripped rather than rejected so
 * older clients, peers and agent scripts keep working (#16428). Leaf module: imports only zod.
 */

import { z } from 'zod';

const scalar = z.string().optional();

/** `?limit=&offset=`, passed on to `isPaginationRequested` / `paginateArray` / `parsePagination`. */
export const paginationQuerySchema = z.object({ limit: scalar, offset: scalar });

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
