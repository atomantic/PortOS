/**
 * The untrusted-content ingress vocabulary.
 *
 * Its own leaf so the browser can import it: `untrustedContent.js` reaches
 * `zod` and, through `modelAbuseGuard.js`, `node:crypto`, and the settings
 * panel needs nothing but these two lists. A source the server screens but
 * the panel never offers is stuck on the shipped defaults forever — its
 * `classifierMode`, limits and provider pin are all unreachable — which is
 * exactly how `stacker-news` was screened but unconfigurable (#7680). One
 * definition, imported by both sides, makes that drift impossible rather
 * than merely tested for.
 */

// Channel names identify ingress, never a trust decision made by a model.
export const UNTRUSTED_CONTENT_SOURCES = Object.freeze(['github-issue', 'github-pr', 'stacker-news', 'messages', 'email', 'imessage', 'signal']);
export const PRIVATE_UNTRUSTED_CONTENT_SOURCES = Object.freeze(['messages', 'email', 'imessage', 'signal']);
