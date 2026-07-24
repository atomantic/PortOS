import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';
import {
  render, screen, fireEvent, act,
} from '@testing-library/react';

// Every call this panel makes is mocked: the point of the suite is WHICH request
// the re-derive fires and with what payload — a per-run geometry resolved from
// the SET target (#2985), never a page-level form value.
vi.mock('../../services/apiSprites.js', () => ({
  getSpriteWalkSourceFrames: vi.fn(),
  postprocessSpriteWalk: vi.fn(() => Promise.resolve({})),
  setSpriteWalkTarget: vi.fn(() => Promise.resolve({})),
  unlockSpriteWalk: vi.fn(() => Promise.resolve({})),
  reopenSpriteWalk: vi.fn(() => Promise.resolve({})),
}));

import WalkSourceFrames from './WalkSourceFrames';
import {
  getSpriteWalkSourceFrames, postprocessSpriteWalk, setSpriteWalkTarget,
  unlockSpriteWalk, reopenSpriteWalk,
} from '../../services/apiSprites.js';

const RUN_ID = 'walk-east-0a1b2c3d';

// 8 raw frames; the packer selected a 4-long window starting at raw frame 3 and
// kept frames 3 and 5 as packed columns.
const payload = (overrides = {}) => ({
  available: true,
  reason: null,
  runId: RUN_ID,
  direction: 'east',
  extractionFps: 12,
  maxSourceSeconds: 8,
  frames: Array.from({ length: 8 }, (_, i) => ({
    index: i + 1,
    path: `runs/${RUN_ID}/generated/raw/source-000${i + 1}.png`,
  })),
  cycle: {
    windowStart: 1, windowLength: 4, windowStartFrame: 3, windowEndFrame: 7,
  },
  selectedSourceIndices: [3, 5],
  current: { frameCount: 8, fps: 12 },
  target: {
    frameCount: 8, fps: 12, source: 'derived', sourceLabel: 'from the first approved direction',
  },
  editable: true,
  lockReason: null,
  ...overrides,
});

const onSaved = vi.fn();
const renderPanel = async (data = payload()) => {
  getSpriteWalkSourceFrames.mockResolvedValue(data);
  const result = render(
    <WalkSourceFrames recordId="example-walker" runId={RUN_ID} onSaved={onSaved} />,
  );
  // Settle the mount fetch inside act() — the suite fails on act warnings.
  await act(async () => {});
  return result;
};

const expandGrid = () => fireEvent.click(screen.getByRole('button', { name: /source frames @/ }));
// Matches both resting ("Re-derive from clip") and in-flight ("Re-deriving…").
const deriveButton = () => screen.getByRole('button', { name: /Re-deriv(e|ing)/ });

