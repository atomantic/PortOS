/**
 * Shared helper for rendering or prepending prompt sections.
 *
 * A pattern used by multiple prompt renderers: when a template contains a token,
 * replace it (with a function replacer for `$` safety); when the token is absent,
 * prepend the block with an optional heading — a fallback for customized prompts
 * that dropped the token.
 */

import { escapeRegExp } from './textUtils.js';

/**
 * Replace a token in a prompt, or prepend the block with a heading if the token is absent.
 *
 * @param {string} prompt - The prompt template string (or empty/non-string if falsy)
 * @param {string} token - The token to find/replace (e.g., `{userActionDelivery}`)
 * @param {string|null} heading - Optional heading for the prepended section (e.g., `Delivery mode`);
 *                                 pass null for no heading
 * @param {string} block - The content block to render
 * @returns {string} The prompt with the section applied
 */
export function renderOrPrependSection(prompt, token, heading, block) {
  const promptStr = typeof prompt === 'string' ? prompt : '';

  // If token is present in the prompt, replace it with a function replacer
  // (safe when block contains $ or $&)
  if (promptStr.includes(token)) {
    return promptStr.replace(new RegExp(escapeRegExp(token), 'g'), () => block);
  }

  // Token absent: prepend the block with optional heading
  if (heading === null) {
    // No heading case
    return `${block}\n\n---\n\n${promptStr}`;
  }

  // With heading
  return `## ${heading}\n\n${block}\n\n---\n\n${promptStr}`;
}
