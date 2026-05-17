// Mirror of `joinInfluenceList` in server/services/universeBuilder.js — keep
// in sync. Joins a universe's chip-token list (embrace OR avoid) into the
// comma-separated string the renderer's composeStyledPrompt consumes.
// Tokens are already deduped + capped at write time, so this is a thin join.
export function joinInfluenceList(structured = []) {
  if (!Array.isArray(structured)) return '';
  return structured.filter((t) => typeof t === 'string' && t.trim()).join(', ');
}
