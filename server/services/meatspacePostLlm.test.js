import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock providers before importing the module
vi.mock('./providers.js', () => ({
  getActiveProvider: vi.fn(),
  getProviderById: vi.fn()
}));

// Mock the central LLM handler — meatspacePostLlm used to spawn child_process
// + fetch directly, but now delegates to runPromptThroughProvider. Runner
// internals (spawn args, --model flag injection) are covered by runner.test.js.
vi.mock('../lib/promptRunner.js', () => ({
assertProvider: (provider, { message, code, status = 503 } = {}) => {
    if (provider) return;
    const err = new Error(message || 'No AI provider available');
    if (code) { err.status = status; err.code = code; }
    throw err;
  },
  runPromptThroughProvider: vi.fn()
}));

import { getActiveProvider, getProviderById } from './providers.js';
import { runPromptThroughProvider } from '../lib/promptRunner.js';
import {
  LLM_DRILL_TYPES,
  generateLlmDrill,
  generateWordAssociation,
  generateStoryRecall,
  generateVerbalFluency,
  generateWitComeback,
  generatePunWordplay,
  generateCompoundChain,
  generateBridgeWord,
  generateDoubleMeaning,
  generateIdiomTwist,
  generateWhatIf,
  generateAlternativeUses,
  generateStoryPrompt,
  generateInventionPitch,
  generateReframe,
  scoreLlmDrill
} from './meatspacePostLlm.js';

