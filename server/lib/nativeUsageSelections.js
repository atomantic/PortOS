// Pure account-selection configuration. Keep independent of native capture and
// record-union dependencies: validation and socket invalidation import this leaf.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalStringify } from './objects.js';

export const NATIVE_USAGE_ACCOUNT_SELECTIONS_KEY = 'usageNativeAccountSelections';
const participantKey = z.string().regex(/^[0-9a-f]{32}$/);
const sha256 = text => createHash('sha256').update(text).digest('hex');
const hashOf = value => sha256(canonicalStringify(value));

const accountSelection = {
  accountLabel: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  members: z.array(participantKey).min(1).max(64),
};
/** A selection asserts account membership; equal counters never establish identity.
 * Retained-provider selections apply to retained history, not merely the currently signed-in account.
 */
export const nativeUsageAccountSelectionsSchema = z.array(z.discriminatedUnion('family', [
  z.strictObject({ family: z.literal('codex'), ...accountSelection, authoritativeParticipant: participantKey }),
  z.strictObject({ family: z.literal('claude'), ...accountSelection, historyScope: z.literal('operator-confirmed-retained-history') }),
  z.strictObject({ family: z.literal('grok'), ...accountSelection, historyScope: z.literal('operator-confirmed-retained-history') }),
  z.strictObject({ family: z.literal('agy'), ...accountSelection, historyScope: z.literal('operator-confirmed-retained-history') }),
])).max(64).superRefine((selections, ctx) => {
  const claimed = new Set();
  const labels = new Set();
  for (const [index, selection] of selections.entries()) {
    const refuse = (message) => ctx.addIssue({ code: 'custom', path: [index], message });
    const label = `${selection.family}:${selection.accountLabel}`;
    if (labels.has(label)) refuse('accountLabel is already selected for this provider');
    labels.add(label);
    if (selection.family === 'codex' && !selection.members.includes(selection.authoritativeParticipant)) refuse('authoritativeParticipant must be a member');
    for (const member of selection.members) {
      const membership = `${selection.family}:${member}`;
      if (claimed.has(membership)) refuse('a participant can belong to only one account per provider');
      claimed.add(membership);
    }
  }
});

/** Opaque configuration revision, shared by the editor, matrix and invalidation.
 * Invalid saved selections have no revision and must never become an empty draft.
 */
export function nativeUsageSelectionRevision(selections) {
  const parsed = nativeUsageAccountSelectionsSchema.safeParse(selections);
  return parsed.success ? hashOf({ kind: 'native-usage-account-selections/1', selections: parsed.data }) : null;
}

/** Stable and not reversible to the random instance UUID it is derived from. */
export const nativeUsageParticipantKey = (instanceId) => (
  typeof instanceId === 'string' && instanceId && instanceId !== 'unknown'
    ? sha256(`portos-native-usage-participant/1\0${instanceId}`).slice(0, 32)
    : null
);

