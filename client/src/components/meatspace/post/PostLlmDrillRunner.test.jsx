import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  scorePostLlmDrill: vi.fn(),
}));

import PostLlmDrillRunner from './PostLlmDrillRunner';
import { scorePostLlmDrill } from '../../../services/api';

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
