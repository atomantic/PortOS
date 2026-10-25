/** Checkout-relative roots shared by test publishers, runners and retirement. */
export const WORKSPACE_TEST_CACHE_ROOTS = Object.freeze({
  server: { workspace: 'server', cacheDir: '.cache/vitest' },
  client: { workspace: 'client', cacheDir: '.cache/vitest' },
  db: { workspace: 'server', cacheDir: '.cache/vitest-db' },
});
