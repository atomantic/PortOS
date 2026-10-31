// A new camera angle starts from its own plate, not the prior clip's last
// frame (#14245). The only carry-over is one sentence of text so the new shot
// still knows where the previous one ended.

const MAX_ENDING_CHARS = 240;

/**
 * Last sentence of the previous shot's description, as the "ending state".
 * Returns '' when there is nothing usable.
 */
function previousShotEnding(description) {
  const text = typeof description === 'string' ? description.replace(/\s+/g, ' ').trim() : '';
  if (!text) return '';
  const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
  const last = sentences.map((s) => s.trim()).filter(Boolean).pop() || '';
  return last.length > MAX_ENDING_CHARS ? `${last.slice(0, MAX_ENDING_CHARS - 1).trimEnd()}…` : last;
}

/**
 * Append "Previous shot ended with: …" to a prompt; unchanged when no ending is
 * derivable. With `maxLength`, the note is kept whole and the base prompt gives
 * up the room (the note is the short, load-bearing part).
 */
export function appendPreviousShotNote(prompt, previousDescription, { maxLength = Infinity } = {}) {
  const ending = previousShotEnding(previousDescription);
  if (!ending) return prompt;
  const terminated = /[.!?…]$/.test(ending) ? ending : `${ending}.`;
  const note = ` Previous shot ended with: ${terminated}`;
  return `${prompt.slice(0, Math.max(0, maxLength - note.length))}${note}`;
}
