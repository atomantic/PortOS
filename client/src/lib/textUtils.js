// Mirror of server/lib/textUtils.js — the client-side home for the RegExp
// escape. Partial by design: only `escapeRegExp` is mirrored, because it is the
// only member the browser bundle has a caller for. `countWords` already mirrors
// through `client/src/utils/formatters.js`, and `trimTo`/`kebabCase` have no
// client caller — adding them here would ship dead bytes and invite drift on
// helpers nothing checks. The server copy is authoritative; the parity pin in
// `server/lib/textUtils.test.js` is the contract.
//
// It exists because the browser cannot import from `server/`, so before this
// module every client caller re-inlined the character class — the exact rot the
// server-side guard closed on its own tree (#5790). That guard now scans
// `client/src` too, so a fresh private copy on this side fails the suite.

/**
 * Escape a string for literal use inside a RegExp.
 *
 * This is the ONE client copy — import it, never re-inline the character class.
 *
 * Non-string input is coerced rather than throwing, matching the server: the
 * callers escape user-supplied tokens (LoRA trigger words, canon character
 * names, ⌘K queries) on the way into `new RegExp(...)`, where a TypeError would
 * blank a rendered surface instead of simply not matching.
 */
export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
