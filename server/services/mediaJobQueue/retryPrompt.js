// Retry edits target authored text. Preserve the surrounding bytes from the
// saved request, including separators, so unchanged jobs replay verbatim.
function splitPrompt(value, authored, prefix, additions, separators) {
  const text = typeof value === 'string' ? value : '';
  if (typeof authored === 'string' && authored) {
    const offset = text.indexOf(authored, text.startsWith(prefix) ? prefix.length : 0);
    if (offset >= 0 && offset === text.lastIndexOf(authored)) {
      return { text: authored, prefix: text.slice(0, offset), suffix: text.slice(offset + authored.length) };
    }
  }
  if (!text.startsWith(prefix)) prefix = '';
  let end = text.length;
  // Composers before authored fields were available recorded exact addition
  // text. Peel only whole, labeled clauses at the saved prompt's boundary.
  for (const addition of additions.slice().reverse()) {
    if (!addition) continue;
    const suffix = separators.map((separator) => separator + addition)
      .find((candidate) => end - candidate.length >= prefix.length && text.endsWith(candidate, end));
    if (suffix) end -= suffix.length;
  }
  return { text: text.slice(prefix.length, end), prefix, suffix: text.slice(end) };
}

export const isRetryNegativePromptAddition = (item) => (
  ['style-negatives', 'source-negative-prompt', 'universe-photography-avoid', 'canon-avoid'].includes(item?.id)
);

export function retryPromptParts(params) {
  const additions = Array.isArray(params.promptAdditions) ? params.promptAdditions : [];
  const styles = additions.filter((item) => /^style-\d+$/.test(item?.id)).map((item) => item.text).filter(Boolean).join('. ');
  const authoredNegative = params.authoredNegativePrompt;
  const negatives = additions.filter(isRetryNegativePromptAddition);
  const negativesText = negatives.map((item) => item.text).filter(Boolean);
  const positive = additions.filter((item) => item?.text && !negatives.includes(item) && !/^style-\d+$/.test(item.id))
    .map((item) => item.id?.startsWith('universe-photography-') ? `${item.label}: ${item.text}` : item.text);
  const prompt = params.reviewedReferenceRequest?.prompt ?? params.prompt;
  const negative = params.negativePrompt;
  const staticNegative = typeof negative === 'string' && negativesText.includes(negative.trim());
  return {
    prompt: styles && prompt === styles
      ? { text: '', prefix: `${styles}. `, suffix: '' }
      : splitPrompt(prompt, params.authoredPrompt, styles ? `${styles}. ` : '', positive, ['\n\n', '\n', '. ']),
    negativePrompt: staticNegative
      ? { text: '', prefix: '', suffix: `, ${negative}` }
      : splitPrompt(negative, authoredNegative, '', negativesText, [', ']),
  };
}
