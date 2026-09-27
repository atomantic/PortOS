import { escapeRegExp } from './textUtils.js';

/**
 * Substitute `token` in a prompt template with `block`, or — when a
 * customized prompt dropped the token — prepend the block (under `## heading`
 * unless heading is null) so the operator's setting still takes effect.
 * The function replacer inserts `block` verbatim even when it contains `$&`.
 */
export function renderOrPrependSection(prompt, token, heading, block) {
  const text = typeof prompt === 'string' ? prompt : '';
  if (text.includes(token)) return text.replace(new RegExp(escapeRegExp(token), 'g'), () => block);
  const section = heading === null ? block : `## ${heading}\n\n${block}`;
  return `${section}\n\n---\n\n${text}`;
}
