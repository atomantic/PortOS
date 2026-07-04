import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  scorePostLlmDrill: vi.fn(),
}));

import PostLlmDrillRunner, { getPrompts, buildLlmResponseObj } from './PostLlmDrillRunner';
import { scorePostLlmDrill } from '../../../services/api';
import { LLM_DRILL_TYPES } from './constants';

const noop = () => {};

beforeEach(() => {
  vi.clearAllMocks();
});

// The four wordplay drill types share their render (WordplayDrillUI.jsx) AND
// scoring core (scoreWordplayResponse) between this in-session runner and the
// standalone WordplayTrainer tab (issue #2097) — these tests confirm both
// hosts render the same UI for all four types, and that the in-session
// training-mode scoring path goes through the shared scorer.
describe('PostLlmDrillRunner — wordplay types render via the shared WordplayDrillUI core', () => {
  it('renders CompoundChainUI for compound-chain', () => {
    render(
      <PostLlmDrillRunner
        drill={{ type: 'compound-chain', challenges: [{ rootWord: 'fire', position: 'prefix', minExpected: 1 }] }}
        timeLimitSec={60}
        drillIndex={0}
        drillCount={1}
        onComplete={noop}
        isTraining={false}
      />
    );
    expect(screen.getByText('fire')).toBeInTheDocument();
  });

  it('renders BridgeWordUI for bridge-word', () => {
    render(
      <PostLlmDrillRunner
        drill={{ type: 'bridge-word', puzzles: [{ clues: ['news___', '___back'], answer: 'paper' }] }}
        timeLimitSec={60}
        drillIndex={0}
        drillCount={1}
        onComplete={noop}
        isTraining={false}
      />
    );
    expect(screen.getByText('news___')).toBeInTheDocument();
    expect(screen.getByText('___back')).toBeInTheDocument();
  });

  it('renders DoubleMeaningUI for double-meaning', () => {
    render(
      <PostLlmDrillRunner
        drill={{ type: 'double-meaning', challenges: [{ word: 'bark', meanings: ['tree covering', 'dog sound'] }] }}
        timeLimitSec={60}
        drillIndex={0}
        drillCount={1}
        onComplete={noop}
        isTraining={false}
      />
    );
    expect(screen.getByText('bark')).toBeInTheDocument();
  });

  it('renders IdiomTwistUI for idiom-twist', () => {
    render(
      <PostLlmDrillRunner
        drill={{ type: 'idiom-twist', challenges: [{ idiom: "Don't put all eggs in one basket", domain: 'programming' }] }}
        timeLimitSec={60}
        drillIndex={0}
        drillCount={1}
        onComplete={noop}
        isTraining={false}
      />
    );
    expect(screen.getByText('programming')).toBeInTheDocument();
  });
});

describe('PostLlmDrillRunner — training-mode scoring path', () => {
  it('scores a wordplay type through the shared scoreWordplayResponse core', async () => {
    scorePostLlmDrill.mockResolvedValue({
      evaluation: { scores: [{ score: 88, feedback: 'Great chain!' }] },
    });

    render(
      <PostLlmDrillRunner
        drill={{ type: 'compound-chain', challenges: [{ rootWord: 'fire', position: 'prefix', minExpected: 1 }] }}
        timeLimitSec={60}
        drillIndex={0}
        drillCount={1}
        onComplete={noop}
        isTraining
        providerId={null}
        model={null}
      />
    );

    const input = screen.getByPlaceholderText(/other half/i);
    fireEvent.change(input, { target: { value: 'firehouse' } });
    fireEvent.click(screen.getByText('Add'));
    fireEvent.click(screen.getByText(/Done — Submit 1 compounds/));

    await waitFor(() => expect(screen.getByText('88')).toBeInTheDocument());
    expect(scorePostLlmDrill).toHaveBeenCalledWith(
      'compound-chain', expect.any(Object), expect.any(Array), 60000, null, null
    );
  });

  it('still scores a non-wordplay LLM type (word-association) through its original inline path (unaffected by the wordplay extraction)', async () => {
    scorePostLlmDrill.mockResolvedValue({
      evaluation: { scores: [{ score: 65, feedback: 'Solid associations' }] },
    });

    render(
      <PostLlmDrillRunner
        drill={{ type: 'word-association', questions: [{ prompt: 'ocean', hints: 'first thing that comes to mind' }] }}
        timeLimitSec={60}
        drillIndex={0}
        drillCount={1}
        onComplete={noop}
        isTraining
        providerId={null}
        model={null}
      />
    );

    const input = screen.getByPlaceholderText(/type your associations/i);
    fireEvent.change(input, { target: { value: 'wave, blue, salt' } });
    fireEvent.click(screen.getByText('Next'));

    await waitFor(() => expect(screen.getByText('65')).toBeInTheDocument());
  });
});

