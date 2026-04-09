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