// Helper: mock an API provider that returns a given JSON string. Sets the
// central handler to resolve with the stringified response — drills then
// parse it the same way they used to with a fetch-mocked API response.
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

  runPromptThroughProvider.mockResolvedValue({
    text: JSON.stringify(responseJson),
    runId: 'test-run',
    model: 'test-model'
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
// COMPOUND CHAIN
// =============================================================================

describe('generateCompoundChain', () => {
  it('returns compound-chain drill with challenges', async () => {
    mockApiProvider({ challenges: [
      { rootWord: 'paper', position: 'prefix', examples: ['paperback', 'paperweight'], minExpected: 8 }
    ]});

    const result = await generateCompoundChain({ count: 1 });
    expect(result.type).toBe('compound-chain');
    expect(result.config.count).toBe(1);
    expect(result.challenges).toHaveLength(1);
    expect(result.challenges[0].rootWord).toBe('paper');
    expect(result.challenges[0].position).toBe('prefix');
    expect(result.challenges[0].examples).toEqual(['paperback', 'paperweight']);
    expect(result.challenges[0].minExpected).toBe(8);
  });

  it('defaults count to 5', async () => {
    mockApiProvider({ challenges: Array.from({ length: 5 }, () => ({ rootWord: 'fire', position: 'both', examples: [], minExpected: 8 })) });
    const result = await generateCompoundChain({});
    expect(result.config.count).toBe(5);
  });

  it('defaults position, examples, and minExpected when absent', async () => {
    mockApiProvider({ challenges: [{ rootWord: 'light' }] });
    const result = await generateCompoundChain({ count: 1 });
    expect(result.challenges[0].position).toBe('both');
    expect(result.challenges[0].examples).toEqual([]);
    expect(result.challenges[0].minExpected).toBe(8);
  });
});

// =============================================================================
// BRIDGE WORD
// =============================================================================

describe('generateBridgeWord', () => {
  it('returns bridge-word drill with puzzles', async () => {
    mockApiProvider({ puzzles: [
      { clues: ['news___', '___back'], answer: 'paper', difficulty: 'easy', hint: 'You write on it' }
    ]});

    const result = await generateBridgeWord({ count: 1 });
    expect(result.type).toBe('bridge-word');
    expect(result.config.count).toBe(1);
    expect(result.puzzles).toHaveLength(1);
    expect(result.puzzles[0].clues).toEqual(['news___', '___back']);
    expect(result.puzzles[0].answer).toBe('paper');
    expect(result.puzzles[0].difficulty).toBe('easy');
    expect(result.puzzles[0].hint).toBe('You write on it');
  });

  it('defaults count to 5', async () => {
    mockApiProvider({ puzzles: Array.from({ length: 5 }, () => ({ clues: [], answer: 'x' })) });
    const result = await generateBridgeWord({});
    expect(result.config.count).toBe(5);
  });

  it('defaults clues, difficulty, and hint when absent', async () => {
    mockApiProvider({ puzzles: [{ answer: 'paper' }] });
    const result = await generateBridgeWord({ count: 1 });
    expect(result.puzzles[0].clues).toEqual([]);
    expect(result.puzzles[0].difficulty).toBe('medium');
    expect(result.puzzles[0].hint).toBe('');
  });
});

// =============================================================================
// DOUBLE MEANING
// =============================================================================

describe('generateDoubleMeaning', () => {
  it('returns double-meaning drill with challenges', async () => {
    mockApiProvider({ challenges: [
      { word: 'bark', meanings: ['tree covering', 'dog sound'], example: 'The bark of the dog echoed off the bark of the tree.', difficulty: 'easy' }
    ]});

    const result = await generateDoubleMeaning({ count: 1 });
    expect(result.type).toBe('double-meaning');
    expect(result.config.count).toBe(1);
    expect(result.challenges).toHaveLength(1);
    expect(result.challenges[0].word).toBe('bark');
    expect(result.challenges[0].meanings).toEqual(['tree covering', 'dog sound']);
    expect(result.challenges[0].difficulty).toBe('easy');
  });

  it('defaults count to 5', async () => {
    mockApiProvider({ challenges: Array.from({ length: 5 }, () => ({ word: 'x', meanings: [] })) });
    const result = await generateDoubleMeaning({});
    expect(result.config.count).toBe(5);
  });

  it('defaults example, difficulty, and meanings when absent', async () => {
    mockApiProvider({ challenges: [{ word: 'scale' }] });
    const result = await generateDoubleMeaning({ count: 1 });
    expect(result.challenges[0].meanings).toEqual([]);
    expect(result.challenges[0].example).toBe('');
    expect(result.challenges[0].difficulty).toBe('medium');
  });
});

// =============================================================================
// IDIOM TWIST
// =============================================================================

describe('generateIdiomTwist', () => {
  it('returns idiom-twist drill with challenges', async () => {
    mockApiProvider({ challenges: [
      { idiom: "Don't put all your eggs in one basket", domain: 'programming', example: "Don't push all your commits to one branch", difficulty: 'easy' }
    ]});

    const result = await generateIdiomTwist({ count: 1 });
    expect(result.type).toBe('idiom-twist');
    expect(result.config.count).toBe(1);
    expect(result.challenges).toHaveLength(1);
    expect(result.challenges[0].idiom).toBe("Don't put all your eggs in one basket");
    expect(result.challenges[0].domain).toBe('programming');
    expect(result.challenges[0].difficulty).toBe('easy');
  });

  it('defaults count to 5', async () => {
    mockApiProvider({ challenges: Array.from({ length: 5 }, () => ({ idiom: 'x', domain: 'y' })) });
    const result = await generateIdiomTwist({});
    expect(result.config.count).toBe(5);
  });

  it('defaults example and difficulty when absent', async () => {
    mockApiProvider({ challenges: [{ idiom: 'x', domain: 'y' }] });
    const result = await generateIdiomTwist({ count: 1 });
    expect(result.challenges[0].example).toBe('');
    expect(result.challenges[0].difficulty).toBe('medium');
  });
});

// =============================================================================
// WHAT IF
// =============================================================================

describe('generateWhatIf', () => {
  it('returns what-if drill with scenarios', async () => {
    mockApiProvider({ scenarios: [
      { prompt: 'What if gravity reversed for 10 minutes every Tuesday?', category: 'physics' }
    ]});

    const result = await generateWhatIf({ count: 1 });
    expect(result.type).toBe('what-if');
    expect(result.config.count).toBe(1);
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0].category).toBe('physics');
  });

  it('defaults count to 3', async () => {
    mockApiProvider({ scenarios: Array.from({ length: 3 }, () => ({ prompt: 'x', category: 'y' })) });
    const result = await generateWhatIf({});
    expect(result.config.count).toBe(3);
  });
});

// =============================================================================
// ALTERNATIVE USES
// =============================================================================

