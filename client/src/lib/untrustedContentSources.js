/**
 * Untrusted-content source display labels, over the ingress vocabulary in
 * `server/lib/untrustedContentSources.js` (#7680).
 *
 * The two lists are re-exported from the server leaf rather than copied, so a
 * source the server screens is always offered by the Abuse Guard panel. A
 * source missing from the panel is stuck on the shipped defaults with no way
 * to reach its policy, which is how `stacker-news` shipped screened but
 * unconfigurable. The label map below is client-only presentation.
 */
export { PRIVATE_UNTRUSTED_CONTENT_SOURCES, UNTRUSTED_CONTENT_SOURCES } from '../../../server/lib/untrustedContentSources.js';

export const UNTRUSTED_CONTENT_SOURCE_LABELS = Object.freeze({
  'github-issue': 'GitHub issues',
  'github-pr': 'GitHub pull requests',
  'stacker-news': 'Stacker News',
  messages: 'Messages',
  email: 'Email',
  imessage: 'iMessage',
  signal: 'Signal',
});
