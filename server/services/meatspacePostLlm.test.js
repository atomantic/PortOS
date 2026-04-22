import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock providers before importing the module
vi.mock('./providers.js', () => ({
  getActiveProvider: vi.fn(),
  getProviderById: vi.fn()
}));

import { getActiveProvider, getProviderById } from './providers.js';
import {
  LLM_DRILL_TYPES,
  generateLlmDrill,
  generateWordAssociation,
  generateStoryRecall,
  generateVerbalFluency,
  generateWitComeback,
  generatePunWordplay,
  scoreLlmDrill
} from './meatspacePostLlm.js';

// Helper: mock an API provider that returns a given JSON string
function mockApiProvider(responseJson) {
  const provider = {
    id: 'test-provider',
    enabled: true,
    type: 'api',
    endpoint: 'http://localhost:9999',
    apiKey: 'test-key',
    defaultModel: 'test-model'
  };
  getActiveProvider.mockResolvedValue(provider);
  getProviderById.mockResolvedValue(provider);

  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({
      choices: [{ message: { content: JSON.stringify(responseJson) } }]
    })
  });

  return provider;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// CONSTANTS
// =============================================================================

describe('LLM_DRILL_TYPES', () => {
  it('exports all 14 drill types', () => {
    expect(LLM_DRILL_TYPES).toEqual([
      'word-association',
      'story-recall',
      'verbal-fluency',
      'wit-comeback',
      'pun-wordplay',
      'compound-chain',
      'bridge-word',
      'double-meaning',
      'idiom-twist',
      'what-if',
      'alternative-uses',
      'story-prompt',
      'invention-pitch',
      'reframe',
    ]);
  });
});

// =============================================================================
// WORD ASSOCIATION
// =============================================================================

describe('generateWordAssociation', () => {
  it('returns word-association drill with questions', async () => {
    mockApiProvider({ questions: [
      { prompt: 'cathedral', hints: 'architecture' },
      { prompt: 'river', hints: 'nature' },
      { prompt: 'silence', hints: 'abstract' }
    ]});

    const result = await generateWordAssociation({ count: 3 });
    expect(result.type).toBe('word-association');
    expect(result.config.count).toBe(3);
    expect(result.questions).toHaveLength(3);
    expect(result.questions[0]).toHaveProperty('prompt', 'cathedral');
    expect(result.questions[0]).toHaveProperty('hints', 'architecture');
  });

  it('defaults count to 5', async () => {
    mockApiProvider({ questions: Array.from({ length: 5 }, (_, i) => ({ prompt: `word${i}` })) });
    const result = await generateWordAssociation({});
    expect(result.config.count).toBe(5);
  });

  it('slices to count limit', async () => {
    mockApiProvider({ questions: Array.from({ length: 10 }, (_, i) => ({ prompt: `word${i}` })) });
    const result = await generateWordAssociation({ count: 3 });
    expect(result.questions).toHaveLength(3);
  });

  it('defaults hints to empty string', async () => {
    mockApiProvider({ questions: [{ prompt: 'test' }] });
    const result = await generateWordAssociation({ count: 1 });
    expect(result.questions[0].hints).toBe('');
  });
});

// =============================================================================
// STORY RECALL
// =============================================================================

describe('generateStoryRecall', () => {
  it('returns story-recall drill with exercises', async () => {
    mockApiProvider({ exercises: [
      { paragraph: 'A story about Jane...', questions: [{ question: 'Who?', answer: 'Jane' }] }
    ]});

    const result = await generateStoryRecall({ count: 1 });
    expect(result.type).toBe('story-recall');
    expect(result.config.count).toBe(1);
    expect(result.exercises).toHaveLength(1);
    expect(result.exercises[0].paragraph).toBe('A story about Jane...');
    expect(result.exercises[0].questions[0].answer).toBe('Jane');
  });

  it('defaults count to 3', async () => {
    mockApiProvider({ exercises: Array.from({ length: 3 }, () => ({ paragraph: 'p', questions: [] })) });
    const result = await generateStoryRecall({});
    expect(result.config.count).toBe(3);
  });
});

// =============================================================================
// VERBAL FLUENCY
// =============================================================================