describe('generateAlternativeUses', () => {
  it('returns alternative-uses drill with objects', async () => {
    mockApiProvider({ objects: [
      { object: 'brick', commonUse: 'building material', minExpected: 8 }
    ]});

    const result = await generateAlternativeUses({ count: 1 });
    expect(result.type).toBe('alternative-uses');
    expect(result.config.count).toBe(1);
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0].object).toBe('brick');
    expect(result.objects[0].minExpected).toBe(8);
  });

  it('defaults count to 3', async () => {
    mockApiProvider({ objects: Array.from({ length: 3 }, () => ({ object: 'x', commonUse: 'y', minExpected: 5 })) });
    const result = await generateAlternativeUses({});
    expect(result.config.count).toBe(3);
  });
});

// =============================================================================
// STORY PROMPT
// =============================================================================

describe('generateStoryPrompt', () => {
  it('returns story-prompt drill with prompts', async () => {
    mockApiProvider({ prompts: [
      { words: ['lighthouse', 'saxophone', 'marmalade'] }
    ]});

    const result = await generateStoryPrompt({ count: 1 });
    expect(result.type).toBe('story-prompt');
    expect(result.config.count).toBe(1);
    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].words).toEqual(['lighthouse', 'saxophone', 'marmalade']);
  });

  it('defaults count to 3', async () => {
    mockApiProvider({ prompts: Array.from({ length: 3 }, () => ({ words: ['a', 'b', 'c'] })) });
    const result = await generateStoryPrompt({});
    expect(result.config.count).toBe(3);
  });
});

// =============================================================================
// INVENTION PITCH
// =============================================================================

describe('generateInventionPitch', () => {
  it('returns invention-pitch drill with problems', async () => {
    mockApiProvider({ problems: [
      { problem: 'You always forget where you put your keys', category: 'everyday', difficulty: 'easy' }
    ]});

    const result = await generateInventionPitch({ count: 1 });
    expect(result.type).toBe('invention-pitch');
    expect(result.config.count).toBe(1);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0].category).toBe('everyday');
    expect(result.problems[0].difficulty).toBe('easy');
  });

  it('defaults count to 3', async () => {
    mockApiProvider({ problems: Array.from({ length: 3 }, () => ({ problem: 'x', category: 'y', difficulty: 'medium' })) });
    const result = await generateInventionPitch({});
    expect(result.config.count).toBe(3);
  });
});

// =============================================================================
// REFRAME
// =============================================================================

