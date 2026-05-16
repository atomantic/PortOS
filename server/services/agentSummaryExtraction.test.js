import { describe, it, expect } from 'vitest';
import { extractFinalSummary, extractSimplifySummaries } from './agentLifecycle.js';

describe('extractFinalSummary', () => {
  it('returns the last block of non-tool text', () => {
    const output = [
      'Let me read the code.',
      '🔧 Using Read...',
      '  → …/services/cos.js',
      'Found the bug. Here is the fix:',
      '- Fixed null check on line 42',
      '- Added error handling',
    ].join('\n');
    expect(extractFinalSummary(output)).toBe(
      'Found the bug. Here is the fix:\n- Fixed null check on line 42\n- Added error handling'
    );
  });

  it('returns null for empty output', () => {
    expect(extractFinalSummary('')).toBeNull();
    expect(extractFinalSummary(null)).toBeNull();
  });

  it('extracts only the assistant tail from Codex output, ignoring earlier diff/exec dumps', () => {
    const output = [
      'server/services/imageGen/codex.test.js:300:    // diff',
      'server/services/imageGen/codex.test.js:307:    // more diff',
      'exec',
      'codex',
      'I am about to make changes.',
      'apply patch',
      'patch: completed',
      'diff --git a/foo.js b/foo.js',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'tokens used',
      '285,345',
      'Implemented the TUI provider path.',
      '- New `type: "tui"` provider support.',
      '- New PTY-backed runner.',
    ].join('\n');

    expect(extractFinalSummary(output)).toBe(
      'Implemented the TUI provider path.\n- New `type: "tui"` provider support.\n- New PTY-backed runner.'
    );
  });

  it('handles legacy Codex inline "tokens used: <n>" format', () => {
    const output = [
      'codex',
      'doing stuff',
      'apply patch',
      '+added',
      'tokens used: 12345',
      'Final assistant reply line 1.',
      'Final assistant reply line 2.',
    ].join('\n');

    expect(extractFinalSummary(output)).toBe(
      'Final assistant reply line 1.\nFinal assistant reply line 2.'
    );
  });
});

describe('extractSimplifySummaries', () => {
  it('splits output at the /simplify boundary', () => {
    const output = [
      'Let me investigate.',
      '🔧 Using Read...',
      '  → …/services/cos.js',
      'Fixed the bug. Here is what I did:',
      '- Fixed null check',
      '- Added validation',
      'Now let me run `/simplify` as instructed.',
      '🔧 Using Skill...',
      '  → simplify',
      'All three reviews confirm the code is clean.',
      '- No DRY violations',
      '- No issues found',
    ].join('\n');

    const result = extractSimplifySummaries(output);
    expect(result).not.toBeNull();
    expect(result.taskSummary).toBe(
      'Fixed the bug. Here is what I did:\n- Fixed null check\n- Added validation'
    );
    expect(result.simplifySummary).toBe(
      'All three reviews confirm the code is clean.\n- No DRY violations\n- No issues found'
    );
  });

  it('returns null when no /simplify marker is found', () => {
    const output = 'Just a regular agent output.\nNo simplify here.';
    expect(extractSimplifySummaries(output)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(extractSimplifySummaries('')).toBeNull();
    expect(extractSimplifySummaries(null)).toBeNull();
  });

  it('handles /simplify marker at the beginning with no pre-summary', () => {
    const output = [
      'Now running `/simplify` review.',
      '🔧 Using Read...',
      'Code is clean.',
    ].join('\n');

    const result = extractSimplifySummaries(output);
    // No task summary before the marker
    expect(result.taskSummary).toBeNull();
    expect(result.simplifySummary).toBe('Code is clean.');
  });

  it('treats Codex output as a single task summary (no /simplify split, even if the diff quotes /simplify)', () => {
    // Mirrors the agent-5f6951e3 regression: Codex dumps source code that
    // contains both "/simplify" and a "run" verb on the same line. The old
    // logic split there and serialized 9000+ lines of grep output as the
    // task summary.
    const output = [
      'server/services/cos.js:1596:9. Run `/simplify` to review changed code.',
      'client/src/components/cos/tabs/AgentCard.jsx:697: title="Will run /simplify before committing">',
      'exec',
      'apply patch',
      'diff --git a/foo b/foo',
      '+something',
      'tokens used',
      '12000',
      'Implemented the requested change.',
      '- Did X.',
      '- Did Y.',
    ].join('\n');

    const result = extractSimplifySummaries(output);
    expect(result).toEqual({
      taskSummary: 'Implemented the requested change.\n- Did X.\n- Did Y.',
      simplifySummary: null
    });
  });

  it('matches various /simplify narration patterns', () => {
    const patterns = [
      'Now let me run `/simplify` as instructed.',
      'Now running `/simplify` as required by the instructions:',
      'Let me now launch /simplify to review.',
    ];
    for (const line of patterns) {
      const output = `Task done.\n${line}\nClean code.`;
      const result = extractSimplifySummaries(output);
      expect(result).not.toBeNull();
      expect(result.taskSummary).toBe('Task done.');
      expect(result.simplifySummary).toBe('Clean code.');
    }
  });
});