describe('generateVerbalFluency', () => {
  it('returns verbal-fluency drill with categories', async () => {
    mockApiProvider({ categories: [
      { category: 'Animals', minExpected: 15, examples: ['dog', 'cat'] }
    ]});

    const result = await generateVerbalFluency({ count: 1 });
    expect(result.type).toBe('verbal-fluency');
    expect(result.config.count).toBe(1);
    expect(result.categories).toHaveLength(1);
    expect(result.categories[0].category).toBe('Animals');
  });

  it('defaults count to 3', async () => {
    mockApiProvider({ categories: Array.from({ length: 3 }, () => ({ category: 'X', minExpected: 10, examples: [] })) });
    const result = await generateVerbalFluency({});
    expect(result.config.count).toBe(3);
  });
});

// =============================================================================
// WIT & COMEBACK
// =============================================================================

describe('generateWitComeback', () => {
  it('returns wit-comeback drill with scenarios', async () => {
    mockApiProvider({ scenarios: [
      { setup: 'Your friend says...', context: 'at dinner', difficulty: 'medium' }
    ]});

    const result = await generateWitComeback({ count: 1 });
    expect(result.type).toBe('wit-comeback');
    expect(result.config.count).toBe(1);
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0].setup).toBe('Your friend says...');
    expect(result.scenarios[0].difficulty).toBe('medium');
  });

  it('defaults count to 5', async () => {
    mockApiProvider({ scenarios: Array.from({ length: 5 }, () => ({ setup: 'x', context: '', difficulty: 'easy' })) });
    const result = await generateWitComeback({});
    expect(result.config.count).toBe(5);
  });
});

// =============================================================================
// PUN & WORDPLAY
// =============================================================================

describe('generatePunWordplay', () => {
  it('returns pun-wordplay drill with challenges', async () => {
    mockApiProvider({ challenges: [
      { type: 'pun-topic', prompt: 'Make a pun about cats', topic: 'cats', example: 'purr-fect' }
    ]});

    const result = await generatePunWordplay({ count: 1 });
    expect(result.type).toBe('pun-wordplay');
    expect(result.config.count).toBe(1);
    expect(result.challenges).toHaveLength(1);
    expect(result.challenges[0].topic).toBe('cats');
  });

  it('defaults count to 5', async () => {
    mockApiProvider({ challenges: Array.from({ length: 5 }, () => ({ type: 'pun-topic', prompt: 'x', topic: 'y', example: 'z' })) });
    const result = await generatePunWordplay({});
    expect(result.config.count).toBe(5);
  });
});

// =============================================================================
// generateLlmDrill ROUTER
// =============================================================================

describe('generateLlmDrill', () => {
  it('routes to correct generator for each type', async () => {
    mockApiProvider({ questions: [{ prompt: 'test' }] });
    const wa = await generateLlmDrill('word-association', { count: 1 });
    expect(wa.type).toBe('word-association');

    mockApiProvider({ exercises: [{ paragraph: 'p', questions: [] }] });
    const sr = await generateLlmDrill('story-recall', { count: 1 });
    expect(sr.type).toBe('story-recall');

    mockApiProvider({ categories: [{ category: 'X', minExpected: 10, examples: [] }] });
    const vf = await generateLlmDrill('verbal-fluency', { count: 1 });
    expect(vf.type).toBe('verbal-fluency');

    mockApiProvider({ scenarios: [{ setup: 'x', context: '', difficulty: 'easy' }] });
    const wc = await generateLlmDrill('wit-comeback', { count: 1 });
    expect(wc.type).toBe('wit-comeback');

    mockApiProvider({ challenges: [{ type: 'pun-topic', prompt: 'x', topic: 'y', example: 'z' }] });
    const pw = await generateLlmDrill('pun-wordplay', { count: 1 });
    expect(pw.type).toBe('pun-wordplay');
  });

  it('returns null for unknown type', async () => {
    const result = await generateLlmDrill('unknown-type');
    expect(result).toBeNull();
  });
});

// =============================================================================
// LLM SCORING
// =============================================================================

