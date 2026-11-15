import { ServerError } from './errorHandler.js';

/**
 * Validate data against a Zod schema, throwing on failure.
 * Returns parsed data on success, throws ServerError on failure.
 *
 * Lives in its own leaf (issue #16096) so ~113 route/service files that need
 * only this function do not pay for the whole validation.js schema graph.
 * validation.js re-exports it for compatibility. Keep this module's imports
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
