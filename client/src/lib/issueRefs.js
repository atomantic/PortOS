/**
 * Bare forge issue references in rendered markdown — the `#7640` a CoS agent
 * writes in its own completion summary — turned into clickable links.
 *
 * The agent is not asked to build the link: it has no reliable way to know the
 * forge host, and a hand-built URL would be one more thing to get wrong. The
 * run record already carries `agent.metadata.repoIssueUrl`, the tracker base
 * the server resolved at spawn (`server/lib/workTracker.js#repoIssueUrlBase`,
 * where the app's own `workTracker` pin settles a self-hosted forge). So this
 * module appends a number and holds NO forge knowledge — no host parsing, no
 * GitHub-vs-GitLab classification, nothing that could disagree with the server.
 *
 * Render-time only: nothing is rewritten on disk, so a record from before the
 * stamp shipped renders the plain text it always did.
 *
 * Pure and React-free — it returns segments, and the caller
 * (`components/cos/MarkdownOutput.jsx`) decides what an anchor looks like.
 */

// A reference is `#` plus an issue number, and the pattern is built to DECLINE
// rather than mislink — a wrong link is followed, a missing one is merely read.
//
// The lookbehind rejects the contexts where a `#` is part of something else: a
// word character (`v1.2.3#4`, `abc#1`), another `#` (`##2`), an entity's `&`
// (`&#123;`), a path or URL separator (`server/lib/foo.js#12`, `.../pull/7#9`),
// a hyphen (`utf-8#3`), and the `:`/`=` that introduce a compact CSS or
// attribute value (`color:#336`) — transcripts of work in a styled repo print
// those routinely.
//
// The number itself must not lead with a zero and runs at most five digits,
// which is what separates a citation from the rest of the hex colors (`#000`,
// `#336699`, `#12345678`) that survive the lookbehind. A six-digit issue is
// beyond any tracker PortOS links to, and declining one costs a link; linking a
// colour costs a reader a 404 they were told was an issue.
//
// A qualified `owner/repo#12` is deliberately NOT matched: the stamped base
// names one repository and cannot be retargeted at another, so the honest
// outcome is plain text rather than a same-numbered issue in the wrong repo.
// No extra rule is needed: the `#` in `slashdo#12` follows a word character,
// which the lookbehind already rejects.
const ISSUE_REF_RE = /(?<![\w#&/:=-])#([1-9]\d{0,4})(?!\w)/g;

/**
 * Split plain text into literal strings and issue references.
 *
 * The caller must hand this text that is already OUTSIDE code spans, links, and
 * image syntax: in markdown, a `#7640` in a code span is a literal, and one
 * inside an existing `[…](…)` already has a destination.
 *
 * @param {string} text
 * @param {string|null|undefined} issueUrlBase — `agent.metadata.repoIssueUrl`
 * @returns {Array<string | { ref: string, url: string }>} a single-element
 *   array holding `text` unchanged when there is no tracker to resolve
 *   against, or nothing in the text to link.
 */
export function splitIssueRefs(text, issueUrlBase) {
  // `indexOf` before the regex: the overwhelming majority of text runs in a
  // rendered transcript contain no `#` at all, and this path runs per run, per
  // re-render, on every streamed frame.
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
 * The `linkifyText` resolver for one CoS run, or null when the run predates the
 * `repoIssueUrl` stamp (its markdown then renders as plain text, unchanged).
 *
 * Lives here so every surface that renders a run's prose — the summary, the
 * transcript, the task description, the completion toast — is one line rather
 * than its own copy of "read the metadata, close over the base".
 *
 * @param {{metadata?: {repoIssueUrl?: string|null}}|null} agent
 * @returns {((text: string) => Array<string | { ref: string, url: string }>) | null}
 */
export function agentIssueLinkifier(agent) {
  const base = agent?.metadata?.repoIssueUrl;
  return base ? (text) => splitIssueRefs(text, base) : null;
}
