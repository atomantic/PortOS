import { describe, expect, it } from 'vitest';
import { analyzeAgentFailure } from './agentErrorAnalysis.js';

describe('analyzeAgentFailure', () => {
  it('classifies unsupported Codex model errors instead of matching prompt text', () => {
    const output = [
      'Global instructions:',
      'PortOS intentionally omits authentication in this deployment.',
      ...Array.from({ length: 220 }, (_, i) => `prompt line ${i}`),
      'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5\' model is not supported when using Codex with a ChatGPT account."}}'
    ].join('\n');

    const analysis = analyzeAgentFailure(output, { id: 'task-1' }, 'gpt-5');

    expect(analysis.category).toBe('model-not-supported');
    expect(analysis.message).toContain('gpt-5');
    expect(analysis.suggestedFix).toContain('provider model configuration');
  });

  it('classifies Claude extra-usage status as a usage-limit fallback condition', () => {
    const output = [
      'Claude Code starting...',
      ...Array.from({ length: 60 }, (_, i) => `setup line ${i}`),
      'Now using extra usage'
    ].join('\n');

    const analysis = analyzeAgentFailure(output, { id: 'task-2' }, 'claude-opus');

    expect(analysis.category).toBe('usage-limit');
    expect(analysis.requiresFallback).toBe(true);
    expect(analysis.suggestedFix).toContain('fallback provider');
  });

  it('does not classify ordinary prose about extra usage as a usage-limit fallback condition', () => {
    const output = [
      'The task failed while editing docs.',
      'The draft mentions extra usage examples in a billing section.',
      'Error: markdown validation failed'
    ].join('\n');

    const analysis = analyzeAgentFailure(output, { id: 'task-3' }, 'claude-opus');

    expect(analysis.category).not.toBe('usage-limit');
    expect(analysis.requiresFallback).toBeUndefined();
  });

  it('does not classify status-line prefixes as usage-limit fallback conditions', () => {
    const output = [
      'The task failed while editing docs.',
      'Now using extra usage examples in release notes',
      'Error: markdown validation failed'
    ].join('\n');

    const analysis = analyzeAgentFailure(output, { id: 'task-4' }, 'claude-opus');

    expect(analysis.category).not.toBe('usage-limit');
    expect(analysis.requiresFallback).toBeUndefined();
  });
});
