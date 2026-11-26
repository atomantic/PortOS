/** Maps media job cancellation results to successful response bodies or HTTP refusals. */

import { ServerError } from './errorHandler.js';

export const CANCEL_ALREADY_TERMINAL = Object.freeze({ ok: false, code: 'ALREADY_TERMINAL' });

/** Turn a service's cancellation result into a successful response or an HTTP refusal. */
export function assertCancelResult(result, { notFoundMessage = 'Job not found or expired' } = {}) {
  if (result?.code === 'ALREADY_TERMINAL') {
    throw new ServerError(result.error || 'Job has finished or is finishing', { status: 409, code: 'ALREADY_TERMINAL' });
  }
  if (!result || result.ok === false) {
    throw new ServerError(result?.error || notFoundMessage, { status: 404, code: 'NOT_FOUND' });
  }
  return result === true ? { ok: true } : result;
}
