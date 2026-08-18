import { describe, it, expect } from 'vitest';
import {
  parseStatus,
  parseDiffStat,
  parseBranchVerboseLine,
  parseSubmoduleStatusLine,
  SUBMODULE_STATUS_RE,
  extractAgentSummary,
  isBenignConcurrentFetchRefRace
} from './gitOutputParsers.js';

describe('parseStatus', () => {
  it('maps known porcelain codes to labels', () => {
    expect(parseStatus('??')).toBe('untracked');
    expect(parseStatus('A ')).toBe('added');
    expect(parseStatus('M ')).toBe('modified (staged)');
    expect(parseStatus(' M')).toBe('modified');
    expect(parseStatus('MM')).toBe('modified (partial)');
    expect(parseStatus('D ')).toBe('deleted (staged)');
    expect(parseStatus(' D')).toBe('deleted');
    expect(parseStatus('R ')).toBe('renamed');
    expect(parseStatus('C ')).toBe('copied');
    expect(parseStatus('AM')).toBe('added (modified)');
    expect(parseStatus('AD')).toBe('added (deleted)');
  });

  it('falls back to the trimmed code for unmapped combinations', () => {
    expect(parseStatus('UU')).toBe('UU');
    expect(parseStatus(' R')).toBe('R');
  });
});

describe('parseDiffStat', () => {
  it('extracts files/insertions/deletions from the summary line', () => {
    const out = ' file.js | 3 +-\n 1 file changed, 2 insertions(+), 1 deletion(-)';
    expect(parseDiffStat(out)).toEqual({ files: 1, insertions: 2, deletions: 1 });
  });

  it('handles plural and singular grammar', () => {
    const out = ' 5 files changed, 10 insertions(+), 4 deletions(-)';
    expect(parseDiffStat(out)).toEqual({ files: 5, insertions: 10, deletions: 4 });
  });

  it('defaults missing pieces to 0', () => {
    expect(parseDiffStat(' 1 file changed, 3 insertions(+)')).toEqual({ files: 1, insertions: 3, deletions: 0 });
    expect(parseDiffStat('')).toEqual({ files: 0, insertions: 0, deletions: 0 });
    expect(parseDiffStat(null)).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });
});

describe('parseBranchVerboseLine', () => {
  it('parses a current branch with ahead/behind tracking', () => {
    expect(parseBranchVerboseLine('*|main|origin/main|ahead 2, behind 1')).toEqual({
      name: 'main', current: true, tracking: 'origin/main', ahead: 2, behind: 1
    });
  });

  it('parses a non-current branch with no tracking', () => {
    expect(parseBranchVerboseLine(' |feature||')).toEqual({
      name: 'feature', current: false, tracking: null, ahead: 0, behind: 0
    });
  });

  it('parses ahead-only and behind-only tracking', () => {
    expect(parseBranchVerboseLine(' |dev|origin/dev|ahead 3')).toMatchObject({ ahead: 3, behind: 0 });
    expect(parseBranchVerboseLine(' |dev|origin/dev|behind 4')).toMatchObject({ ahead: 0, behind: 4 });
  });
});

describe('parseSubmoduleStatusLine', () => {
  it('parses up-to-date, out-of-sync, and uninitialized lines', () => {
    expect(parseSubmoduleStatusLine(' abc1234 lib/slashdo (heads/main)')).toEqual({
      statusChar: ' ', commit: 'abc1234', path: 'lib/slashdo'
    });
    expect(parseSubmoduleStatusLine('+abc1234 lib/slashdo (heads/main)')).toMatchObject({ statusChar: '+' });
    expect(parseSubmoduleStatusLine('-abc1234 lib/slashdo')).toMatchObject({ statusChar: '-' });
    expect(parseSubmoduleStatusLine('Uabc1234 lib/slashdo')).toMatchObject({ statusChar: 'U' });
  });

  it('returns null for non-matching lines', () => {
    expect(parseSubmoduleStatusLine('')).toBeNull();
    expect(parseSubmoduleStatusLine('not a submodule line')).toBeNull();
  });

  it('exports the underlying regex', () => {
    expect(SUBMODULE_STATUS_RE).toBeInstanceOf(RegExp);
  });
});

