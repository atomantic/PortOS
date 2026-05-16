import { describe, it, expect } from 'vitest';
import { extractCodexAssistant, extractCodexAssistantTail } from './codexAssistantExtract.js';

describe('extractCodexAssistant', () => {
  it('returns text unchanged when there is no Codex banner', () => {
    const claudeOutput = 'Here is the comic script:\n\n## Page 1\n\nPanel 1...';
    expect(extractCodexAssistant(claudeOutput)).toBe(claudeOutput);
  });

  it('carves out the assistant reply between the prompt echo and the token footer', () => {
    const full = `OpenAI Codex v0.128.0 (research preview)
--------
workdir: /repo
model: gpt-5
provider: openai
--------
user
# Pipeline — Comic-Book Script

You are a comics writer...

Return ONLY the script.

codex
# Issue 1 — The Harvest Market

## Page 1

### Panel 1
**Description:** Wide establishing shot...

tokens used: 12345
`;
    const out = extractCodexAssistant(full);
    expect(out.startsWith('# Issue 1 — The Harvest Market')).toBe(true);
    expect(out).not.toContain('OpenAI Codex v');
    expect(out).not.toContain('You are a comics writer');
    expect(out).not.toContain('tokens used');
  });

  it('handles missing token-stats footer (response runs to EOF)', () => {
    const full = `OpenAI Codex v0.125.0 (research preview)
--------
workdir: /repo
--------
user
prompt body

codex
The assistant reply with no trailing token line.`;
    const out = extractCodexAssistant(full);
    expect(out).toBe('The assistant reply with no trailing token line.');
  });

  it('returns input untouched when the `codex` marker is missing (truncated run)', () => {
    const truncated = `OpenAI Codex v0.125.0 (research preview)
--------
workdir: /repo
--------
user
prompt body`;
    expect(extractCodexAssistant(truncated)).toBe(truncated);
  });

  it('returns empty / non-string input unchanged', () => {
    expect(extractCodexAssistant('')).toBe('');
    expect(extractCodexAssistant(null)).toBe(null);
    expect(extractCodexAssistant(undefined)).toBe(undefined);
  });
});

describe('extractCodexAssistantTail', () => {
  it('returns the message that follows the last "tokens used" footer', () => {
    const output = [
      'exec',
      'apply patch',
      'diff --git a/foo b/foo',
      '+something',
      'tokens used',
      '285,345',
      'Final assistant summary.',
      '- bullet one',
    ].join('\n');
    expect(extractCodexAssistantTail(output)).toBe('Final assistant summary.\n- bullet one');
  });

  it('handles inline "tokens used: <n>" with the summary on the next line', () => {
    const output = [
      'apply patch',
      '+added',
      'tokens used: 12345',
      'Inline-format reply.',
    ].join('\n');
    expect(extractCodexAssistantTail(output)).toBe('Inline-format reply.');
  });

  it('returns null when the output is not Codex (no markers)', () => {
    const output = 'Some Claude-style narration.\n🔧 Using Read...\nFinal note.';
    expect(extractCodexAssistantTail(output)).toBeNull();
  });

  it('returns null for empty or non-string input', () => {
    expect(extractCodexAssistantTail('')).toBeNull();
    expect(extractCodexAssistantTail(null)).toBeNull();
    expect(extractCodexAssistantTail(undefined)).toBeNull();
  });

  it('returns null when Codex markers exist but no tail follows the last "tokens used"', () => {
    const output = 'apply patch\npatch: completed\ndiff --git a/x b/x\ntokens used\n123\n';
    expect(extractCodexAssistantTail(output)).toBeNull();
  });
});
