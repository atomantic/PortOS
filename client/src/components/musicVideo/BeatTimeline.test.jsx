import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
