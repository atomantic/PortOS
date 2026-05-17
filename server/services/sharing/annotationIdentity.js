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
 */

import * as os from 'os';
import { getSettings } from '../settings.js';
import { isStr } from '../../lib/storyBible.js';

export async function resolveGlobalDisplayName() {
  const settings = await getSettings().catch(() => ({}));
  if (isStr(settings?.sharingDisplayName) && settings.sharingDisplayName.trim()) {
    return settings.sharingDisplayName.trim();
  }
  return os.userInfo().username || 'unknown';
}

export const resolveLocalAuthorName = resolveGlobalDisplayName;