// getPrompts pure-function coverage (issue #2102 gap #9): each of the 14
// generatable LLM drill types stores its prompt list under a different key
// (questions/exercises/categories/etc.) — a typo in the switch silently
// leaves that drill type with zero prompts.
const TYPE_FIELD = {
  'word-association': 'questions',
  'story-recall': 'exercises',
  'verbal-fluency': 'categories',
  'wit-comeback': 'scenarios',
  'pun-wordplay': 'challenges',
  'compound-chain': 'challenges',
  'bridge-word': 'puzzles',
  'double-meaning': 'challenges',
  'idiom-twist': 'challenges',
  'what-if': 'scenarios',
  'alternative-uses': 'objects',
  'story-prompt': 'prompts',
  'invention-pitch': 'problems',
  'reframe': 'situations',
};

describe('getPrompts', () => {
  it('returns the correct field array for every one of the 14 LLM drill-type shapes', () => {
    for (const type of LLM_DRILL_TYPES) {
      const field = TYPE_FIELD[type];
      const list = [{ id: 'a' }, { id: 'b' }];
      expect(getPrompts({ type, [field]: list })).toBe(list);
    }
  });

  it('returns an empty array when the type-specific field is missing', () => {
    for (const type of LLM_DRILL_TYPES) {
      expect(getPrompts({ type })).toEqual([]);
    }
  });

  it('returns an empty array for an unrecognized drill type', () => {
    expect(getPrompts({ type: 'not-a-real-type' })).toEqual([]);
  });

  it('returns an empty array when drill is null or undefined', () => {
    expect(getPrompts(null)).toEqual([]);
    expect(getPrompts(undefined)).toEqual([]);
  });
});

// buildLlmResponseObj pure-function coverage (issue #2102 gap #9): every
// response shape stamps `questionIndex` so the server can pair a response
// with its originating prompt by explicit index rather than array position
// (regression fixed in 0a60c8457 — "pair wordplay responses with correct
// challenge by index"). A dropped/misassigned questionIndex silently
// mis-scores responses against the wrong prompt.
describe('buildLlmResponseObj', () => {
  it('stamps sequential questionIndex values matching each prompt position', () => {
    const prompts = [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }];
    const responses = prompts.map((currentPrompt, questionIndex) =>
      buildLlmResponseObj({
        drillType: 'word-association',
        questionIndex,
        items: [],
        inputValue: `answer-${questionIndex}`,
        currentPrompt,
        responseMs: 100,
      })
    );
    expect(responses.map(r => r.questionIndex)).toEqual([0, 1, 2]);
    expect(responses[1]).toMatchObject({ questionIndex: 1, prompt: 'b', response: 'answer-1' });
  });

  it('story-recall: uses the collected items as answers when present', () => {
    const result = buildLlmResponseObj({
      drillType: 'story-recall', questionIndex: 2, items: ['ans1', 'ans2'], inputValue: '', currentPrompt: {}, responseMs: 500,
    });
    expect(result).toEqual({ questionIndex: 2, answers: ['ans1', 'ans2'], responseMs: 500 });
  });

  it('story-recall: falls back to the trimmed inputValue as a single answer when no items were collected', () => {
    const result = buildLlmResponseObj({
      drillType: 'story-recall', questionIndex: 0, items: [], inputValue: '  lone answer  ', currentPrompt: {}, responseMs: 200,
    });
    expect(result).toEqual({ questionIndex: 0, answers: ['lone answer'], responseMs: 200 });
  });

  it.each(['verbal-fluency', 'compound-chain', 'alternative-uses'])('%s: passes the items array through as-is', (drillType) => {
    const items = ['x', 'y', 'z'];
    const result = buildLlmResponseObj({ drillType, questionIndex: 1, items, inputValue: 'ignored', currentPrompt: {}, responseMs: 300 });
    expect(result).toEqual({ questionIndex: 1, items, responseMs: 300 });
  });

  it('other types: builds the prompt from the first available field in the fallback chain and trims the response', () => {
    const result = buildLlmResponseObj({
      drillType: 'wit-comeback',
      questionIndex: 3,
      items: [],
      inputValue: '  witty reply  ',
      currentPrompt: { setup: 'a setup line' },
      responseMs: 400,
    });
    expect(result).toEqual({ questionIndex: 3, prompt: 'a setup line', response: 'witty reply', responseMs: 400 });
  });

  it('other types: falls back to an empty prompt string when currentPrompt has none of the known fields', () => {
    const result = buildLlmResponseObj({
      drillType: 'what-if', questionIndex: 0, items: [], inputValue: 'x', currentPrompt: {}, responseMs: 0,
    });
    expect(result.prompt).toBe('');
  });
});
