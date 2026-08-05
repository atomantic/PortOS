import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';

import ProgressSlider from './ProgressSlider';

const GOAL = { id: 'goal-1', progress: 20 };

const renderSlider = (onCommit, goal = GOAL) => {
  const view = render(<ProgressSlider goal={goal} onCommit={onCommit} />);
  return { ...view, slider: screen.getByRole('slider') };
};

// Drag = the onChange stream a real pointer produces, then the release that commits.
const drag = (slider, value) => fireEvent.change(slider, { target: { value: String(value) } });

describe('ProgressSlider commit', () => {
  it('sends the released value to onCommit', async () => {
    const onCommit = vi.fn(() => Promise.resolve(true));
    const { slider } = renderSlider(onCommit);

    drag(slider, 85);
    await act(async () => { fireEvent.mouseUp(slider); });

    expect(onCommit).toHaveBeenCalledWith(85);
  });

  it('does not commit when the value lands back on the stored percentage', async () => {
    const onCommit = vi.fn(() => Promise.resolve(true));
    const { slider } = renderSlider(onCommit);

    drag(slider, 85);
    drag(slider, 20);
    await act(async () => { fireEvent.mouseUp(slider); });

    expect(onCommit).not.toHaveBeenCalled();
  });

  // Issue #3520: a rejected update left `draft` on the dragged value, so the panel
  // advertised a percentage the database never took.
  it('snaps back to the stored percentage when the commit reports failure', async () => {
    const onCommit = vi.fn(() => Promise.resolve(false));
    const { slider } = renderSlider(onCommit);

    drag(slider, 85);
    expect(screen.getByText('85%')).toBeTruthy();

    await act(async () => { fireEvent.mouseUp(slider); });

    expect(screen.getByText('20%')).toBeTruthy();
    expect(slider.value).toBe('20');
  });

  it('snaps back when the commit rejects', async () => {
    const onCommit = vi.fn(() => Promise.reject(new Error('server exploded')));
    const { slider } = renderSlider(onCommit);

    drag(slider, 85);
    await act(async () => { fireEvent.mouseUp(slider); });

    expect(screen.getByText('20%')).toBeTruthy();
  });

  // A bare `.catch()` never gets attached when the handler throws before returning a
  // promise, which would latch `saving` on and freeze the slider on an unsaved value.
  it('snaps back when the commit throws synchronously', async () => {
    const onCommit = vi.fn(() => { throw new Error('threw before returning a promise'); });
    const { slider } = renderSlider(onCommit);

    drag(slider, 85);
    await act(async () => { fireEvent.mouseUp(slider); });

    expect(screen.getByText('20%')).toBeTruthy();
  });

  it('can be retried after a failed commit', async () => {
    const onCommit = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { slider } = renderSlider(onCommit);

    drag(slider, 85);
    await act(async () => { fireEvent.mouseUp(slider); });
    expect(screen.getByText('20%')).toBeTruthy();

    drag(slider, 85);
    await act(async () => { fireEvent.mouseUp(slider); });

    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(screen.getByText('85%')).toBeTruthy();
  });

  // A handler that returns nothing keeps the pre-#3520 optimistic behavior.
  it('keeps the dragged value when the commit resolves with no outcome', async () => {
    const onCommit = vi.fn(() => Promise.resolve());
    const { slider } = renderSlider(onCommit);

    drag(slider, 85);
    await act(async () => { fireEvent.mouseUp(slider); });

    expect(screen.getByText('85%')).toBeTruthy();
  });

  it('holds the dragged value while the commit is in flight', async () => {
    let release;
    const onCommit = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const { slider } = renderSlider(onCommit);

    drag(slider, 85);
    await act(async () => { fireEvent.mouseUp(slider); });
    // The pre-fix effect reset draft the moment dragging flipped false.
    expect(screen.getByText('85%')).toBeTruthy();

    await act(async () => { release(true); });
    expect(screen.getByText('85%')).toBeTruthy();
  });

  it('ignores a second release while the first commit is still in flight', async () => {
    let release;
    const onCommit = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const { slider } = renderSlider(onCommit);

    drag(slider, 85);
    // Touch devices fire touchend and a synthesized mouseup for one release.
    await act(async () => { fireEvent.touchEnd(slider); });
    await act(async () => { fireEvent.mouseUp(slider); });

    expect(onCommit).toHaveBeenCalledTimes(1);

    await act(async () => { release(true); });
  });

  // Arrow/Home/End move a range input without ever firing mouseup.
  it('commits a keyboard-driven change on key release', async () => {
    const onCommit = vi.fn(() => Promise.resolve(true));
    const { slider } = renderSlider(onCommit);

    drag(slider, 21);
    await act(async () => { fireEvent.keyUp(slider, { key: 'ArrowRight' }); });

    expect(onCommit).toHaveBeenCalledWith(21);
  });

  // The parent refetch lands after the commit resolves, so a saved value has to
  // survive a render that still carries the pre-commit goal snapshot.
  it('keeps the saved value while the refreshed goal is still in flight', async () => {
    const onCommit = vi.fn(() => Promise.resolve(true));
    const { slider, rerender } = renderSlider(onCommit);

    drag(slider, 85);
    await act(async () => { fireEvent.mouseUp(slider); });
    await act(async () => { rerender(<ProgressSlider goal={GOAL} onCommit={onCommit} />); });
    expect(screen.getByText('85%')).toBeTruthy();

    await act(async () => { rerender(<ProgressSlider goal={{ ...GOAL, progress: 85 }} onCommit={onCommit} />); });
    expect(screen.getByText('85%')).toBeTruthy();
  });

  it('pairs the Progress label with the slider', () => {
    const { slider } = renderSlider(vi.fn());

    expect(screen.getByLabelText('Progress')).toBe(slider);
  });

  it('adopts an externally changed progress value', async () => {
    const onCommit = vi.fn(() => Promise.resolve(true));
    const { rerender } = renderSlider(onCommit);

    await act(async () => { rerender(<ProgressSlider goal={{ ...GOAL, progress: 60 }} onCommit={onCommit} />); });

    expect(screen.getByText('60%')).toBeTruthy();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
