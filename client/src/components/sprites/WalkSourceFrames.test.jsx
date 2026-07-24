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
  extractSpriteWalkSourceFrames: vi.fn(),
  // Echoes the updated run record, which is what the success toast reports.
  postprocessSpriteWalk: vi.fn(() => Promise.resolve({ id: 'walk-east-0a1b2c3d', frameCount: 12, fps: 12 })),
  setSpriteWalkTarget: vi.fn(() => Promise.resolve({})),
  unlockSpriteWalk: vi.fn(() => Promise.resolve({})),
  reopenSpriteWalk: vi.fn(() => Promise.resolve({})),
}));

import WalkSourceFrames from './WalkSourceFrames';
import {
  getSpriteWalkSourceFrames, extractSpriteWalkSourceFrames, postprocessSpriteWalk,
  setSpriteWalkTarget, unlockSpriteWalk, reopenSpriteWalk,
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
  cycleProvenance: 'verified',
  imported: false,
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
    // 7 is the window's exclusive end — so the prose must say 3–6, or the label
    // would claim a frame the grid leaves unmarked.
    expect(cellFor(7).getAttribute('title')).toBe('source frame 7');
    expect(screen.getByText(/Frames 3–6 are the/)).toBeTruthy();
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
      available: false,
      reason: 'no-source-video',
      imported: true,
      frames: [],
      cycle: null,
      selectedSourceIndices: [],
      cycleProvenance: 'none',
      editable: false,
      lockReason: 'no-source-video',
    }));
    expect(screen.getByText(/imported without its source clip/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /source frames @/ })).toBeNull();
    expect(deriveButton()).toBeDisabled();
    // Nothing to unlock — a missing clip has no action behind it — and the
    // explanation is printed once, not echoed by the lock block.
    expect(screen.queryByRole('button', { name: /Reopen|Unlock|Extract/ })).toBeNull();
    expect(screen.queryByText(/not on disk, so there is nothing to re-derive/)).toBeNull();
  });

  // The remedy differs by provenance: a run generated here can be regenerated,
  // and telling that user to "re-import this character" would be wrong.
  it('does not blame the importer for a natively-generated run whose clip is gone', async () => {
    await renderPanel(payload({
      available: false, reason: 'no-source-video', imported: false, frames: [], editable: false, lockReason: 'no-source-video',
    }));
    expect(screen.getByText(/Regenerate the direction to get a new clip/)).toBeTruthy();
    expect(screen.queryByText(/Re-import this character/)).toBeNull();
  });

  // The read is side-effect free by design; extraction is one explicit click.
  it('offers an explicit extract action when only the raw frames were cleaned', async () => {
    extractSpriteWalkSourceFrames.mockResolvedValue(payload());
    await renderPanel(payload({
      available: false, reason: 'raw-frames-cleaned', frames: [], cycle: null, selectedSourceIndices: [], editable: true, lockReason: null,
    }));
    expect(screen.getByText(/frames extracted from it were cleaned up/)).toBeTruthy();
    // The re-derive still works — that depends on the clip, not on the frames.
    expect(deriveButton()).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Extract frames from clip/ }));
    await act(async () => {});
    expect(extractSpriteWalkSourceFrames).toHaveBeenCalledWith('example-walker', RUN_ID, { silent: true });
    // The grid opens on the freshly extracted frames rather than staying closed.
    expect(screen.getAllByRole('img').length).toBe(8);
  });

  // Marking the wrong frames as "the gait cycle" is worse than marking none.
  it('withholds the markers and says why when the manifest frames are stale', async () => {
    await renderPanel(payload({ cycle: null, selectedSourceIndices: [], cycleProvenance: 'stale' }));
    expandGrid();
    expect(screen.getByText(/don't match the ones the packed strip was built from/)).toBeTruthy();
    expect(screen.getByTitle('source frame 3').className).not.toContain('ring-port-accent');
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
