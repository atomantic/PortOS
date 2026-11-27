/**
 * Paths the server Biome rule set covers.
 *
 * server/ is linted from server/biome.jsonc. scripts/, lib/ (not the slashdo
 * submodule) and autofixer/ are linted from the repo-root biome.jsonc.
 * run-ci-lint.js and ci-test-plan.js both import this so the runner and the
 * planner cannot drift. Builtin-free: ci-test-plan.js loads before npm ci,
 * and the pregate fixture copies this file instead of the lint runner, which
 * those tests replace with a stub.
 */

export const SERVER_LINT_RE = /^(?:(?:server|autofixer)\/(?!node_modules\/).*\.[cm]?js|(?:scripts\/(?!node_modules\/)|lib\/(?!slashdo\/)).*\.m?js|(?:server\/)?(?:biome\.jsonc|lint-[^/]+\.grit))$/i;
