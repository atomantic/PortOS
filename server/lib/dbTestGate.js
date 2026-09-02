/**
 * Keep locally unavailable database suites visible as skips, while letting CI
 * fail fast when its required test database was not provisioned correctly.
 */
export function requireDbOrSkip(label, dbReady, reason) {
  if (dbReady) return true;

  const skipReason = reason || 'no database';
  if (process.env.PORTOS_REQUIRE_DB) {
    throw new Error(`${label}: DB-backed suite skipped but PORTOS_REQUIRE_DB is set — ${skipReason}`);
  }

  console.log(`⏭️ ${label}: skipping suite — ${skipReason}`);
  return false;
}
