// Compose user prompt + negative with an optional style preset.
// Preset prompt prefixes the user prompt — diffusion models weight earlier
// tokens heaviest, so the broad aesthetic carries over the user's content.
// Preset negative appends to user negative so user-specified avoids stay
// first-class.

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
