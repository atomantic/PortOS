import { describe, it, expect } from 'vitest';
import { extractFinalSummary } from './agentSummaryExtraction.js';
import { LIFECYCLE_LINES } from '../../lib/agent/agentOutputMarkers.js';

describe('sentinel summary precedence', () => {
  it.each(['Thinking: I will now run /simplify.', 'tokens used\n123\nEarlier assistant reply.'])(
    'renders the latest completion summary instead of transcript content: %s', (transcript) => {
      const summary = '## Summary\nFixed the reported bug.\n\nDocumented `✅ Agent signaled completion` behavior.\n✅ Tests passed';
      const output = [
        '✅ Agent signaled completion',
        'An earlier completion attempt.',
        transcript,
        '✅ Agent signaled completion',
        summary,
        LIFECYCLE_LINES.shellTabHint(),
      ].join('\n');
      expect(extractFinalSummary(output)).toBe(summary);
    }
  );
});

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
