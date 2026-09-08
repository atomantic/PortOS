/**
 * `data.reference/apps.json` ships `__PORTOS_ROOT__` in fields like `repoPath`
 * and `appIconPath` so the seed is install-agnostic. `scripts/setup-data.js`
 * expands the token when seeding `data/`, and `server/services/apps.js`
 * re-expands on load so a partial/restored `data/` that still carries the
 * literal token cannot leave Apps → Git stuck on "Checkout not found".
 */

export const PORTOS_ROOT_TOKEN = '__PORTOS_ROOT__';

/**
 * Replace every `__PORTOS_ROOT__` occurrence in a string with `root`.
 * Non-strings and strings without the token are returned unchanged.
 *
 * @param {unknown} value
 * @param {string} root Absolute install/checkout path
 * @returns {unknown}
 */
export function expandPortosRootToken(value, root) {
  if (typeof value !== 'string' || !value.includes(PORTOS_ROOT_TOKEN)) return value;
  return value.split(PORTOS_ROOT_TOKEN).join(root);
}

/**
 * Expand `__PORTOS_ROOT__` in every top-level string field of an app record.
 *
 * @param {Record<string, unknown>|null|undefined} app
 * @param {string} root Absolute install/checkout path
 * @returns {{ app: Record<string, unknown>|null|undefined, changed: boolean }}
 */
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

/**
 * True when `text` still carries the unresolved install-root token.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function containsPortosRootToken(text) {
  return typeof text === 'string' && text.includes(PORTOS_ROOT_TOKEN);
}
