/**
 * Bare forge issue references in rendered markdown (a CoS agent's `#7640`) turned into clickable links.
 *
 * The base comes from `agent.metadata.repoIssueUrl` (resolved at spawn by
 * `server/lib/workTracker.js#repoIssueUrlBase`), so this module holds NO forge knowledge. Render-time only, pure and React-free: the caller (`components/cos/MarkdownOutput.jsx`) renders the anchor.
 */

// A reference is `#` plus an issue number, built to DECLINE rather than mislink (a wrong link is followed, a missing one is merely read). The lookbehind rejects a `#` that is part of something else:
// a word character (`abc#1`), another `#`, an entity's `&` (`&#123;`), a path/URL separator (`foo.js#12`, `/pull/7#9`), a hyphen, or `:`/`=` (`color:#336`).
// The number must not lead with zero and runs at most five digits, which separates a citation from hex colors (`#000`, `#336699`); declining a six-digit issue costs a link, linking a colour costs a 404.
// A qualified `owner/repo#12` is NOT matched (the stamped base names one repository); `slashdo#12` is already rejected by the word-character lookbehind.
const ISSUE_REF_RE = /(?<![\w#&/:=-])#([1-9]\d{0,4})(?!\w)/g;

/**
 * Split plain text into literal strings and issue references. The caller must hand text already OUTSIDE code spans, links and image syntax (a `#7640` in a code span is literal; one inside `[…](…)` has a destination).
 * @param {string|null|undefined} issueUrlBase — `agent.metadata.repoIssueUrl`
 * @returns {Array<string | { ref: string, url: string }>} one element holding `text` unchanged when there is no tracker or nothing to link
 */
export function splitIssueRefs(text, issueUrlBase) {
  // `indexOf` before the regex: most text runs contain no `#` and this runs per run on every streamed frame.
  if (!issueUrlBase || typeof text !== 'string' || !text.includes('#')) return [text];
  const base = issueUrlBase.replace(/\/+$/, '');
  const parts = [];
  let last = 0;
  let m;
  ISSUE_REF_RE.lastIndex = 0;
  while ((m = ISSUE_REF_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push({ ref: m[0], url: `${base}/${m[1]}` });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/**
 * The `linkifyText` resolver for one CoS run, or null when the run predates the `repoIssueUrl` stamp (its markdown renders as plain text). Lives here so every surface rendering a run's prose is one line.
 * @returns {((text: string) => Array<string | { ref: string, url: string }>) | null}
 */
export function agentIssueLinkifier(agent) {
  const base = agent?.metadata?.repoIssueUrl;
  return base ? (text) => splitIssueRefs(text, base) : null;
}
