// Pure parsers for git / CLI command output. No child-process or filesystem
// access — these turn the text git prints into structured data. The
// orchestration that actually runs git lives in server/services/git.js.

import { safeJSONParse } from './jsonIo.js';
import { SENTINEL_COMPLETION_MARKER, stripLifecycleLines } from './agentOutputMarkers.js';

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

// Only completed, explicitly final assistant records are authoritative. Tool
// payloads and intermediate assistant messages can contain report-like text.
function structuredFinalResponse(output) {
  let final = null;
  for (const line of output.split('\n')) {
    if (!line.trimStart().startsWith('{')) continue;
    const record = safeJSONParse(line);
    if (!record) continue;
    const message = record.type === 'response_item' ? record.payload : record;
    if (message?.type === 'message' && message.role === 'assistant' && message.phase === 'final_answer'
      && Array.isArray(message.content)) {
      final = message.content.filter(part => part.type === 'output_text' && typeof part.text === 'string')
        .map(part => part.text).join('\n');
    } else if (record.type === 'result' && record.subtype === 'success' && record.is_error !== true
      && typeof record.result === 'string') {
      final = record.result;
    }
  }
  return final;
}

// Strip terminal accounting without treating a number in a Markdown report as
// telemetry. Counts belong to the immediately preceding standalone footer.
const TRANSCRIPT_ACCOUNTING_RE = /^\s*(?:Chunk ID:|Wall time:|Process exited with code|Original token count:|Total output lines:|Output:|Final output:)/i;

function stripTokenAccounting(lines) {
  return lines.filter((line, index) => !TRANSCRIPT_ACCOUNTING_RE.test(line) && !/^\s*tokens used(?:\s*:\s*[\d,.]+)?\s*$/i.test(line)
    && !(index > 0 && /^\s*tokens used\s*$/i.test(lines[index - 1]) && /^\s*[\d,.]+\s*$/.test(line)));
}

/**
 * Extract a meaningful implementation summary from raw agent output.
 *
 * Two shapes reach this:
 *   - A TUI agent's `output.txt`, which is lifecycle telemetry plus the
 *     `.agent-done` sentinel summary ingested behind
 *     `SENTINEL_COMPLETION_MARKER`. When that marker is present, the agent's
 *     summary is what follows it — nothing before it was ever the agent
 *     talking, so the tool-line walk must not be allowed to reach back into it.
 *   - A CLI agent's explicit final-response record or Codex assistant segment.
 *     Unstructured output falls back to the summary after the last tool artifact.
 *
 * Either way, PortOS-authored lifecycle status lines are dropped: they are
 * telemetry for the agent card, and a PR body that opens with
 * "📟 TUI session started: …" is noise the reviewer has to scroll past.
 *
 * @param {string} output - Raw agent output
 * @returns {string|null} Cleaned summary text, or null if nothing usable
 */