describe('WalkSourceFrames', () => {
  beforeEach(() => vi.clearAllMocks());

  it('summarizes the extraction and expands to a grid of every raw frame', async () => {
    const { container } = await renderPanel();
    // The headroom above the packed count is the whole reason to show this.
    expect(screen.getByRole('button', { name: /8 source frames @ 12fps · packed 8/ })).toBeTruthy();
    expect(container.querySelectorAll('img')).toHaveLength(0); // collapsed by default

    expandGrid();
    const images = [...container.querySelectorAll('img')];
    expect(images).toHaveLength(8);
    expect(images[0].getAttribute('src'))
      .toBe(`/data/sprites/example-walker/runs/${RUN_ID}/generated/raw/source-0001.png`);
  });

  it('marks the selected cycle window and the frames that became packed columns', async () => {
    await renderPanel();
    expandGrid();
    const cellFor = (index) => screen.getByTitle(new RegExp(`^source frame ${index}\\b`));

    // Frame 1 is outside the window the packer chose.
    expect(cellFor(1).getAttribute('title')).toBe('source frame 1');
    // 4 is inside the window (3..6) but was not packed.
    expect(cellFor(4).getAttribute('title')).toBe('source frame 4 — in the selected cycle window');
    // 3 and 5 became strip columns.
    expect(cellFor(3).getAttribute('title'))
      .toBe('source frame 3 — in the selected cycle window, packed into the strip');
    expect(cellFor(5).className).toContain('ring-port-accent');
    // 7 is the window's exclusive end.
    expect(cellFor(7).getAttribute('title')).toBe('source frame 7');
  });

  // Geometry is deliberately omitted so the server adopts the pinned target: a
  // panel one refetch behind must not 409 on a value the user never chose.
  it('re-derives the SELECTED run by id alone, letting the server adopt the target', async () => {
    await renderPanel();
    fireEvent.click(deriveButton());
    await act(async () => {});

    expect(setSpriteWalkTarget).not.toHaveBeenCalled();
    expect(postprocessSpriteWalk).toHaveBeenCalledWith(
      'example-walker', { runId: RUN_ID }, { silent: true },
    );
    // The trimmer reloads its strip + toggles against the new geometry.
    expect(onSaved).toHaveBeenCalled();
  });

  // The geometry knob is the shared SET-level control, not a per-run one — the
  // whole point of #2985 is that one direction cannot diverge from the set.
  it('changes the cycle through the shared set target', async () => {
    await renderPanel();
    fireEvent.change(screen.getByLabelText(/Cycle target/), { target: { value: '12' } });
    await act(async () => {});
    expect(setSpriteWalkTarget).toHaveBeenCalledWith(
      'example-walker', { frameCount: 12, fps: 12 }, { silent: true },
    );
    // A retarget refreshes the trimmer around it as well as this panel.
    expect(onSaved).toHaveBeenCalled();
  });

  it('disables the controls while the re-derive is in flight', async () => {
    let release;
    postprocessSpriteWalk.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    await renderPanel();

    fireEvent.click(deriveButton());
    expect(deriveButton()).toBeDisabled();
    expect(screen.getByLabelText(/Cycle target/)).toBeDisabled();
    expect(screen.getByLabelText(/Preview speed/)).toBeDisabled();

    await act(async () => { release({}); });
    expect(deriveButton()).not.toBeDisabled();
  });

  // The dependent action must not fire against a target the server has not
  // persisted yet (CLAUDE.md: in-flight saves gate dependent actions).
  it('disables the re-derive while the target PUT is in flight', async () => {
    let release;
    setSpriteWalkTarget.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    await renderPanel();

    fireEvent.change(screen.getByLabelText(/Cycle target/), { target: { value: '12' } });
    expect(deriveButton()).toBeDisabled();

    await act(async () => { release({}); });
    expect(deriveButton()).not.toBeDisabled();
  });

  it('explains an imported run with no clip instead of showing an empty grid', async () => {
    await renderPanel(payload({
      available: false, reason: 'no-source-video', frames: [], cycle: null, selectedSourceIndices: [], editable: false, lockReason: 'no-source-video',
    }));
    expect(screen.getByText(/imported without its source clip/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /source frames @/ })).toBeNull();
    expect(deriveButton()).toBeDisabled();
    // Nothing to unlock — a missing clip has no action behind it.
    expect(screen.queryByRole('button', { name: /Reopen|Unlock/ })).toBeNull();
  });

  it('offers reopen for an approved direction and posts it on confirm', async () => {
    await renderPanel(payload({ editable: false, lockReason: 'approved' }));
    expect(deriveButton()).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Reopen direction/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Reopen direction$/ }));
    await act(async () => {});
    expect(reopenSpriteWalk).toHaveBeenCalledWith('example-walker', { direction: 'east' }, { silent: true });
    expect(unlockSpriteWalk).not.toHaveBeenCalled();
  });

  it('offers the set unlock for a finalized set', async () => {
    await renderPanel(payload({ editable: false, lockReason: 'finalized' }));
    fireEvent.click(screen.getByRole('button', { name: /Unlock set/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Unlock set$/ }));
    await act(async () => {});
    expect(unlockSpriteWalk).toHaveBeenCalledWith('example-walker', { silent: true });
    expect(reopenSpriteWalk).not.toHaveBeenCalled();
  });

  it('reports a failed read with a retry instead of a silent empty panel', async () => {
    getSpriteWalkSourceFrames.mockRejectedValueOnce(new Error('boom'));
    render(<WalkSourceFrames recordId="example-walker" runId={RUN_ID} />);
    await act(async () => {});
    expect(screen.getByText(/boom/)).toBeTruthy();

    getSpriteWalkSourceFrames.mockResolvedValueOnce(payload());
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    await act(async () => {});
    expect(screen.getByRole('button', { name: /8 source frames @ 12fps/ })).toBeTruthy();
  });
});
