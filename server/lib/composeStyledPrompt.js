/**
 * Compose a user prompt + negative with an optional style preset.
 *
 * Mirror of `client/src/lib/composeStyledPrompt.js` — kept in sync manually
 * since client and server are separate bundles (same convention as
 * `server/lib/scenePrompt.js` ↔ `client/src/lib/scenePrompt.js`).
 *
 * Preset prompt prefixes the user prompt — diffusion models weight earlier
 * tokens heaviest, so the broad aesthetic carries over the user's content.
 * Preset negative appends to user negative so user-specified avoids stay
 * first-class.
 *
 * Used by Universe Builder's batch-prompt compiler and any future server-side
 * caller that needs the same style-prefix convention.
 */
export function composeStyledPrompt(userPrompt, userNegative, preset) {
  const prompt = (userPrompt || '').trim();
  const negative = (userNegative || '').trim();
  if (!preset) return { prompt, negativePrompt: negative };
  const stylePart = (preset.prompt || '').trim();
  const styleNeg = (preset.negativePrompt || '').trim();
  // Avoid trailing ". " when only one of the two parts is non-empty so the
  // composed prompt is clean and deterministic regardless of which input
  // is missing.
  const composedPrompt = stylePart && prompt ? `${stylePart}. ${prompt}` : (stylePart || prompt);
  return {
    prompt: composedPrompt,
    negativePrompt: [negative, styleNeg].filter(Boolean).join(', '),
  };
}
