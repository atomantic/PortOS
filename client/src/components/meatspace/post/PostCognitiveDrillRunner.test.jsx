import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import PostCognitiveDrillRunner from './PostCognitiveDrillRunner';

// Regression coverage for the reaction-time runner's timer/re-entrancy guards
// (dual armTimeoutRef/advanceTimeoutRef + advancingRef). These are documented
// in-code as deliberate race-condition mitigations but had no test coverage:
// a future edit that collapses the two timer refs back into one, or drops
// the advancingRef guard, would silently reintroduce a stale setPhase('go')
// leak or a double-recorded trial.

function makeSimpleDrill({ count = 1, delayMs = 1000 } = {}) {
  return {
    type: 'reaction-time',
    config: { mode: 'simple', count, minDelayMs: delayMs, maxDelayMs: delayMs, choices: 1 },
    trials: Array.from({ length: count }, () => ({ delayMs })),
  };
}

describe('ReactionTimeRunner race-condition guards', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels the reveal timer on a false start so it cannot leak a stale GO into a later trial', () => {
    const onComplete = vi.fn();
    const drill = makeSimpleDrill({ count: 1, delayMs: 1000 });
    render(
      <PostCognitiveDrillRunner
        drill={drill}
        drillIndex={0}
        drillCount={1}
        onComplete={onComplete}
        isTraining={false}
      />,
    );

    // Respond before the stimulus is revealed — a false start.
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /wait for the signal/i }));
    });
    expect(screen.getByText('Too soon!')).toBeInTheDocument();

    // The non-training advance delay is 500ms; this is the only trial, so it
    // finishes (calls onComplete) rather than arming a new trial.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    const result = onComplete.mock.calls[0][0];
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]).toMatchObject({ falseStart: true, correct: false, answered: null });

    // Advance past the ORIGINAL 1000ms reveal delay. If the reveal timer had
    // not been cancelled on the false start, its stale callback would fire
    // here and flip phase back to 'go' (rendering the GO! button) even
    // though the drill already completed.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByRole('button', { name: 'GO!' })).not.toBeInTheDocument();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('does not double-record a response when GO is clicked twice in rapid succession', () => {
    const onComplete = vi.fn();
    const drill = makeSimpleDrill({ count: 1, delayMs: 100 });
    render(
      <PostCognitiveDrillRunner
        drill={drill}
        drillIndex={0}
        drillCount={1}
        onComplete={onComplete}
        isTraining={false}
      />,
    );

    // Let the stimulus reveal (phase -> 'go').
    act(() => {
      vi.advanceTimersByTime(100);
    });
    const goButton = screen.getByRole('button', { name: 'GO!' });

    // Fire two clicks back-to-back within the same synchronous block, before
    // React re-renders in response to the first. The advancingRef guard
    // (checked synchronously, not via state) must reject the second.
    act(() => {
      fireEvent.click(goButton);
      fireEvent.click(goButton);
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0].questions).toHaveLength(1);
  });

  it('ignores a keydown response once the result phase has already recorded an answer', () => {
    const onComplete = vi.fn();
    const drill = makeSimpleDrill({ count: 1, delayMs: 100 });
    render(
      <PostCognitiveDrillRunner
        drill={drill}
        drillIndex={0}
        drillCount={1}
        onComplete={onComplete}
        isTraining={false}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(100);
    });
    const goButton = screen.getByRole('button', { name: 'GO!' });

    act(() => {
      fireEvent.click(goButton);
      // A keyboard response racing in immediately after the click, before
      // the 'result' phase has rendered, must not record a second answer.
      fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0].questions).toHaveLength(1);
  });
});
