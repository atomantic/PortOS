/**
 * One actionable line for a failed `setup-db-test.mjs` run, so the operator
 * sees the real blocker instead of an uncaught pg stack (or, worse, a missing
 * table in a later suite).
 */

// 42501 insufficient_privilege; the message check keeps a plain GRANT problem
// from being misreported as an extension problem.
const isExtensionPrivilegeError = (error) =>
  error?.code === '42501' && /extension/i.test(error.message ?? '');

export function describeSetupFailure(error, testDb) {
  if (isExtensionPrivilegeError(error)) {
    return `${error.message}. Creating extensions needs a superuser: as one, run `
      + `\`psql -d ${testDb} -c 'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;'\` `
      + 'and re-run `npm run setup:db:test`, or provision with a role that can create them.';
  }
  const detail = error?.message || error?.code || String(error);
  return `${detail}${error?.code && error.message ? ` (${error.code})` : ''}`;
}
