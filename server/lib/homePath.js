/**
 * scrubHomePath — replace the running user's home-directory prefix with `~`.
 *
 * Lives in its own zero-dependency module, rather than beside the other
 * redaction helpers in `agentRunEvents.js`, because two callers need it from
 * opposite ends of the dependency graph:
 *
 *   - the CoS run ledger (`agentRunEvents.js`), which re-exports this symbol so
 *     every existing `import { scrubHomePath } from './agentRunEvents.js'`
 *     caller is unchanged, and
 *   - `scripts/doctor.js`, whose whole job is explaining an install that will
 *     not start — including one where `server/node_modules` was never installed.
 *     Everything doctor imports statically therefore has to load from a bare
 *     checkout using Node builtins only (`scripts/pre-install-entrypoints.test.js`
 *     enforces that). Reaching for the scrubber through `agentRunEvents.js`
 *     would drag in zod and the trajectory schemas, and the diagnostic would
 *     crash on exactly the installs it exists to diagnose.
 *
 * Builtins only. Keep it that way — see the guard test above.
 */
import { homedir } from 'os';

/**
 * Replace the user's home directory prefix with `~` anywhere in a string.
 *
 * Workspace paths are the most common thing a lifecycle payload carries, and
 * `/Users/<name>/…` embeds the OS username. The ledger is machine-local, but a
 * diagnostic is exactly the thing a user pastes into a bug report, so the
 * username never gets written down in the first place.
 *
 * @param {*} value - any value; non-strings pass through untouched
 * @returns {*} the scrubbed string, or `value` unchanged
 */
export function scrubHomePath(value) {
  const home = homedir();
  // A root-user container reports `/` as the home directory. Substituting on
  // that would rewrite every separator in every path (`/var/log` → `~var~log`),
  // destroying the diagnostic to protect a username that isn't in the string.
  if (typeof value !== 'string' || !home || home === '/' || home === '\\') return value;
  return value.split(home).join('~');
}
