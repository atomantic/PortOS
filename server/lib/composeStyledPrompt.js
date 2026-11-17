/**
 * Compose user prompt + negative with an optional style preset, or an array of presets layered in
 * order.
 *
 * `stylePromptAdditions(preset)` lists what a compose folds in as labeled additions (#11317).
 * Re-exported (unmodified) by `client/src/lib/composeStyledPrompt.js`.
 */

/**
 * Preset prompt(s) prefix the user prompt (diffusion models weight earlier
 * tokens heaviest); preset negative(s) append so user-specified avoids stay first.
 */
export function composeStyledPrompt(userPrompt, userNegative, preset) {
  const prompt = (userPrompt || '').trim();
  const negative = (userNegative || '').trim();
  const presets = Array.isArray(preset) ? preset : [preset];
  const stylePart = presets.map((item) => (item?.prompt || '').trim()).filter(Boolean).join('. ');
  const styleNeg = presets.map((item) => (item?.negativePrompt || '').trim()).filter(Boolean).join(', ');
  // Avoid a dangling ". " when either part is empty.
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
