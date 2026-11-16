/**
 * Expand leftover `__PORTOS_ROOT__` tokens in apps registry fields (`repoPath`, `appIconPath`, …): `PORTOS_ROOT_TOKEN`, `expandPortosRootToken`, `expandPortosRootInApp`, `containsPortosRootToken`.
 *
 * `data.reference/apps.json` ships the token so the seed is install-agnostic; `scripts/setup-data.js` (via `scripts/lib/rewriteAppsPortosRoot.js`) expands it when seeding `data/` and `services/apps.js` re-expands on load, so a partial/restored `data/` carrying the literal token can't leave Apps → Git stuck on "Checkout not found".
 */

export const PORTOS_ROOT_TOKEN = '__PORTOS_ROOT__';

/** Replace every `__PORTOS_ROOT__` in a string with `root` (absolute install/checkout path); non-strings and token-free strings are returned unchanged. */
export function expandPortosRootToken(value, root) {
  if (typeof value !== 'string' || !value.includes(PORTOS_ROOT_TOKEN)) return value;
  return value.split(PORTOS_ROOT_TOKEN).join(root);
}

/** Expand `__PORTOS_ROOT__` in every top-level string field of an app record → `{ app, changed }` (`root`: absolute install/checkout path). */
export function expandPortosRootInApp(app, root) {
  if (!app || typeof app !== 'object' || Array.isArray(app)) {
    return { app, changed: false };
  }
  let changed = false;
  const next = { ...app };
  for (const [key, value] of Object.entries(next)) {
    const expanded = expandPortosRootToken(value, root);
    if (expanded !== value) {
      next[key] = expanded;
      changed = true;
    }
  }
  return { app: next, changed };
}

/** True when `text` still carries the unresolved install-root token. */
export function containsPortosRootToken(text) {
  return typeof text === 'string' && text.includes(PORTOS_ROOT_TOKEN);
}
