import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// Stub every API call WordplayTrainer (and the shared WordplayDrillUI scoring
// core it now delegates to) can reach — mirrors the mocking convention used
// by MorseTrainer.test.jsx / PostDrillConfig.test.jsx.
vi.mock('../../../services/api', () => ({
  generatePostDrill: vi.fn(),
  scorePostLlmDrill: vi.fn(),
  getPostDrillCacheStatus: vi.fn(() => Promise.resolve({})),
  fillPostDrillCache: vi.fn(() => Promise.resolve({})),
  updatePostConfig: vi.fn(() => Promise.resolve({})),
  submitTrainingEntry: vi.fn(() => Promise.resolve({})),
  getProviders: vi.fn(() => Promise.resolve({ providers: [] })),
}));

import WordplayTrainer from './WordplayTrainer';
import {
  generatePostDrill, scorePostLlmDrill, getPostDrillCacheStatus, submitTrainingEntry,
} from '../../../services/api';

// The selected mode now lives in the URL (`/post/wordplay/:mode`) — PostTab
// owns that param and passes it down. This harness stands in for that routing:
// clicking a mode button calls onSelectMode, which sets the `mode` prop, and the
// component's URL-driven effect then generates the drill (mirroring a real
// navigation to the mode's route).
function TrainerHarness(props) {
  const [mode, setMode] = useState(null);
  return (
    <WordplayTrainer
      {...props}
      mode={mode}
      onSelectMode={setMode}
      onExitMode={() => setMode(null)}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Cache reported warm for every mode so startMode skips the cache-fill
  // consent modal and goes straight to runMode — the modal flow is covered
  // separately and isn't the concern of these tests.
  getPostDrillCacheStatus.mockResolvedValue({
    'compound-chain': { cold: false },
    'bridge-word': { cold: false },
  });
});

