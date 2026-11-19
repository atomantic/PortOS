/**
 * `validateRequest(schema, data)` — the request-validation helper (Zod `safeParse`, throws
 * `ServerError` 400 `VALIDATION_ERROR`).
 *
 * Its own leaf (imports only `errorHandler.js`) so the route/service files that need only this
 * function don't load any schema module (#16096). Also home to `validate`, its non-throwing sibling.
 */

import { ServerError } from './errorHandler.js';

/**
 * Validate data against a Zod schema, throwing on failure.
 * Returns parsed data on success, throws ServerError on failure.
 *
 * Lives in its own leaf (issue #16096) so route/service files that need
 * only this function do not pay for a schema graph. Keep this module's imports
 * limited to ServerError's leaf.
 */
export function validateRequest(schema, data) {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const errors = result.error.issues.map(e => ({
    path: e.path.join('.'),
    message: e.message
  }));
  throw new ServerError('Validation failed', {
    status: 400,
    code: 'VALIDATION_ERROR',
    context: { details: errors }
  });
}

/**
 * Validate data against a schema
 * Returns { success: true, data } or { success: false, errors }
 */
export function validate(schema, data) {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.issues.map(e => ({
      path: e.path.join('.'),
      message: e.message
    }))
  };
}
