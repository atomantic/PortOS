import { copyToClipboard } from './clipboard.js';

export const FAL_H3_MAX_FREE_URL = 'https://fal.ai/tools/minimax-h3-max';

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

/**
 * Open the free browser tool while the click still owns user activation, then
 * copy the prepared prompt. Opening first avoids popup blockers caused by
 * awaiting the Clipboard API before window.open().
 */
export function openFalH3MaxFreeTool({
  prompt,
  negativePrompt = '',
  onCopyFailure,
} = {}) {
  const prepared = buildFalH3MaxPrompt(prompt, negativePrompt);
  if (!prepared) return false;
  globalThis.open?.(FAL_H3_MAX_FREE_URL, '_blank', 'noopener,noreferrer');
  void copyToClipboard(prepared, 'fal H3 Max prompt copied — paste it into the free tool')
    .then((copied) => {
      if (!copied) onCopyFailure?.(prepared);
    });
  return true;
}
