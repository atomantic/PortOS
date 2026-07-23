import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The trim endpoint is the whole point of Save — mock it so the test asserts
// the exact payload the UI sends without hitting the network. Canvas painting
// is a no-op in jsdom (getContext returns null) and the component guards it, so
// the frame math (toggle / enable-all / invert / save gating) is what's covered.
vi.mock('../../services/apiSprites.js', () => ({
  trimSpriteWalk: vi.fn(() => Promise.resolve({
    strip: 'walk/trims/east-loop-v001-strip.png',
    loop: 'walk/trims/east-loop-v001.gif',
    manifest: 'walk/trims/east-loop-v001.json',
    frameCount: 7,
    disabledFrameCount: 1,
  })),
}));

import LoopTrimmer from './LoopTrimmer';
import { trimSpriteWalk } from '../../services/apiSprites.js';

// jsdom has no 2D canvas; the component already guards a null context. Stub
// getContext to return null explicitly so the suite doesn't spam jsdom's
// "Not implemented: getContext" warning for every frame canvas it renders.
HTMLCanvasElement.prototype.getContext = () => null;

const grokRun = {
  id: 'walk-east-1', direction: 'east', status: 'candidate',
  stripPreview: { stripPath: 'grok/walk-east-1/generated/strip.png', frameCount: 8, fps: 12 },
};

const renderTrimmer = (props = {}) => render(
  <LoopTrimmer
    record={{ id: 'example-walker' }}
    walk={{ runs: [grokRun] }}
    assets={[]}
    onSelectRun={vi.fn()}
    onSaved={vi.fn()}
    {...props}
  />,
);

const enabledToggles = () => screen.queryAllByRole('button', { pressed: true });

describe('LoopTrimmer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('seeds every frame enabled and gates Save at ≥2 frames', () => {
    renderTrimmer();
    expect(enabledToggles()).toHaveLength(8);
    expect(screen.getByRole('button', { name: /Save trim \(8\/8\)/ })).not.toBeDisabled();
  });

  it('toggles a frame off and reflects the count in Save', () => {
    renderTrimmer();
    fireEvent.click(enabledToggles()[0]);
    expect(enabledToggles()).toHaveLength(7);
    expect(screen.getByRole('button', { name: /Save trim \(7\/8\)/ })).toBeTruthy();
  });

  it('Enable all and Invert rewrite the whole selection', () => {
    renderTrimmer();
    fireEvent.click(screen.getByRole('button', { name: /Invert/ }));
    expect(enabledToggles()).toHaveLength(0); // all-on inverted → all-off
    expect(screen.getByRole('button', { name: /Save trim \(0\/8\)/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Enable all/ }));
    expect(enabledToggles()).toHaveLength(8);
  });

  it('saves the enabled columns + fps through the trim endpoint', async () => {
    renderTrimmer();
    fireEvent.click(enabledToggles()[7]); // drop the last frame
    fireEvent.click(screen.getByRole('button', { name: /Save trim/ }));
    await waitFor(() => expect(trimSpriteWalk).toHaveBeenCalled());
    expect(trimSpriteWalk).toHaveBeenCalledWith(
      'example-walker',
      { runId: 'walk-east-1', enabledColumns: [0, 1, 2, 3, 4, 5, 6], fps: 12 },
      { silent: true },
    );
    // Result area surfaces the returned strip / GIF / manifest paths.
    await screen.findByText(/walk\/trims\/east-loop-v001\.json/);
  });

  it('sends a sanitized slug when the user names the output', async () => {
    renderTrimmer();
    fireEvent.change(screen.getByLabelText(/Output name/), { target: { value: 'East Loop V2!' } });
    expect(screen.getByText('east-loop-v2')).toBeTruthy(); // live slug preview
    fireEvent.click(screen.getByRole('button', { name: /Save trim/ }));
    await waitFor(() => expect(trimSpriteWalk).toHaveBeenCalled());
    expect(trimSpriteWalk.mock.calls[0][1]).toMatchObject({ slug: 'east-loop-v2' });
  });

  it('disables Save for a read-only (imported) source', () => {
    renderTrimmer({
      walk: { runs: [{ ...grokRun, stripPreview: { ...grokRun.stripPreview, stripPath: 'runs/import-east/generated/strip.png' } }] },
    });
    expect(screen.getByRole('button', { name: /Save trim/ })).toBeDisabled();
  });

  it('shows an empty state when there is nothing to trim', () => {
    renderTrimmer({ walk: { runs: [] } });
    expect(screen.getByText(/No animation strips to trim/)).toBeTruthy();
  });
});
