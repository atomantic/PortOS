/**
 * Extract a Persistent Mind's chosen display name from protected identity
 * memories. Used to suggest (not force) an Eidoverse CoS join id so chat shows
 * "Helm" instead of the process id `portos-cos`. Mid-session rename is not
 * supported by Eidoverse; the join id must be set before presence connects.
 */

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
