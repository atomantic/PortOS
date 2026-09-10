import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./meatspacePostLlm.js', () => ({
  callAI: vi.fn(),
  parseJsonFromAI: vi.fn(),
}));

import { callAI, parseJsonFromAI } from './meatspacePostLlm.js';
import { RHETORIC_RUBRICS } from '../lib/postRhetoric.js';
import { evaluateRhetoricAttempt } from './meatspacePostRhetoric.js';

describe('evaluateRhetoricAttempt', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a validated report with provider/model/effort provenance', async () => {
    callAI.mockResolvedValue({ text: '{}', providerId: 'example-provider', model: 'example-model' });
    parseJsonFromAI.mockReturnValue({
      overallScore: 84,
      dimensions: RHETORIC_RUBRICS.meter.map(({ id }) => ({ id, score: 84, feedback: 'A concrete observation.' })),
      summary: 'A strong attempt with a clear image.',
    });

    const result = await evaluateRhetoricAttempt({
      attemptId: 'round-1:1',
      mode: 'meter',
      prompt: 'Write a line about an empty train station.',
      response: 'The last train sighs softly through the rain.',
      providerId: 'example-provider',
      model: 'example-model',
      effort: 'high',
    });

    expect(result).toMatchObject({
      attemptId: 'round-1:1',
      mode: 'meter',
      evaluation: {
        overallScore: 84,
        provenance: {
          rubricVersion: 'rhetoric-evaluator-v1',
          providerId: 'example-provider',
          model: 'example-model',
          effort: 'high',
        },
      },
    });
    expect(callAI).toHaveBeenCalledWith(
      expect.stringContaining('The last train sighs softly through the rain.'),
      'example-provider',
      'example-model',
      'high',
      'meatspace-post-rhetoric-evaluator',
    );
    expect(parseJsonFromAI).toHaveBeenCalledWith(
      '{}',
      expect.any(Function),
      expect.stringContaining('Return ONLY valid JSON'),
    );
  });
});
