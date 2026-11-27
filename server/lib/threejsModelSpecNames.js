/**
 * Formats finding names and tokenizes scene-spec identifiers for Three.js model audits.
 */

const MAX_NAMES_IN_MESSAGE = 8;

/**
 * Render a capped, comma-joined list of spec-level names (parts or features) for
 * a finding message so all audits truncate long lists the same way.
 */
export const listSpecNames = (names) => (names.length > MAX_NAMES_IN_MESSAGE
  ? `${names.slice(0, MAX_NAMES_IN_MESSAGE).join(', ')} (+${names.length - MAX_NAMES_IN_MESSAGE} more)`
  : names.join(', '));

/**
 * Split a spec identifier — a material id, a part name, a feature phrase — into
 * lowercase word tokens, breaking on separators AND on camelCase boundaries so
 * `oakTrim` and `oak_trim` tokenize the same. A trailing
 * plural is folded in as an extra candidate token rather than replacing the
 * original, so `planks` matches `plank` without `abs` losing its own keyword.
 */
export const tokenizeSpecIdentifier = (id) => {
  const words = String(id || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const tokens = new Set(words);
  for (const word of words) {
    if (word.length > 3 && word.endsWith('s')) tokens.add(word.slice(0, -1));
  }
  return [...tokens];
};