describe('scoreLlmDrill', () => {
  it('returns score with evaluation for word-association', async () => {
    mockApiProvider({
      overallScore: 75,
      scores: [{ score: 80, feedback: 'Good associations' }],
      summary: 'Solid performance'
    });

    const result = await scoreLlmDrill(
      'word-association',
      { questions: [{ prompt: 'cathedral', hints: '' }] },
      [{ response: 'church spire gothic', responseMs: 3000 }],
      120000
    );

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.evaluation.overallScore).toBe(75);
    expect(result.questions[0].llmScore).toBe(80);
    expect(result.questions[0].llmFeedback).toBe('Good associations');
  });

  it('combines quality (80%) and speed bonus (20%)', async () => {
    mockApiProvider({
      overallScore: 100,
      scores: [{ score: 100, feedback: 'Perfect' }],
      summary: 'Perfect'
    });

    // Fast response: 1s out of 120s limit -> high speed bonus
    const fast = await scoreLlmDrill(
      'word-association',
      { questions: [{ prompt: 'test' }] },
      [{ response: 'answer', responseMs: 1000 }],
      120000
    );

    mockApiProvider({
      overallScore: 100,
      scores: [{ score: 100, feedback: 'Perfect' }],
      summary: 'Perfect'
    });

    // Slow response: 119s out of 120s -> near-zero speed bonus
    const slow = await scoreLlmDrill(
      'word-association',
      { questions: [{ prompt: 'test' }] },
      [{ response: 'answer', responseMs: 119000 }],
      120000
    );

    expect(fast.score).toBeGreaterThan(slow.score);
  });

  it('clamps score between 0 and 100', async () => {
    mockApiProvider({
      overallScore: 150,
      scores: [{ score: 200, feedback: 'Over max' }],
      summary: 'Overcapped'
    });

    const result = await scoreLlmDrill(
      'word-association',
      { questions: [{ prompt: 'test' }] },
      [{ response: 'answer', responseMs: 1000 }],
      120000
    );

    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('returns score 0 for unknown drill type', async () => {
    const result = await scoreLlmDrill('unknown', {}, [], 60000);
    expect(result.score).toBe(0);
    expect(result.evaluation).toBeNull();
  });

  it('attaches per-response llmScore and llmFeedback', async () => {
    mockApiProvider({
      overallScore: 60,
      scores: [
        { score: 80, feedback: 'Clever' },
        { score: 40, feedback: 'Needs work' }
      ],
      summary: 'Mixed'
    });

    const result = await scoreLlmDrill(
      'wit-comeback',
      { scenarios: [{ setup: 'a' }, { setup: 'b' }] },
      [
        { response: 'zinger', responseMs: 2000 },
        { response: 'meh', responseMs: 5000 }
      ],
      120000
    );

    expect(result.questions).toHaveLength(2);
    expect(result.questions[0].llmScore).toBe(80);
    expect(result.questions[1].llmScore).toBe(40);
    expect(result.questions[1].llmFeedback).toBe('Needs work');
  });

  it('handles missing scores array gracefully', async () => {
    mockApiProvider({
      overallScore: 50,
      summary: 'No per-item scores'
    });

    const result = await scoreLlmDrill(
      'pun-wordplay',
      { challenges: [{ prompt: 'x' }] },
      [{ response: 'y', responseMs: 1000 }],
      120000
    );

    expect(result.questions[0].llmScore).toBeNull();
    expect(result.questions[0].llmFeedback).toBe('');
  });

  it('scores story-recall with answers', async () => {
    // story-recall uses local scoring: 1/1 correct = 100
    const result = await scoreLlmDrill(
      'story-recall',
      { exercises: [{ paragraph: 'Jane went to Paris on Monday.', questions: [{ question: 'Where?', answer: 'Paris' }] }] },
      [{ answers: ['Paris'], responseMs: 5000 }],
      180000
    );

    expect(result.score).toBeGreaterThan(0);
    expect(result.evaluation.overallScore).toBe(100);
  });

  it('scores verbal-fluency with items', async () => {
    // verbal-fluency uses local scoring: 10 unique items / 15 target = 67
    const result = await scoreLlmDrill(
      'verbal-fluency',
      { categories: [{ category: 'Animals', minExpected: 15, examples: ['dog'] }] },
      [{ items: ['dog', 'cat', 'fish', 'bird', 'snake', 'lion', 'tiger', 'bear', 'wolf', 'fox'], responseMs: 45000 }],
      60000
    );

    expect(result.score).toBeGreaterThan(0);
    expect(result.evaluation.overallScore).toBe(67);
  });

  it('compound-chain accepts both full compounds and the other half', async () => {
    // User-typed shorthand: "hose" instead of "firehose", "pit" instead of "firepit".
    // Both should count as valid compound contributions.
    const result = await scoreLlmDrill(
      'compound-chain',
      { challenges: [{ rootWord: 'fire', position: 'either', minExpected: 4, examples: ['firehose', 'firepit', 'firework', 'campfire'] }] },
      [{ items: ['hose', 'pit', 'work', 'campfire'], responseMs: 30000 }],
      60000
    );

    expect(result.evaluation.scores[0].validCount).toBe(4);
    expect(result.evaluation.scores[0].invalidItems).toEqual([]);
    // Examples already covered (either as full compound or half) shouldn't be re-suggested.
    expect(result.evaluation.scores[0].missedExamples).not.toContain('firehose');
    expect(result.evaluation.scores[0].missedExamples).not.toContain('firepit');
    expect(result.evaluation.scores[0].missedExamples).not.toContain('firework');
    expect(result.evaluation.scores[0].missedExamples).not.toContain('campfire');
  });

  it('compound-chain rejects bare root word', () => {
    return scoreLlmDrill(
      'compound-chain',
      { challenges: [{ rootWord: 'fire', position: 'either', minExpected: 2, examples: [] }] },
      [{ items: ['fire', 'firework'], responseMs: 10000 }],
      60000
    ).then(result => {
      expect(result.evaluation.scores[0].validCount).toBe(1);
      expect(result.evaluation.scores[0].invalidItems).toContain('fire');
    });
  });
});

// =============================================================================
// PROVIDER SELECTION
// =============================================================================

describe('provider selection', () => {
  it('uses active provider when no providerId given', async () => {
    mockApiProvider({ questions: [{ prompt: 'test' }] });
    await generateWordAssociation({ count: 1 });
    expect(getActiveProvider).toHaveBeenCalled();
  });

  it('uses specific provider when providerId given', async () => {
    mockApiProvider({ questions: [{ prompt: 'test' }] });
    await generateWordAssociation({ count: 1 }, 'specific-provider');
    expect(getProviderById).toHaveBeenCalledWith('specific-provider');
  });

  it('throws when no provider is available', async () => {
    getActiveProvider.mockResolvedValue(null);
    await expect(generateWordAssociation({ count: 1 })).rejects.toThrow('No AI provider available');
  });

  it('throws when provider is disabled', async () => {
    getActiveProvider.mockResolvedValue({ id: 'test', enabled: false, type: 'api' });
    await expect(generateWordAssociation({ count: 1 })).rejects.toThrow('No AI provider available');
  });
});

// =============================================================================
// JSON PARSING ROBUSTNESS
// =============================================================================

describe('AI response parsing', () => {
  it('handles markdown-fenced JSON', async () => {
    const provider = {
      id: 'test', enabled: true, type: 'api',
      endpoint: 'http://localhost:9999', defaultModel: 'test'
    };
    getActiveProvider.mockResolvedValue(provider);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: '```json\n{"questions":[{"prompt":"hello"}]}\n```' } }]
      })
    });

    const result = await generateWordAssociation({ count: 1 });
    expect(result.questions[0].prompt).toBe('hello');
  });

  it('handles JSON with surrounding text', async () => {
    const provider = {
      id: 'test', enabled: true, type: 'api',
      endpoint: 'http://localhost:9999', defaultModel: 'test'
    };
    getActiveProvider.mockResolvedValue(provider);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'Here is the result:\n{"questions":[{"prompt":"world"}]}\nHope this helps!' } }]
      })
    });

    const result = await generateWordAssociation({ count: 1 });
    expect(result.questions[0].prompt).toBe('world');
  });

  it('throws on empty AI response', async () => {
    const provider = {
      id: 'test', enabled: true, type: 'api',
      endpoint: 'http://localhost:9999', defaultModel: 'test'
    };
    getActiveProvider.mockResolvedValue(provider);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: '' } }]
      })
    });

    await expect(generateWordAssociation({ count: 1 })).rejects.toThrow();
  });
});
