import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import DrillTransition from './DrillTransition';

const baseProps = {
  nextDrillType: 'multiplication',
  drillIndex: 1,
  drillCount: 3,
  completedResults: [{ type: 'doubling-chain', score: 90 }],
};

// The countdown reschedules a new 1000ms setTimeout from each re-render, so a
// single bulk `advanceTimersByTime(3000)` races the timer queue against
// React's flush. Ticking one second at a time (each wrapped in its own act())
// lets each render settle before the component's effect arms the next timer.
async function tickSeconds(n) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
  }
}

describe('DrillTransition', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-advances after the 3s countdown by default', async () => {
    const onContinue = vi.fn();
    render(<DrillTransition {...baseProps} onContinue={onContinue} />);
    expect(onContinue).not.toHaveBeenCalled();
    await tickSeconds(3);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('"Continue now" advances immediately without waiting for the countdown', () => {
    const onContinue = vi.fn();
    render(<DrillTransition {...baseProps} onContinue={onContinue} />);
    fireEvent.click(screen.getByRole('button', { name: /Continue now/ }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('clicking Pause stops the auto-advance countdown', async () => {
    const onContinue = vi.fn();
    render(<DrillTransition {...baseProps} onContinue={onContinue} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await tickSeconds(5);
    expect(onContinue).not.toHaveBeenCalled();
    expect(screen.getByText(/auto-advance stopped/)).toBeTruthy();
  });

  it('clicking Resume after Pause lets the countdown continue', async () => {
    const onContinue = vi.fn();
    render(<DrillTransition {...baseProps} onContinue={onContinue} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await tickSeconds(5);
    expect(onContinue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await tickSeconds(3);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('hovering the card pauses the countdown, and un-hovering resumes it', async () => {
    const onContinue = vi.fn();
    const { container } = render(<DrillTransition {...baseProps} onContinue={onContinue} />);
    const card = container.firstChild;
    fireEvent.mouseEnter(card);
    await tickSeconds(5);
    expect(onContinue).not.toHaveBeenCalled();
    fireEvent.mouseLeave(card);
    await tickSeconds(3);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('focusing an element inside the card pauses the countdown', async () => {
    const onContinue = vi.fn();
    render(<DrillTransition {...baseProps} onContinue={onContinue} />);
    fireEvent.focus(screen.getByRole('button', { name: 'Pause' }));
    await tickSeconds(5);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('a manual Pause survives hover ending — countdown stays stopped', async () => {
    const onContinue = vi.fn();
    const { container } = render(<DrillTransition {...baseProps} onContinue={onContinue} />);
    const card = container.firstChild;
    fireEvent.mouseEnter(card);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    fireEvent.mouseLeave(card);
    await tickSeconds(5);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('a focus-driven pause survives the mouse leaving the card (hover and focus are independent)', async () => {
    // Regression: hover and focus used to collapse into one boolean, so a
    // mouseleave while a control still held keyboard focus silently resumed
    // the countdown even though the user never blurred the focused control.
    const onContinue = vi.fn();
    const { container } = render(<DrillTransition {...baseProps} onContinue={onContinue} />);
    const card = container.firstChild;
    fireEvent.mouseEnter(card);
    fireEvent.focus(screen.getByRole('button', { name: 'Pause' }));
    fireEvent.mouseLeave(card);
    await tickSeconds(5);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('a hover-driven pause survives a blur inside the card (focus and hover are independent)', async () => {
    // Mirror of the above: leaving keyboard focus (blur) while the mouse is
    // still hovering the card must not resume the countdown either.
    const onContinue = vi.fn();
    const { container } = render(<DrillTransition {...baseProps} onContinue={onContinue} />);
    const card = container.firstChild;
    const pauseButton = screen.getByRole('button', { name: 'Pause' });
    fireEvent.focus(pauseButton);
    fireEvent.mouseEnter(card);
    fireEvent.blur(pauseButton, { relatedTarget: null });
    await tickSeconds(5);
    expect(onContinue).not.toHaveBeenCalled();
  });
});