describe('generateReframe', () => {
  it('returns reframe drill with situations', async () => {
    mockApiProvider({ situations: [
      { situation: 'Your flight was delayed by 4 hours', severity: 'medium' }
    ]});

    const result = await generateReframe({ count: 1 });
    expect(result.type).toBe('reframe');
    expect(result.config.count).toBe(1);
    expect(result.situations).toHaveLength(1);
    expect(result.situations[0].severity).toBe('medium');
  });

  it('defaults count to 3', async () => {
    mockApiProvider({ situations: Array.from({ length: 3 }, () => ({ situation: 'x', severity: 'low' })) });
    const result = await generateReframe({});
    expect(result.config.count).toBe(3);
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

    mockApiProvider({ challenges: [{ rootWord: 'fire', position: 'both', examples: [], minExpected: 8 }] });
    const cc = await generateLlmDrill('compound-chain', { count: 1 });
    expect(cc.type).toBe('compound-chain');

    mockApiProvider({ puzzles: [{ answer: 'paper' }] });
    const bw = await generateLlmDrill('bridge-word', { count: 1 });
    expect(bw.type).toBe('bridge-word');

    mockApiProvider({ challenges: [{ word: 'bark', meanings: [] }] });
    const dm = await generateLlmDrill('double-meaning', { count: 1 });
    expect(dm.type).toBe('double-meaning');

    mockApiProvider({ challenges: [{ idiom: 'x', domain: 'y' }] });
    const twist = await generateLlmDrill('idiom-twist', { count: 1 });
    expect(twist.type).toBe('idiom-twist');

    mockApiProvider({ scenarios: [{ prompt: 'x', category: 'y' }] });
    const wi = await generateLlmDrill('what-if', { count: 1 });
    expect(wi.type).toBe('what-if');

    mockApiProvider({ objects: [{ object: 'x', commonUse: 'y', minExpected: 5 }] });
    const au = await generateLlmDrill('alternative-uses', { count: 1 });
    expect(au.type).toBe('alternative-uses');

    mockApiProvider({ prompts: [{ words: ['a', 'b', 'c'] }] });
    const sp = await generateLlmDrill('story-prompt', { count: 1 });
    expect(sp.type).toBe('story-prompt');

    mockApiProvider({ problems: [{ problem: 'x', category: 'y', difficulty: 'easy' }] });
    const ip = await generateLlmDrill('invention-pitch', { count: 1 });
    expect(ip.type).toBe('invention-pitch');

    mockApiProvider({ situations: [{ situation: 'x', severity: 'low' }] });
    const rf = await generateLlmDrill('reframe', { count: 1 });
    expect(rf.type).toBe('reframe');
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
// LOCAL SCORING — BRIDGE WORD
// =============================================================================

describe('scoreLlmDrill bridge-word (local scoring)', () => {
  it('scores 100 for an exact match (case/whitespace insensitive)', async () => {
    const result = await scoreLlmDrill(
      'bridge-word',
      { puzzles: [{ clues: ['news___', '___back'], answer: 'paper' }] },
      [{ response: '  Paper  ', responseMs: 5000 }],
      60000
    );

    expect(result.evaluation.scores[0].score).toBe(100);
    expect(result.evaluation.scores[0].feedback).toBe('Correct!');
    expect(result.evaluation.overallScore).toBe(100);
  });

  it('scores 0 for a wrong answer with "the answer was" feedback', async () => {
    const result = await scoreLlmDrill(
      'bridge-word',
      { puzzles: [{ clues: ['news___', '___back'], answer: 'paper' }] },
      [{ response: 'wood', responseMs: 5000 }],
      60000
    );

    expect(result.evaluation.scores[0].score).toBe(0);
    expect(result.evaluation.scores[0].feedback).toBe('The answer was "paper"');
  });

  it('falls back to "no answer available" when the puzzle does not resolve', async () => {
    const result = await scoreLlmDrill(
      'bridge-word',
      { puzzles: [] },
      [{ response: 'paper', responseMs: 5000 }],
      60000
    );

    expect(result.evaluation.scores[0].score).toBe(0);
    expect(result.evaluation.scores[0].feedback).toBe('No answer available');
  });
});

// =============================================================================
// LLM SCORING — DOUBLE MEANING / IDIOM TWIST
// =============================================================================

describe('scoreLlmDrill double-meaning and idiom-twist (LLM scoring)', () => {
  it('scores double-meaning with evaluation and per-response feedback', async () => {
    mockApiProvider({
      overallScore: 85,
      scores: [{ score: 90, feedback: 'Both meanings used cleverly' }],
      summary: 'Great wordplay'
    });

    const result = await scoreLlmDrill(
      'double-meaning',
      { challenges: [{ word: 'bark', meanings: ['tree covering', 'dog sound'] }] },
      [{ response: "The dog's bark echoed off the bark of the tree.", responseMs: 8000 }],
      60000
    );

    expect(result.evaluation.overallScore).toBe(85);
    expect(result.questions[0].llmScore).toBe(90);
    expect(result.questions[0].llmFeedback).toBe('Both meanings used cleverly');
  });

  it('scores idiom-twist with evaluation and per-response feedback', async () => {
    mockApiProvider({
      overallScore: 70,
      scores: [{ score: 75, feedback: 'Good structural parallel' }],
      summary: 'Solid twist'
    });

    const result = await scoreLlmDrill(
      'idiom-twist',
      { challenges: [{ idiom: "Don't put all your eggs in one basket", domain: 'programming' }] },
      [{ response: "Don't push all your commits to one branch", responseMs: 8000 }],
      60000
    );

    expect(result.evaluation.overallScore).toBe(70);
    expect(result.questions[0].llmScore).toBe(75);
    expect(result.questions[0].llmFeedback).toBe('Good structural parallel');
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
    runPromptThroughProvider.mockResolvedValue({
      text: '```json\n{"questions":[{"prompt":"hello"}]}\n```',
      runId: 'test-run', model: 'test-model'
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
    runPromptThroughProvider.mockResolvedValue({
      text: 'Here is the result:\n{"questions":[{"prompt":"world"}]}\nHope this helps!',
      runId: 'test-run', model: 'test-model'
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
    runPromptThroughProvider.mockResolvedValue({
      text: '', runId: 'test-run', model: 'test-model'
    });

    await expect(generateWordAssociation({ count: 1 })).rejects.toThrow();
  });
});

