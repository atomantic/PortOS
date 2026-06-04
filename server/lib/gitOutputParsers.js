// Pure parsers for git / CLI command output. No child-process or filesystem
// access — these turn the text git prints into structured data. The
// orchestration that actually runs git lives in server/services/git.js.

/**
 * Map a 2-char porcelain status code to a human-readable label.
 * Falls back to the trimmed code for unmapped combinations.
 * @param {string} status - Two-character porcelain status (e.g. ' M', '??')
 * @returns {string}
 */
export function parseStatus(status) {
  const map = {
    '??': 'untracked',
    'A ': 'added',
    'M ': 'modified (staged)',
    ' M': 'modified',
    'MM': 'modified (partial)',
    'D ': 'deleted (staged)',
    ' D': 'deleted',
    'R ': 'renamed',
    'C ': 'copied',
    'AM': 'added (modified)',
    'AD': 'added (deleted)'
  };
  return map[status] || status.trim();
}

/**
 * Parse the summary line of `git diff --stat` into counts.
 * Accepts the full multi-line diff-stat output (or its trailing summary line)
 * and extracts files/insertions/deletions. Missing pieces default to 0.
 * @param {string} statOutput - Raw `git diff --stat` stdout
 * @returns {{ files: number, insertions: number, deletions: number }}
 */
export function parseDiffStat(statOutput) {
  const statsLine = (statOutput || '').trim().split('\n').pop() || '';
  const filesMatch = statsLine.match(/(\d+) files? changed/);
  const insertionsMatch = statsLine.match(/(\d+) insertions?/);
  const deletionsMatch = statsLine.match(/(\d+) deletions?/);
  return {
    files: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    insertions: insertionsMatch ? parseInt(insertionsMatch[1], 10) : 0,
    deletions: deletionsMatch ? parseInt(deletionsMatch[1], 10) : 0
  };
}

/**
 * Parse one line of the pipe-delimited
 * `git branch -vv --format=%(HEAD)|%(refname:short)|%(upstream:short)|%(upstream:track)`
 * output into a structured branch record.
 * @param {string} line
 * @returns {{ name: string, current: boolean, tracking: string|null, ahead: number, behind: number }}
 */
export function parseBranchVerboseLine(line) {
  const [head, name, upstream, track] = line.split('|');
  const aheadMatch = track?.match(/ahead (\d+)/);
  const behindMatch = track?.match(/behind (\d+)/);
  return {
    name,
    current: head === '*',
    tracking: upstream || null,
    ahead: aheadMatch ? parseInt(aheadMatch[1], 10) : 0,
    behind: behindMatch ? parseInt(behindMatch[1], 10) : 0
  };
}

export const SUBMODULE_STATUS_RE = /^([+ \-U])([0-9a-f]+)\s+(\S+)/;

/**
 * Parse one line of `git submodule status` into `{ statusChar, commit, path }`.
 * Returns null for lines that don't match the expected shape.
 * @param {string} line
 * @returns {{ statusChar: string, commit: string, path: string }|null}
 */
export function parseSubmoduleStatusLine(line) {
  const match = line.match(SUBMODULE_STATUS_RE);
  if (!match) return null;
  return { statusChar: match[1], commit: match[2], path: match[3] };
}

/**
 * Extract a meaningful implementation summary from raw agent output.
 * Agents typically end their output with a summary of what was implemented.
 * This function finds the last tool-call artifact in the tail of the output
 * and returns everything after it, cleaned up.
 * @param {string} output - Raw agent output
 * @returns {string|null} Cleaned summary text, or null if nothing usable
 */
export function extractAgentSummary(output) {
  if (!output || output.length < 50) return null;

  // Take the last ~4000 chars where the summary typically lives
  const tail = output.slice(-4000);
  const lines = tail.split('\n');

  // Find the last tool-call artifact line index.
  // Everything after it is the agent's final summary.
  let lastToolLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith('→') || trimmed.startsWith('🔧') || /^\s*\$ /.test(lines[i])) {
      lastToolLine = i;
      break;
    }
  }

  // Extract everything after the last tool line
  const summaryLines = lastToolLine >= 0
    ? lines.slice(lastToolLine + 1)
    : lines;

  // Trim leading/trailing blank lines
  while (summaryLines.length && !summaryLines[0].trim()) summaryLines.shift();
  while (summaryLines.length && !summaryLines[summaryLines.length - 1].trim()) summaryLines.pop();

  // Strip a leading "Summary" heading the agent may have written itself
  // (e.g. "## Summary", "# Summary", "Summary:"). Without this, the PR body
  // ends up with two stacked "Summary" headings — generatePRDescription wraps
  // the extracted text in its own "## Summary" section.
  while (summaryLines.length && /^\s*(#{1,6}\s*)?summary\s*:?\s*$/i.test(summaryLines[0])) {
    summaryLines.shift();
    while (summaryLines.length && !summaryLines[0].trim()) summaryLines.shift();
  }

  const summary = summaryLines.join('\n').trim();

  // Must have meaningful content (at least a sentence)
  if (summary.length < 30) return null;

  return summary;
}
