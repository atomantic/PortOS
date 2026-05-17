/**
 * Single source of truth for the "who am I when sharing?" display name.
 *
 * `resolveGlobalDisplayName` returns settings.sharingDisplayName → OS user.
 * `resolveLocalAuthorName` is the alias used by mediaAnnotations — annotation
 * entries stamp the *global* name (no per-bucket override) so the name is
 * consistent across every bucket the note flows into.
 *
 * exporter.js#resolveSourceName layers a per-bucket `displayNameOverride`
 * short-circuit on top of this for manifest envelopes.
 *
 * Result is memoized for `CACHE_TTL_MS` so hot annotation paths (sync flush,
 * bucket export, every setAnnotation) don't re-read settings.json off disk
 * once per call. settings.js emits `settings:updated` on every save and the
 * lazy listener invalidates the cache; the 30-second TTL covers hand-edited
 * settings.json + the brief race window before the listener attaches.
 * Callers that need a fresh read (e.g. a test asserting a just-saved value)
 * can call `invalidateGlobalDisplayNameCache()`.
 */

import * as os from 'os';
import { getSettings, settingsEvents } from '../settings.js';
import { isStr } from '../../lib/storyBible.js';

const CACHE_TTL_MS = 30_000;
let cachedName = null;
let cachedAt = 0;
let subscribed = false;

export function invalidateGlobalDisplayNameCache() {
  cachedName = null;
  cachedAt = 0;
}

// Lazy subscription so vitest module re-imports don't accumulate listeners on
// `settingsEvents` for tests that never touch the sharing path. One listener
// per process for the in-process write event; the 30s TTL covers hand-edited
// settings.json + the brief race window between a write and the listener
// firing in another module's microtask.
const ensureSubscribed = () => {
  if (subscribed) return;
  subscribed = true;
  settingsEvents.on('settings:updated', invalidateGlobalDisplayNameCache);
};

export async function resolveGlobalDisplayName() {
  ensureSubscribed();
  const now = Date.now();
  if (cachedName !== null && (now - cachedAt) < CACHE_TTL_MS) {
    return cachedName;
  }
  const settings = await getSettings().then((s) => s, () => null);
  const sharing = (settings && isStr(settings.sharingDisplayName) && settings.sharingDisplayName.trim()) || '';
  const resolved = sharing || os.userInfo().username || 'unknown';
  // Skip caching when settings.json was unreadable — otherwise a transient
  // read failure pins the OS-username fallback for 30s and masks a recovered
  // sharingDisplayName until the TTL expires.
  if (settings !== null) {
    cachedName = resolved;
    cachedAt = now;
  }
  return resolved;
}

export const resolveLocalAuthorName = resolveGlobalDisplayName;
