/**
 * Shared `req.query` schemas for list endpoints whose handlers parse values leniently themselves.
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
