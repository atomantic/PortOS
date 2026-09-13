/**
 * Deterministic pre-LLM gate for a pull-request diff.
 *
 * The model-abuse boundary (`modelAbuseGuard.js`) screens EXTERNAL pull
 * requests before their text reaches a reviewer model. This module is the
 * same class of check applied to the other half of the review process: our own
 * branches, scanned from the diff itself, with no provider call and no
 * classifier install. It answers one question — does this change add content a
 * human reviewer cannot see but a model (or a runtime) would read?
 *
 * Three shapes qualify:
 *   - invisible / direction-control Unicode in an added line, which renders as
 *     nothing on GitHub while carrying text to any model reading the diff;
 *   - a cluster of the invisible characters the rules otherwise exempt, which
 *     is how a payload hides inside sequences that are individually ordinary;
 *   - a compressed or otherwise opaque encoded blob (base64 / hex) added to a
 *     text file, where the bytes a reviewer approves are not the bytes that
 *     run.
 *
 * Pure: the caller owns reading the diff and deciding what a finding means.
 */

import { describeEncodedPayload, hiddenCodePointSummary, invisibleClusterSummary } from './modelAbuseGuard.js';

/**
 * Opt-out marker, honored on the line it appears on.
 *
 * A few files legitimately hold these bytes: a zero-width space deliberately
 * inserted to break a markdown fence, a bidi-mark character class, a
 * PowerShell BOM. The marker is visible, greppable and reviewable, so the
 * exemption shows up in the same diff a human reads — which is what makes it
 * safe on OUR branches. It is deliberately not honored on the external-PR path
 * (`modelAbuseGuard.js`), where the author is not trusted to grant it.
 */
export const HIDDEN_CONTENT_ALLOW_MARKER = 'portos-allow-hidden-content';

/**
 * Paths whose added lines are machine-generated encoded data by definition.
 * These lines skip the ENCODED-PAYLOAD rule only — never the invisible-Unicode
 * ones. Deliberately tiny: every entry is a hole, so it lists lockfiles and
 * nothing else.
 */
const ENCODED_DATA_PATH_RE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|uv\.lock)$/;

/**
 * Scan one added line. A line can be both invisible and encoded, and a
 * reviewer should hear about both. `encoded` is off for the paths whose added
 * lines are machine-generated encoded data — the invisible-Unicode rules still
 * apply there, because a poisoned package name in a lockfile is exactly the
 * kind of thing a skip list must not hide.
 */
function scanAddedLine(line, { encoded = true } = {}) {
  const findings = [];
  const hidden = hiddenCodePointSummary(line);
  if (hidden) {
    findings.push({
      category: 'hidden-unicode',
      detail: `contains invisible or direction-control Unicode (${hidden}) that renders as nothing to a human reader`,
    });
  }
  const cluster = hidden ? null : invisibleClusterSummary(line);
  if (cluster) {
    findings.push({ category: 'hidden-unicode-cluster', detail: `concentrates invisible characters (${cluster}) densely enough to carry data no reader sees` });
  }
  const payload = encoded ? describeEncodedPayload(line) : null;
  if (payload) findings.push({ category: 'encoded-payload', detail: payload });
  return findings;
}

const OLD_FILE_HEADER = '--- ';
const NEW_FILE_HEADER = '+++ ';
const parseFilePath = (line) => {
  const path = line.slice(4).trim();
  if (path === '/dev/null') return null;
  return path.startsWith('b/') ? path.slice(2) : path;
};

// `@@ -a,b +c,d @@` — the new-file start line is what a finding is reported at.
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const BOM_PREFIX_RE = /^\uFEFF/;

/**
 * Scan a unified diff for content that hides from the human reviewing it.
 *
 * Only ADDED lines are scanned: a finding must be something this change
 * introduces, or the gate fires forever on whatever the repository already
 * holds — and a branch that DELETES such a line would fail for removing it.
 * Findings never quote the offending text, because a finding is displayed in a
 * terminal and in CI logs, and quoting invisible bytes back would only move
 * them somewhere else.
 */
export function scanDiffForHiddenContent(diff) {
  if (typeof diff !== 'string' || !diff) return [];
  const findings = [];
  let path = null;
  let encoded = true;
  let lineNumber = 0;

  let afterOldFileHeader = false;
  for (const raw of diff.split('\n')) {
    // Only a `+++ ` line that follows the `--- ` line is a file header — an
    // added line inside a diff-of-a-diff starts with the same characters.
    const isFileHeader = afterOldFileHeader && raw.startsWith(NEW_FILE_HEADER);
    afterOldFileHeader = raw.startsWith(OLD_FILE_HEADER);
    if (isFileHeader) {
      path = parseFilePath(raw);
      encoded = !(path && ENCODED_DATA_PATH_RE.test(path));
      lineNumber = 0;
      continue;
    }
    const hunk = raw.match(HUNK_RE);
    if (hunk) {
      lineNumber = Number(hunk[1]);
      continue;
    }
    if (!raw.startsWith('+')) {
      if (raw.startsWith(' ')) lineNumber += 1;
      continue;
    }
    const line = raw.slice(1);
    const current = lineNumber;
    lineNumber += 1;
    if (!path || line.includes(HIDDEN_CONTENT_ALLOW_MARKER)) continue;
    // A byte-order mark is only meaningful as the first character of a file,
    // where several Windows shells require it; anywhere else it is hiding.
    const scannable = current === 1 ? line.replace(BOM_PREFIX_RE, '') : line;
    for (const finding of scanAddedLine(scannable, { encoded })) {
      findings.push({ ...finding, path, line: current });
    }
  }
  return findings;
}

/** One human-readable line per finding, for a CI log or a terminal. */
export function formatHiddenContentFindings(findings) {
  return findings.map((finding) => `${finding.path}:${finding.line} — ${finding.category}: ${finding.detail}`);
}