describe('extractAgentSummary', () => {
  it('returns null for short output', () => {
    expect(extractAgentSummary(null)).toBeNull();
    expect(extractAgentSummary('')).toBeNull();
    expect(extractAgentSummary('too short')).toBeNull();
  });

  it('extracts trailing summary after last tool-call line', () => {
    const output = [
      'Investigating the bug.',
      '🔧 Using Read tool',
      '  → /path/to/file.js',
      '',
      'Implemented the fix by adding the missing null check on line 42.',
      'All tests pass: 187/187.'
    ].join('\n');

    const summary = extractAgentSummary(output);
    expect(summary).toContain('Implemented the fix');
    expect(summary).toContain('All tests pass');
    expect(summary).not.toContain('🔧');
  });

  it('strips leading "## Summary" heading so the PR body does not double it up', () => {
    const output = [
      '🔧 Using Edit tool',
      '  → /path/to/file.js',
      '',
      '## Summary',
      '',
      'Added a Run Backup Now button and default-exclusions display.',
      'All tests pass.'
    ].join('\n');

    const summary = extractAgentSummary(output);
    expect(summary).not.toMatch(/^#{1,6}?\s*summary/i);
    expect(summary?.split('\n')[0]).toContain('Added a Run Backup Now button');
  });

  it('strips leading "Summary:" (no markdown prefix) too', () => {
    const output = [
      '🔧 Using Edit tool',
      '  → /path/to/file.js',
      '',
      'Summary:',
      '',
      'Added a Run Backup Now button and default-exclusions display.',
      'All tests pass.'
    ].join('\n');

    const summary = extractAgentSummary(output);
    expect(summary?.split('\n')[0]).toContain('Added a Run Backup Now button');
  });

  // Regression: PR #3191 shipped with "📟 TUI session started: … (codex …)" as the
  // first three lines of its description. A TUI agent's output.txt has no tool-call
  // artifacts at all, so the old backwards walk found no boundary and kept the whole
  // buffer — lifecycle telemetry included.
  it('drops TUI lifecycle telemetry and keeps only the sentinel summary', () => {
    const output = [
      '📟 TUI session started: 92356307 (codex --dangerously-bypass-approvals-and-sandbox --model gpt-5.6-terra)',
      '💡 Open the Shell tab for live TUI output — this panel only logs lifecycle events.',
      '📟 Prompt pasted into TUI session 92356307 (ready)',
      '✅ Agent signaled completion',
      '## Summary',
      'Rendered malware scan reports inside PortOS.',
      '## Changes',
      '- Added a deep-linkable Brain scan-report page.',
    ].join('\n');

    const summary = extractAgentSummary(output);
    expect(summary).not.toContain('TUI session started');
    expect(summary).not.toContain('Open the Shell tab');
    expect(summary).not.toContain('Prompt pasted');
    expect(summary).not.toContain('Agent signaled completion');
    expect(summary?.split('\n')[0]).toBe('Rendered malware scan reports inside PortOS.');
    expect(summary).toContain('## Changes');
  });

  it('drops mid-run lifecycle warnings that precede the completion marker', () => {
    const output = [
      '📟 TUI session started: abc12345 (codex)',
      '⚠️ Paste verification failed — prompt text not found in buffer, retrying in 5000ms',
      '⏳ Max runtime reached — asking the agent to wrap up',
      '✅ Agent signaled completion',
      'Fixed the scan-report route so deep links resolve to the SPA.',
    ].join('\n');

    const summary = extractAgentSummary(output);
    expect(summary).toBe('Fixed the scan-report route so deep links resolve to the SPA.');
  });

  // The sentinel is appended verbatim and nothing else writes after it, so a
  // summary is free to use emoji-led checklist lines of its own — stripping any
  // emoji-prefixed line would delete the agent's actual words, and a summary made
  // mostly of them could fall under the minimum length and lose the body entirely.
  it('keeps the agent\'s own emoji checklist lines inside the sentinel summary', () => {
    const output = [
      '📟 TUI session started: abc12345 (codex)',
      '💡 Open the Shell tab for live TUI output — this panel only logs lifecycle events.',
      '✅ Agent signaled completion',
      'Reworked the exporter so every frame lands in the atlas.',
      '✅ Tests passed (1,204 server, 5,298 client)',
      '⚠️ Known limitation: the legacy 8-frame atlas is not resampled.',
    ].join('\n');

    const summary = extractAgentSummary(output);
    expect(summary).toContain('✅ Tests passed (1,204 server, 5,298 client)');
    expect(summary).toContain('⚠️ Known limitation: the legacy 8-frame atlas is not resampled.');
    expect(summary).not.toContain('TUI session started');
    expect(summary).not.toContain('Open the Shell tab');
  });

  // A short summary built entirely of emoji-led lines is exactly the case a bare
  // emoji-prefix filter would erase — it would fall under the 30-char floor and
  // return null, sending the PR body to the commit-message fallback.
  it('does not erase a summary composed of emoji-led lines', () => {
    const output = [
      '📟 TUI session started: abc12345 (codex)',
      '✅ Agent signaled completion',
      '✅ Fixed the crash on empty tag lists',
      '✅ Added a regression test for it',
    ].join('\n');

    expect(extractAgentSummary(output)).toBe(
      '✅ Fixed the crash on empty tag lists\n✅ Added a regression test for it'
    );
  });

  it('drops telemetry when a TUI agent finished without writing a sentinel', () => {
    const output = [
      '📟 TUI session started: abc12345 (codex --model gpt-5.6-terra)',
      '💡 Open the Shell tab for live TUI output — this panel only logs lifecycle events.',
      '📟 Prompt pasted into TUI session abc12345 (ready)',
      'Rewired the exporter so every frame lands in the atlas rather than the first eight.',
    ].join('\n');

    expect(extractAgentSummary(output)).toBe(
      'Rewired the exporter so every frame lands in the atlas rather than the first eight.'
    );
  });

  it('finds the completion marker even when the sentinel summary runs past the 4000-char tail', () => {
    const filler = 'x'.repeat(5000);
    const output = [
      '📟 TUI session started: abc12345 (codex)',
      '✅ Agent signaled completion',
      'Reworked the exporter so every frame lands in the atlas.',
      filler,
    ].join('\n');

    const summary = extractAgentSummary(output);
    expect(summary?.split('\n')[0]).toBe('Reworked the exporter so every frame lands in the atlas.');
    expect(summary).not.toContain('TUI session started');
  });

  it.each([
    ['## Branch', 'cos/task-example/agent-example'],
    ['## PR', 'https://example.com/org/repo/pull/1'],
  ])('drops the trailing "%s" section the sentinel template asks for', (heading, value) => {
    const output = [
      '✅ Agent signaled completion',
      '## Summary',
      'Wrapped Brain Link tags so they no longer scroll horizontally on mobile.',
      heading,
      value,
    ].join('\n');

    const summary = extractAgentSummary(output);
    expect(summary).toBe('Wrapped Brain Link tags so they no longer scroll horizontally on mobile.');
  });

  it('leaves a non-TUI streamed summary on the tool-call walk', () => {
    const output = [
      '🔧 Using Edit tool',
      '  → /path/to/file.js',
      '',
      'Reworked the retry backoff so a wedged provider is reaped instead of spun on.',
    ].join('\n');

    expect(extractAgentSummary(output)).toBe(
      'Reworked the retry backoff so a wedged provider is reaped instead of spun on.'
    );
  });
});

describe('isBenignConcurrentFetchRefRace', () => {
  // Verbatim shape of a real lost compare-and-swap: another fetch against the
  // same .git advanced origin/main to f485411 — exactly what this fetch wanted
  // to write — between this one reading f538668 and updating the ref.
  const raced = [
    "error: cannot lock ref 'refs/remotes/origin/main': is at f485411c6fcc274d9c298f0476ef91990748ad0a but expected f538668661cc298c15abeb6cf78e886b71eae623",
    'From github.com:example/example',
    ' ! f538668..f485411  main       -> origin/main  (unable to update local ref)',
    ' * [new branch]      claim/issue-1234 -> origin/claim/issue-1234'
  ].join('\n');

  it('treats a ref already holding the fetched value as success', () => {
    expect(isBenignConcurrentFetchRefRace(raced)).toBe(true);
  });

  it('accepts the forced-update spelling of the paired line', () => {
    expect(isBenignConcurrentFetchRefRace([
      "error: cannot lock ref 'refs/remotes/origin/main': is at f485411c6fcc274d9c298f0476ef91990748ad0a but expected f538668661cc298c15abeb6cf78e886b71eae623",
      ' ! f538668...f485411  main       -> origin/main  (forced update) (unable to update local ref)'
    ].join('\n'))).toBe(true);
  });

  it('rejects a ref left at a value the fetch did not want', () => {
    // Local rollback, not a concurrent fetch: the ref sits at some third commit,
    // so the fetch genuinely did not achieve its goal.
    expect(isBenignConcurrentFetchRefRace([
      "error: cannot lock ref 'refs/remotes/origin/main': is at 9999999999999999999999999999999999999999 but expected f538668661cc298c15abeb6cf78e886b71eae623",
      ' ! f538668..f485411  main       -> origin/main  (unable to update local ref)'
    ].join('\n'))).toBe(false);
  });

  it('rejects a locked ref with no paired line to confirm the intended value', () => {
    expect(isBenignConcurrentFetchRefRace(
      "error: cannot lock ref 'refs/remotes/origin/main': is at f485411c6fcc274d9c298f0476ef91990748ad0a but expected f538668661cc298c15abeb6cf78e886b71eae623"
    )).toBe(false);
  });

  it('rejects plain index.lock contention so it still retries', () => {
    expect(isBenignConcurrentFetchRefRace(
      "fatal: Unable to create '/repo/.git/index.lock': File exists."
    )).toBe(false);
  });

  it('does not swallow a real failure riding alongside the race', () => {
    expect(isBenignConcurrentFetchRefRace(`${raced}\nfatal: could not read from remote repository`))
      .toBe(false);
  });

  it('checks every locked ref, not just the first', () => {
    expect(isBenignConcurrentFetchRefRace([
      "error: cannot lock ref 'refs/remotes/origin/main': is at f485411c6fcc274d9c298f0476ef91990748ad0a but expected f538668661cc298c15abeb6cf78e886b71eae623",
      "error: cannot lock ref 'refs/remotes/origin/release': is at 9999999999999999999999999999999999999999 but expected 1111111111111111111111111111111111111111",
      ' ! f538668..f485411  main       -> origin/main  (unable to update local ref)',
      ' ! 1111111..2222222  release    -> origin/release  (unable to update local ref)'
    ].join('\n'))).toBe(false);
  });

  it('returns false for empty or clean output', () => {
    expect(isBenignConcurrentFetchRefRace('')).toBe(false);
    expect(isBenignConcurrentFetchRefRace(undefined)).toBe(false);
    expect(isBenignConcurrentFetchRefRace('From github.com:example/example\n * [new branch] x -> origin/x')).toBe(false);
  });
});
