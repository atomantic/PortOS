export const FAL_H3_MAX_FREE_URL = 'https://fal.ai/tools/minimax-h3-max';
export const FAL_H3_MAX_FREE_ALLOWANCE_NOTE =
  'fal.ai currently advertises up to 5 free videos per day with an account; this vendor-controlled allowance may change.';

/**
 * fal's free H3 Max allowance lives in its browser tool rather than its
 * metered API. Keep the handoff prompt provider-neutral: the authored shot is
 * preserved verbatim and PortOS's avoid list becomes an explicit final block.
 */
export function buildFalH3MaxPrompt(prompt, negativePrompt = '') {
  const shot = typeof prompt === 'string' ? prompt.trim() : '';
  const avoid = typeof negativePrompt === 'string' ? negativePrompt.trim() : '';
  if (!shot) return '';
  return avoid ? `${shot}\n\nAvoid: ${avoid}` : shot;
}
