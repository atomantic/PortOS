import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import BeatTimeline from './BeatTimeline.jsx';

describe('narrative event lane', () => {
  it('places an event at its resolved onset frame, displays unresolved bindings, and never commits scene edits', () => {
    const onCommit = vi.fn();
    const base = { name: 'Impact', kind: 'impact', durationSec: 1, narrativeFunction: 'Mark a turn', mediumRationale: 'Exact graphic' };
    render(<BeatTimeline audioAnalysis={{ durationSec: 5, features: { onsets: { low: [0.51] } } }}
      scenes={[{ sceneId: 's1', startSec: 0, endSec: 5 }]} narrativeEvents={[
        { ...base, id: 'hit', anchor: { kind: 'onset', band: 'low', index: 0 } },
        { ...base, id: 'lost', anchor: null },
      ]} onCommit={onCommit} />);
    expect(screen.getByTitle(/^Impact at frame 13 · impact/)).toHaveTextContent('Impact · impact');
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('1 unresolved');
  });
});

describe('keyboard controls', () => {
  const audioAnalysis = { durationSec: 10, beats: [0, 1, 2, 3, 4, 5], downbeats: [0, 4] };
  const scenes = [{ sceneId: 's1', order: 0, startSec: 1, endSec: 3, persisted: true }];

  it('moves and trims a scene to adjacent beat-grid points and commits', () => {
    const onCommit = vi.fn();
    render(<BeatTimeline audioAnalysis={audioAnalysis} scenes={scenes} onCommit={onCommit} />);
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Move scene 1' }), { key: 'ArrowRight' });
    expect(onCommit).toHaveBeenLastCalledWith('s1', { startSec: 2, endSec: 4, beatAligned: true });
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Trim end of scene 1' }), { key: 'ArrowLeft' });
    expect(onCommit).toHaveBeenLastCalledWith('s1', { startSec: 1, endSec: 2, beatAligned: true });
    expect(screen.getByRole('slider', { name: 'Trim end of scene 1' })).toHaveAttribute('aria-valuetext', expect.stringContaining('ends 0:03'));
  });

  it('scrolls the timeline from the overview via keys and ignores keyboard-synthesized clicks', () => {
    render(<BeatTimeline audioAnalysis={audioAnalysis} scenes={scenes} onCommit={vi.fn()} />);
    const overview = screen.getByRole('button', { name: /Song overview/ });
    const scroller = document.querySelector('.overflow-x-auto');
    scroller.scrollTo = vi.fn();
    fireEvent.keyDown(overview, { key: 'End' });
    expect(scroller.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ left: 10 * 80 - scroller.clientWidth / 2 }));
    scroller.scrollTo.mockClear();
    fireEvent.click(overview, { detail: 0 });
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });
});
