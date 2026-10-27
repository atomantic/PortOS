// Limits shared by the Issues page and the slashdo request/prompt boundary.
export const ISSUE_BODY_PREVIEW_MAX_CHARS = 8_000;
export const PREFETCHED_ISSUE_CONTEXT_MAX_CHARS = Object.freeze({ title: 1000, body: 12_000, url: 2048 });

export function isCompleteIssueContext(context) {
  if (typeof context?.title !== 'string' || typeof context?.body !== 'string') return false;
  if (context.url !== undefined && typeof context.url !== 'string') return false;
  return Object.entries(PREFETCHED_ISSUE_CONTEXT_MAX_CHARS)
    .every(([field, limit]) => context[field] === undefined || context[field].length <= limit);
}
