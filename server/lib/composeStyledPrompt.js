/**
 * Compose a user prompt + negative with an optional style preset — or several,
 * for a caller layering independent style sources (e.g. a universe style and a
 * built-in preset).
 *
 * `client/src/lib/composeStyledPrompt.js` re-exports `composeStyledPrompt`
 * from here (it keeps `composeCanonStyledPrompt`, a client-only wrapper).
 *
 * Preset prompt(s) prefix the user prompt — diffusion models weight earlier
 * tokens heaviest, so the broad aesthetic carries over the user's content.
 * Preset negative(s) append to user negative so user-specified avoids stay
 * first-class.
 *
 * Used by Universe Builder's batch-prompt compiler, the pipeline's visual
 * stages, and any future server-side caller that needs the same style-prefix
 * convention.
 */
export function composeStyledPrompt(userPrompt, userNegative, preset) {
  const prompt = (userPrompt || '').trim();
  const negative = (userNegative || '').trim();
  const presets = Array.isArray(preset) ? preset : [preset];
  const stylePart = presets.map((item) => (item?.prompt || '').trim()).filter(Boolean).join('. ');
  const styleNeg = presets.map((item) => (item?.negativePrompt || '').trim()).filter(Boolean).join(', ');
  // Avoid trailing ". " when only one of the two parts is non-empty so the
  // composed prompt is clean and deterministic regardless of which input
  // is missing.
  const composedPrompt = stylePart && prompt ? `${stylePart}. ${prompt}` : (stylePart || prompt);
  return {
    prompt: composedPrompt,
    negativePrompt: [negative, styleNeg].filter(Boolean).join(', '),
  };
}

/**
 * The labeled additions `composeStyledPrompt` folds around the user's text, for
 * the "added to your prompt" chips and the sent-prompt record (#11317). A preset
 * names itself with `additionLabel` (the universe style) or its picker `label`.
 */
export function stylePromptAdditions(preset) {
  const presets = (Array.isArray(preset) ? preset : [preset]).filter(Boolean);
  const additions = presets
    .filter((item) => (item.prompt || '').trim())
    .map((item, index) => ({
      id: `style-${index + 1}`,
      label: item.additionLabel || (item.label ? `Style preset: ${item.label}` : 'Style'),
      text: item.prompt.trim(),
    }));
  const styleNeg = presets.map((item) => (item.negativePrompt || '').trim()).filter(Boolean).join(', ');
  return styleNeg ? [...additions, { id: 'style-negatives', label: 'Style negatives', text: styleNeg }] : additions;
}