export function extractAgentSummary(output) {
  if (typeof output !== 'string' || !output) return null;

  // Anchor on the completion marker when the agent wrote a sentinel; otherwise
  // fall back to the last ~4000 chars, where a streamed summary typically lives.
  // The marker is searched in the FULL output, not the tail — a long sentinel
  // summary can itself run past 4000 chars and push the marker out of the window.
  const markerIdx = output.lastIndexOf(SENTINEL_COMPLETION_MARKER);
  const structured = markerIdx < 0 ? structuredFinalResponse(output) : null;
  // Codex's plain transcript labels each assistant segment with `codex` and
  // puts the final reply on either side of its token footer, depending on CLI
  // version. Anchor on the last segment before considering generic tool output.
  const codexIdx = markerIdx < 0 && structured === null ? output.lastIndexOf('\ncodex\n') : -1;
  const anchored = markerIdx >= 0 || structured !== null || codexIdx >= 0;
  const region = markerIdx >= 0
    ? output.slice(markerIdx + SENTINEL_COMPLETION_MARKER.length)
    : structured ?? (codexIdx >= 0 ? output.slice(codexIdx + '\ncodex\n'.length) : output.slice(-4000));
  const lines = region.split('\n');
  // A tail cut mid-line leaves a fragment no lifecycle shape can recognize.
  if (!anchored && output.length > 4000 && lines.length > 1) lines.shift();

  let summaryLines;
  if (anchored) {
    // Anchored assistant text preserves Markdown, even a quoted diff or command.
    // Past a sentinel marker, a Merge Gate re-prompt (#5876) appends its own line after it and reopens the run, so a
    // run that never writes a second sentinel ends with that line and any
    // nudges after it. The strip matches PortOS's own message shapes only, so
    // an agent's "✅ Tests passed" survives it.
    summaryLines = stripLifecycleLines(lines);
  } else {
    // Find the last tool-call artifact line index.
    // Everything after it is the agent's final summary.
    let lastToolLine = -1;
    let inDiff = false;
    let fence = null;
    let toolBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();
      if (toolBlock && !/^tokens used(?:\s*:\s*[\d,.]+)?\s*$/i.test(trimmed)) {
        if (trimmed) { lastToolLine = i; continue; }
        toolBlock = false;
      }
      if (/^tokens used\b/i.test(trimmed)) toolBlock = false;
      const fenceMarker = trimmed.match(/^(`{3,}|~{3,})/);
      if (fenceMarker) {
        if (!fence) fence = fenceMarker[1];
        else if (fenceMarker[1][0] === fence[0] && fenceMarker[1].length >= fence.length) fence = null;
        inDiff = false;
        continue;
      }
      if (fence) continue;
      if (/^tokens used(?:\s*:\s*[\d,.]+)?\s*$/i.test(trimmed)) {
        const countLine = /^\s*[\d,.]+\s*$/.test(lines[i + 1] ?? '') ? i + 1 : i;
        if (stripTokenAccounting(lines.slice(countLine + 1)).join('\n').trim().length >= 30) lastToolLine = countLine;
        continue;
      }
      const record = trimmed.startsWith('{') ? safeJSONParse(trimmed) : null;
      const diffHeader = /^(diff --git |index [0-9a-f]+\.\.|--- |\+\+\+ |@@ |\\ No newline)/.test(lines[i]);
      // Raw added/removed source has no space after its prefix. Markdown lists
      // (`+ item`, `- item`) are retained outside an identified unified diff.
      const diffLine = /^[+-]\S/.test(lines[i]) || (inDiff && /^[ +\-]/.test(lines[i]));
      if (diffHeader || diffLine) {
        inDiff = true;
        lastToolLine = i;
      } else {
        inDiff = false;
        if (/^\s*\$ /.test(lines[i]) || /^(exec|Output:|Final output:)\s*$/i.test(trimmed)) toolBlock = true;
        if (TRANSCRIPT_ACCOUNTING_RE.test(trimmed) || trimmed.startsWith('→') || trimmed.startsWith('🔧') || /^\s*\$ /.test(lines[i])
          || /^(exec|apply patch|patch: completed|codex)\s*$/i.test(trimmed)
          || /^(response_item|item\.|turn\.|result$|assistant$|system$)/.test(record?.type ?? '')
          || /^.*(?:succeeded|exited \d+) in .*:$/.test(trimmed)) {
          lastToolLine = i;
        }
      }
    }
    summaryLines = lastToolLine >= 0 ? lines.slice(lastToolLine + 1) : lines;
    // No marker: a TUI agent that finished without writing a sentinel (idle-
    // complete) leaves a buffer of pure telemetry, which would otherwise become
    // the whole PR body. Drop the lines PortOS is known to emit.
    summaryLines = stripLifecycleLines(summaryLines);
  }

  // A structured final response contains assistant text, not terminal footers.
  if (structured === null) summaryLines = stripTokenAccounting(summaryLines);

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

  // Drop a trailing "## Branch" / "## PR" section. The sentinel template asks for
  // one so a human reading the agent card knows where the work landed — but in a
  // PR description the forge already shows the head branch, and a "## PR" section
  // is a link to the very page you're reading.
  const tailIdx = summaryLines.findIndex(l => /^\s*(#{1,6}\s*)?(branch|pr)\s*:?\s*$/i.test(l));
  if (tailIdx >= 0) {
    summaryLines = summaryLines.slice(0, tailIdx);
    while (summaryLines.length && !summaryLines[summaryLines.length - 1].trim()) summaryLines.pop();
  }

  const summary = summaryLines.join('\n').trim();

  // Must have meaningful content (at least a sentence)
  if (summary.length < 30) return null;

  return summary;
}

// A ref-update failure git reports as
//   error: cannot lock ref '<ref>': is at <current> but expected <expected>
// This is NOT lock contention (no `.lock` file was in the way) — it is a failed
// compare-and-swap: git read <expected> when the fetch began, and by the time it
// went to write the ref another process had already moved it to <current>.
const CANNOT_LOCK_REF_RE =
  /cannot lock ref '([^']+)':\s*is at ([0-9a-f]+) but expected ([0-9a-f]+)/gi;

// The paired per-ref line in `git fetch` output naming the value the fetch WANTED
// to write:  ` ! <old>..<new>  <src> -> <dst>  (unable to update local ref)`
// `..` for a fast-forward, `...` for a forced update. Any other parenthetical
// git annotates the line with is skipped rather than assumed absent.
const UNABLE_TO_UPDATE_REF_RE =
  /^\s*!\s+([0-9a-f]+)\.{2,3}([0-9a-f]+)\s+\S+\s+->\s+(\S+)\s+(?:\([^)]*\)\s*)*\(unable to update local ref\)/gim;

/** Two object names refer to the same commit when either abbreviates the other. */
function sameObject(a, b) {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * True when a `git fetch` failure is ONLY the benign "someone else already
 * fetched this" race: every ref git could not lock already holds exactly the
 * value this fetch was trying to write, so the fetch's goal is satisfied and
 * the local remote-tracking refs are correct.
 *
 * PortOS hits this constantly because several writers share one `.git`: the Git
 * tab's update button (`updateBranches` → `fetchOrigin`), the same tab's remote
 * branch list (`getRemoteBranches` → `git fetch origin --prune`), and every CoS
 * agent worktree. When two fetches overlap, the loser reports a non-zero exit
 * for work the winner already completed.
 *
 * Retrying that is the wrong remedy — the ref is already correct, so a retry
 * spends another full network fetch to discover there is nothing to do, and on
 * a busy repo (agents pushing branches) every attempt can lose the same race and
 * surface a red error for a fetch that actually succeeded. Callers treat a true
 * return as success instead. Distinguishing "already applied by another writer"
 * from "failed" is the sentinel-and-validate rule in AGENTS.md.
 *
 * Deliberately strict — it returns false, leaving the existing retry/throw path
 * in charge, when:
 *   - there is no compare-and-swap failure at all (plain `index.lock` contention),
 *   - a locked ref's current value is NOT what the fetch wanted (e.g. the ref was
 *     rolled back locally), so the fetch genuinely did not achieve its goal,
 *   - a locked ref has no paired `(unable to update local ref)` line to confirm
 *     the intended value against, or
 *   - the output carries any other `error:`/`fatal:` line, so a real failure
 *     riding alongside the race is never swallowed.
 *
 * @param {string} stderr - Combined stderr from `git fetch`
 * @returns {boolean}
 */
export function isBenignConcurrentFetchRefRace(stderr) {
  if (!stderr) return false;

  const locked = [...stderr.matchAll(CANNOT_LOCK_REF_RE)]
    .map(([, ref, current]) => ({ ref, current }));
  if (!locked.length) return false;

  // Intended value per ref, keyed on the short `origin/main` form git prints in
  // the `!` line as well as on the full `refs/remotes/origin/main` the lock error
  // names, so either spelling resolves.
  const intended = new Map();
  for (const [, , next, dst] of stderr.matchAll(UNABLE_TO_UPDATE_REF_RE)) {
    intended.set(dst, next);
    intended.set(`refs/remotes/${dst}`, next);
  }

  const everyRefAlreadyCorrect = locked.every(({ ref, current }) => {
    const want = intended.get(ref) ?? intended.get(ref.replace(/^refs\/remotes\//, ''));
    return sameObject(current, want);
  });
  if (!everyRefAlreadyCorrect) return false;

  // Any diagnostic that is not one of the two lines this race produces means
  // something else also went wrong — defer to the caller's error handling.
  // Uses a non-global copy: `.test()` on a /g regex advances its lastIndex and
  // would skip every other line.
  const casLine = new RegExp(CANNOT_LOCK_REF_RE.source, 'i');
  return !stderr.split('\n').some(
    line => /^\s*(error|fatal):/i.test(line) && !casLine.test(line)
  );
}
