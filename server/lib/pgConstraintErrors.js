/**
 * Maps PostgreSQL constraint violations to 4xx errors with safe messages.
 *
 * 23505 (unique) becomes 409 CONFLICT and 23503 (foreign key) becomes 404, so a
 * duplicate or dangling reference never leaks a raw constraint name as a 500.
 * Other errors rethrow untouched.
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
