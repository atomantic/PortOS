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
});
