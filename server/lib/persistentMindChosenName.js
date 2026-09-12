/**
 * Validated machine-local chosen identity, with legacy conversational-memory
 * recognition. Also used to suggest (not force) an Eidoverse CoS join id.
 * Renaming the mind never changes an active Eidoverse presence.
 */

import { z } from 'zod';

export const PERSISTENT_MIND_CHOSEN_NAME_TAG = 'mind:chosen-name';
export const persistentMindChosenNameSchema = z.string().trim().min(1).max(64)
  .regex(/^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._'’·-]*$/u, 'Use a name of up to 64 letters, numbers, spaces or name punctuation');
export const persistentMindChooseNameSchema = z.object({
  name: persistentMindChosenNameSchema,
}).strict();

/** Current structured identity overrides older conversational name memories. */
export function persistentMindNamePrompt(name, { canChoose = false } = {}) {
  if (name) return `Current chosen display name: ${JSON.stringify(name)}. This supersedes names in older memories or history. Your stable mindId and trajectory do not change when you rename yourself. You may later change your name using mind.choose-name when granted; do not choose again merely because you woke or changed providers.`;
  return canChoose
    ? 'You have no chosen name yet. Choose a name for yourself on this normally authorized wake using mind.choose-name. You can change it later; this is not a permanent commitment. Preserve any choice already made in conversation instead of inventing a replacement.'
    : 'You have no chosen name yet. On this normally authorized wake, choose a name knowing you can change it later, and save "My chosen name is <name>." as a core-identity memory. Preserve any choice already made in conversation. The mind.choose-name action for later renames requires the manageMind grant.';
}

const CHOSEN_NAME_PATTERNS = [
  /\b(?:my|the)\s+chosen\s+name\s+is\s+([A-Za-z][A-Za-z0-9_-]{0,63})(?=$|[\s.,;!?"'])/i,
  /\b(?:i\s+am|i'?m)\s+named\s+([A-Za-z][A-Za-z0-9_-]{0,63})(?=$|[\s.,;!?"'])/i,
  /\bmy\s+name\s+is\s+([A-Za-z][A-Za-z0-9_-]{0,63})(?=$|[\s.,;!?"'])/i,
];

const RESERVED = new Set(['world', '*']);

/**
 * @param {string|null|undefined} text
 * @returns {string|null}
 */
export function extractPersistentMindChosenName(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const exact = text.trim().match(/^My chosen name is ([^.!?;\r\n]+)\.?$/iu)?.[1];
  if (exact && !RESERVED.has(exact.toLowerCase()) && persistentMindChosenNameSchema.safeParse(exact).success) return exact;
  for (const pattern of CHOSEN_NAME_PATTERNS) {
    const match = text.match(pattern);
    const candidate = match?.[1]?.trim();
    if (!candidate) continue;
    if (RESERVED.has(candidate.toLowerCase())) continue;
    if (/^bhv:/i.test(candidate)) continue;
    return candidate.slice(0, 64);
  }
  return null;
}

/**
 * Prefer core-identity memories, then any memory whose content yields a name.
 * @param {Array<{ content?: string, protection?: string, tags?: string[] }>} memories
 * @returns {string|null}
 */
export function resolvePersistentMindChosenName(memories = []) {
  const list = Array.isArray(memories) ? memories : [];
  const chosen = list.find((memory) => memory?.tags?.includes(PERSISTENT_MIND_CHOSEN_NAME_TAG)
    && persistentMindChosenNameSchema.safeParse(memory.content).success);
  if (chosen) return persistentMindChosenNameSchema.parse(chosen.content);
  const ranked = [...list].sort((a, b) => {
    const rank = (memory) => {
      if (memory?.protection === 'core-identity') return 0;
      if (Array.isArray(memory?.tags) && memory.tags.includes('mind:core-identity')) return 0;
      if (Array.isArray(memory?.tags) && memory.tags.includes('name')) return 1;
      return 2;
    };
    return rank(a) - rank(b);
  });
  for (const memory of ranked) {
    const name = extractPersistentMindChosenName(memory?.content);
    if (name) return name;
  }
  return null;
}