describe('WordplayTrainer — training-log persistence (issue #2097)', () => {
  it('submits a training entry on round completion, with correctCount derived from the scored responses', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'compound-chain',
      challenges: [{ rootWord: 'fire', position: 'prefix', minExpected: 1 }],
    });
    scorePostLlmDrill.mockResolvedValue({
      evaluation: { scores: [{ score: 85, feedback: 'Nice compounds!' }] },
    });

    render(<TrainerHarness onBack={() => {}} config={{}} onConfigUpdate={() => {}} />);

    fireEvent.click(await screen.findByText('Compound Chain'));

    // Drill generated — a single-challenge round keeps this test to one round.
    await waitFor(() => expect(screen.getByText('fire')).toBeInTheDocument());

    const input = screen.getByPlaceholderText(/other half/i);
    fireEvent.change(input, { target: { value: 'firehouse' } });
    fireEvent.click(screen.getByText('Add'));

    fireEvent.click(screen.getByText(/Done — Submit 1 compounds/));

    // Scoring resolves (score: 85 >= 70 correct threshold) — "See Results" is
    // the last-question label for handleNext.
    const seeResults = await screen.findByText('See Results');
    fireEvent.click(seeResults);

    await waitFor(() => expect(submitTrainingEntry).toHaveBeenCalledTimes(1));
    expect(submitTrainingEntry).toHaveBeenCalledWith(expect.objectContaining({
      module: 'llm-drills',
      drillType: 'compound-chain',
      questionCount: 1,
      correctCount: 1,
    }));
    const entry = submitTrainingEntry.mock.calls[0][0];
    expect(entry.totalMs).toBeGreaterThanOrEqual(0);

    // Per-question breakdown (issue #2114) — one entry per scored response,
    // carrying the score/feedback already computed for the results screen.
    expect(entry.questions).toHaveLength(1);
    expect(entry.questions[0]).toMatchObject({
      prompt: 'fire',
      items: ['firehouse'],
      score: 85,
      feedback: 'Nice compounds!',
      correct: true,
    });
  });

  it('does not wedge on a permanent spinner after leaving a mode mid-generation then picking another (issue #2098)', async () => {
    generatePostDrill
      .mockImplementationOnce(() => new Promise(() => {})) // mode A generation hangs
      .mockResolvedValueOnce({
        type: 'bridge-word',
        puzzles: [{ clues: ['news___', '___back'], answer: 'paper' }],
      });

    render(<TrainerHarness onBack={() => {}} config={{}} onConfigUpdate={() => {}} />);

    fireEvent.click(await screen.findByText('Compound Chain')); // enter mode A → loading (hangs)
    await waitFor(() => expect(screen.getByText(/Generating/i)).toBeInTheDocument());

    // Leave mid-generation via the header Back (mirrors browser-back off the URL).
    // The stale `loading` from the aborted generation must be cleared, or the
    // next mode would be stuck on a permanent spinner.
    fireEvent.click(screen.getAllByRole('button')[0]);
    await screen.findByText('Bridge Word'); // back on the mode grid

    fireEvent.click(screen.getByText('Bridge Word')); // enter mode B
    await waitFor(() => expect(screen.getByText('news___')).toBeInTheDocument()); // B generated, not wedged
  });

  it('ignores a superseded generation when the same mode is re-entered mid-generation (issue #2098)', async () => {
    let resolveFirst;
    generatePostDrill
      .mockImplementationOnce(() => new Promise(r => { resolveFirst = r; })) // run #1 (deferred)
      .mockResolvedValueOnce({
        type: 'compound-chain',
        challenges: [{ rootWord: 'water', position: 'prefix', minExpected: 1 }],
      }); // run #2

    render(<TrainerHarness onBack={() => {}} config={{}} onConfigUpdate={() => {}} />);

    fireEvent.click(await screen.findByText('Compound Chain')); // enter A → run #1 (deferred)
    await waitFor(() => expect(screen.getByText(/Generating/i)).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('button')[0]);         // back to grid (invalidates run #1)
    await screen.findByText('Compound Chain');
    fireEvent.click(screen.getByText('Compound Chain'));       // re-enter A → run #2 resolves
    await waitFor(() => expect(screen.getByText('water')).toBeInTheDocument());

    // The stale run #1 finally resolves — its token is superseded, so it must NOT
    // swap the drill out from under the live run #2.
    await act(async () => {
      resolveFirst({ type: 'compound-chain', challenges: [{ rootWord: 'fire', position: 'prefix', minExpected: 1 }] });
    });
    expect(screen.getByText('water')).toBeInTheDocument();
    expect(screen.queryByText('fire')).toBeNull();
  });

  it('does not submit a training entry before the round completes', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'bridge-word',
      puzzles: [
        { clues: ['news___', '___back'], answer: 'paper' },
        { clues: ['sun___', '___light'], answer: 'flower' },
      ],
    });
    scorePostLlmDrill.mockResolvedValue({
      evaluation: { scores: [{ score: 40, feedback: 'Not quite' }] },
    });

    render(<TrainerHarness onBack={() => {}} config={{}} onConfigUpdate={() => {}} />);

    fireEvent.click(await screen.findByText('Bridge Word'));

    await waitFor(() => expect(screen.getByText('news___')).toBeInTheDocument());

    const input = screen.getByPlaceholderText(/bridge word is/i);
    fireEvent.change(input, { target: { value: 'wrongword' } });
    fireEvent.click(screen.getByText('Submit'));

    // First of two puzzles — advancing shows "Next", not "See Results", and
    // no training entry has been logged yet (only the final round does).
    await screen.findByText('Next');
    expect(submitTrainingEntry).not.toHaveBeenCalled();
  });

  it('persists a Bridge Word breakdown with a readable prompt built from the clue set (issue #2114)', async () => {
    // Regression: Bridge Word puzzles have no rootWord/word/idiom field, only
    // `clues`. Before this fix, the persisted question's `prompt` silently
    // fell through to '' for this mode — the training log couldn't identify
    // which puzzle a missed answer belonged to.
    generatePostDrill.mockResolvedValue({
      type: 'bridge-word',
      puzzles: [{ clues: ['news___', '___back'], answer: 'paper' }],
    });
    scorePostLlmDrill.mockResolvedValue({
      evaluation: { scores: [{ score: 40, feedback: 'Not quite' }] },
    });

    render(<TrainerHarness onBack={() => {}} config={{}} onConfigUpdate={() => {}} />);

    fireEvent.click(await screen.findByText('Bridge Word'));
    await waitFor(() => expect(screen.getByText('news___')).toBeInTheDocument());

    const input = screen.getByPlaceholderText(/bridge word is/i);
    fireEvent.change(input, { target: { value: 'wrongword' } });
    fireEvent.click(screen.getByText('Submit'));

    const seeResults = await screen.findByText('See Results');
    fireEvent.click(seeResults);

    await waitFor(() => expect(submitTrainingEntry).toHaveBeenCalledTimes(1));
    const entry = submitTrainingEntry.mock.calls[0][0];
    expect(entry.questions[0]).toMatchObject({
      prompt: 'news___ / ___back',
      response: 'wrongword',
      score: 40,
      correct: false,
    });
  });
});
