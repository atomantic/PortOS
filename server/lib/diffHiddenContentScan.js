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
 * Shapes that qualify:
 *   - invisible / direction-control Unicode in an added line, which renders as
 *     nothing on GitHub while carrying text to any model reading the diff;
 *   - the same code points in a filename, which the added-line walk never sees;
 *   - a cluster of the invisible characters the rules otherwise exempt, which
 *     is how a payload hides inside sequences that are individually ordinary;
 *   - a compressed or otherwise opaque encoded blob (base64 / hex) added to a
 *     text file, where the bytes a reviewer approves are not the bytes that
 *     run;
 *   - a new symlink whose target leaves the repository or names a secret path,
 *     or a new git submodule, which review as a path rather than as the bytes
 *     that would be read;
 *   - a non-media binary patch, whose bytes never appear in the diff at all;
 *   - an inline script or javascript: URL added to SVG/HTML/XML markup.
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

/** Categories the added-line Unicode/encoded walk cannot see from file contents. */
export const STRUCTURAL_HIDDEN_CONTENT_CATEGORIES = Object.freeze([
  'symlink-added',
  'gitlink-added',
  'opaque-binary',
  'inline-script',
]);

const SYMLINK_MODE = '120000';
const GITLINK_MODE = '160000';
const NEW_FILE_MODE_RE = /^new file mode (\d{6})$/;
const NEW_MODE_RE = /^new mode (\d{6})$/;
const BINARY_FILES_RE = /^Binary files (?:\/dev\/null|a\/.+) and (?:\/dev\/null|b\/(.+)) differ$/;
const GIT_BINARY_PATCH = 'GIT binary patch';
const MEDIA_PATH_RE = /\.(?:png|jpe?g|gif|webp|ico|bmp|woff2?|ttf|otf|eot|mp3|mp4|wav|ogg|webm|mov|pdf)$/i;
const MARKUP_PATH_RE = /\.(?:svg|html?|xhtml|xml)$/i;
const INLINE_SCRIPT_RE = /<script[\s>]|[\s"'=]javascript:/i;
const SENSITIVE_SYMLINK_RE = /(?:^|\/)(?:\.env(?:\..*)?|\.git(?:\/|$)|id_rsa|id_ed25519|id_ecdsa|\.npmrc|\.pypirc|credentials|\.aws|\.ssh)(?:\/|$)/i;

function parseGitDiffHeader(line) {
  if (!line.startsWith('diff --git ')) return null;
  const quoted = line.match(/^diff --git "a\/((?:\\.|[^"\\])*)" "b\/((?:\\.|[^"\\])*)"$/);
  if (quoted) return quoted[2].replace(/\\(.)/g, '$1');
  const plain = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  return plain ? plain[2] : null;
}

/**
 * Whether a symlink target is a review of a path, not of the bytes that would
 * be read: absolute, off-scheme, above the repository root, or a secret file.
 * Relative in-repo links (the slashdo command wrappers) stay clear.
 */
function symlinkTargetEscapesRepo(filePath, target) {
  if (typeof filePath !== 'string' || !filePath || typeof target !== 'string') return true;
  const trimmed = target.trim();
  if (!trimmed || trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.includes('://')) return true;
  if (SENSITIVE_SYMLINK_RE.test(trimmed)) return true;
  const dir = filePath.split('/').slice(0, -1);
  const stack = [];
  for (const part of [...dir, ...trimmed.split(/[\\/]/)]) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return true;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return SENSITIVE_SYMLINK_RE.test(stack.join('/'));
}

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
const noteFinding = (findings, path, line, category, detail) => {
  findings.push({ path: path || '(unknown path)', line, category, detail });
};

const scanPathForHiddenUnicode = (findings, path) => {
  const hidden = path && hiddenCodePointSummary(path);
  if (hidden) {
    noteFinding(findings, path, 1, 'hidden-unicode', `filename contains invisible or direction-control Unicode (${hidden}) that renders as nothing to a human reader`);
  }
};

export function scanDiffForHiddenContent(diff) {
  if (typeof diff !== 'string' || !diff) return [];
  const findings = [];
  let path = null;
  let encoded = true;
  let lineNumber = 0;
  let newMode = null;
  let isNewFile = false;
  let pathScanned = false;
  let sawAddedLine = false;

  let afterOldFileHeader = false;
  for (const raw of diff.split('\n')) {
    const gitPath = parseGitDiffHeader(raw);
    if (gitPath) {
      if (path && !pathScanned) scanPathForHiddenUnicode(findings, path);
      path = gitPath;
      encoded = !ENCODED_DATA_PATH_RE.test(path);
      lineNumber = 0;
      newMode = null;
      isNewFile = false;
      pathScanned = false;
      sawAddedLine = false;
      scanPathForHiddenUnicode(findings, path);
      pathScanned = true;
      continue;
    }
    const newFileMode = raw.match(NEW_FILE_MODE_RE);
    if (newFileMode) {
      newMode = newFileMode[1];
      isNewFile = true;
      continue;
    }
    const newModeMatch = raw.match(NEW_MODE_RE);
    if (newModeMatch) {
      newMode = newModeMatch[1];
      isNewFile = false;
      continue;
    }
    // Only a `+++ ` line that follows the `--- ` line is a file header — an
    // added line inside a diff-of-a-diff starts with the same characters.
    const isFileHeader = afterOldFileHeader && raw.startsWith(NEW_FILE_HEADER);
    afterOldFileHeader = raw.startsWith(OLD_FILE_HEADER);
    if (isFileHeader) {
      path = parseFilePath(raw) || path;
      encoded = !(path && ENCODED_DATA_PATH_RE.test(path));
      lineNumber = 0;
      if (path && !pathScanned) {
        scanPathForHiddenUnicode(findings, path);
        pathScanned = true;
      }
      continue;
    }
    const binaryPath = raw.match(BINARY_FILES_RE)?.[1] || (raw === GIT_BINARY_PATCH ? path : null);
    if (binaryPath || raw === GIT_BINARY_PATCH) {
      const binaryAt = binaryPath || path;
      if (binaryAt && !MEDIA_PATH_RE.test(binaryAt)) {
        noteFinding(findings, binaryAt, 1, 'opaque-binary', 'adds a non-media binary whose bytes never appear in the diff a reviewer reads');
      }
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
    if (path && !pathScanned) {
      scanPathForHiddenUnicode(findings, path);
      pathScanned = true;
    }
    if (!path || line.includes(HIDDEN_CONTENT_ALLOW_MARKER)) continue;
    if (!sawAddedLine) {
      sawAddedLine = true;
      if (newMode === SYMLINK_MODE && symlinkTargetEscapesRepo(path, line)) {
        noteFinding(findings, path, current, 'symlink-added', 'adds a symlink whose target leaves the repository or names a secret path, so the bytes a reviewer reads are not the bytes that would be opened');
      }
      if (newMode === GITLINK_MODE && isNewFile) {
        noteFinding(findings, path, current, 'gitlink-added', 'adds a git submodule, which reviews as a SHA rather than as the tree that SHA names');
      }
    }
    if (MARKUP_PATH_RE.test(path) && INLINE_SCRIPT_RE.test(line)) {
      noteFinding(findings, path, current, 'inline-script', 'adds an inline script or javascript: URL to markup that can run outside the reviewed source');
    }
    // A byte-order mark is only meaningful as the first character of a file,
    // where several Windows shells require it; anywhere else it is hiding.
    const scannable = current === 1 ? line.replace(BOM_PREFIX_RE, '') : line;
    for (const finding of scanAddedLine(scannable, { encoded })) {
      findings.push({ ...finding, path, line: current });
    }
  }
  if (path && !pathScanned) scanPathForHiddenUnicode(findings, path);
  return findings;
}

/** One human-readable line per finding, for a CI log or a terminal. */
export function formatHiddenContentFindings(findings) {
  return findings.map((finding) => `${finding.path}:${finding.line} — ${finding.category}: ${finding.detail}`);
}
