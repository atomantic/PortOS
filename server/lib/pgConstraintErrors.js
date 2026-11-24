/**
 * Map PostgreSQL constraint violations to the standard 4xx envelope so a duplicate
 * or dangling reference is a client refusal, not a 500 that leaks the raw
 * constraint name. 23505 (unique) -> 409 CONFLICT, 23503 (foreign key) -> 404.
 * Anything else rethrows untouched.
 */
import { ServerError } from './errorHandler.js';

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';

export async function mapPgConstraintErrors(work, { conflict, missing }) {
  try {
    return await work();
  } catch (err) {
    if (err?.code === PG_UNIQUE_VIOLATION) throw new ServerError(conflict, { status: 409 });
    if (err?.code === PG_FOREIGN_KEY_VIOLATION) throw new ServerError(missing, { status: 404 });
    throw err;
  }
}
