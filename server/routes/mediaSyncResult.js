import { ServerError } from '../lib/errorHandler.js';

// Translate service reports at the HTTP boundary. Schedulers use the raw reports.
export function requireSyncResult(result, code) {
  if (result.ok) return result;

  const { status, remediation } = result;
  const needsAuth = result.needsAuth === true || status === 'auth-required';
  const localFailure = status === 'snapshot-unreadable' || status === 'persist-failed';
  throw new ServerError(result.error || 'Sync failed', {
    status: needsAuth ? 409 : (localFailure ? 500 : 502),
    code,
    context: { needsAuth, status, remediation },
  });
}
