import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Coverage for the walk viewer's loop preview (#2924). The load-bearing behavior:
// the stepped background animation is derived from the packaged strip's own
// geometry, so a 12-frame imported redraw cycle animates over 12 steps while a
// native 8-phase run keeps stepping 8 times.

vi.mock('../../services/apiSprites.js', () => ({
  generateSpriteWalk: vi.fn(),
  approveSpriteWalk: vi.fn(),
  postprocessSpriteWalk: vi.fn(),
  trimSpriteWalk: vi.fn(),
}));

import WalkWorkflow from './WalkWorkflow';

const CELL_PX = 96;

// The render-tracking hook is owned by the Sprites page now (#2931) and passed
// in, so the suite supplies it as a prop instead of mocking the module.
const noRenders = () => ({
  pendingJobs: {}, beginSubmit: vi.fn(), resolveSubmit: vi.fn(), cancelSubmit: vi.fn(),
});

const renderWalk = (stripPreview, props = {}) => {
  const run = {
    id: 'run-east', direction: 'east', status: 'approved', stripPreview,
  };
  render(
    <WalkWorkflow
      record={{ id: 'example-walker' }}
      reference={{ manifest: { mainReference: { locked: true }, anchors: [{ direction: 'east', status: 'locked' }] } }}
      walk={{
        runs: [run],
        selection: { directions: { east: { status: 'approved', runId: 'run-east' } } },
        walkSet: null,
      }}
      renders={noRenders()}
      duration={6}
      onDurationChange={vi.fn()}
      onGenerate={vi.fn()}
      onChanged={vi.fn()}
      {...props}
    />,
  );
  return screen.getByRole('img', { name: 'walk loop preview' });
};

const APPROVED_STRIP = {
  stripPath: 'grok/run-east/generated/example-walk-east-strip.png',
  frameCount: 8, fps: 12, cellWidth: 384, cellHeight: 384,
};

describe('WalkWorkflow loop preview', () => {
  it('steps a native 8-frame strip 8 times over its 12fps cycle', () => {
    const loop = renderWalk({
      stripPath: 'grok/walk-east-abc/generated/strip.png',
      frameCount: 8, fps: 12, cellWidth: 384, cellHeight: 384, row: 0, startColumn: 0,
    });
    expect(loop.style.animation).toContain('steps(8)');
    expect(loop.style.animation).toContain('0.667s');
    expect(loop.style.backgroundSize).toBe(`${CELL_PX * 8}px ${CELL_PX}px`);
  });

  // The imported redraw cycle (#2924) packs 12 frames — the pre-fix hardcoded
  // steps(8)/-768px scrub cropped it to two thirds of the stride and skewed the gait.
  it('steps an imported 12-frame redraw strip 12 times', () => {
    const loop = renderWalk({
      stripPath: 'imagegen/v19/strip-video-12-clean-alpha.png',
      frameCount: 12, fps: 12, cellWidth: 384, cellHeight: 384, row: 0, startColumn: 0,
    });
    expect(loop.style.animation).toContain('steps(12)');
    expect(loop.style.animation).toContain('1.000s');
    expect(loop.style.backgroundSize).toBe(`${CELL_PX * 12}px ${CELL_PX}px`);
    expect(loop.style.getPropertyValue('--sprite-walk-loop-end')).toBe(`-${CELL_PX * 12}px`);
    // The custom property and the @keyframes rule are two halves of one
    // mechanism — pinning only the property would let the keyframe revert to
    // its pre-fix hardcoded -768px scrub with the suite still green.
    expect(document.querySelector('style').textContent).toContain('var(--sprite-walk-loop-end)');
    expect(loop.style.backgroundImage).toContain('/data/sprites/example-walker/imagegen/v19/strip-video-12-clean-alpha.png');
  });

  it('falls back to the native 8-phase geometry when the strip carries no frame count', () => {
    const loop = renderWalk({ stripPath: 'grok/walk-east-abc/generated/strip.png' });
    expect(loop.style.animation).toContain('steps(8)');
    expect(loop.style.backgroundSize).toBe(`${CELL_PX * 8}px ${CELL_PX}px`);
  });

  it('scales the preview box to a non-square cell', () => {
    const loop = renderWalk({
      stripPath: 'grok/walk-east-abc/generated/strip.png',
      frameCount: 8, fps: 12, cellWidth: 384, cellHeight: 192,
    });
    // The box is the checkerboarded wrapper (#2930) — the scrubbing element
    // fills it, so the computed cell height is asserted on the parent.
    expect(loop.parentElement.style.height).toBe(`${CELL_PX / 2}px`);
    expect(loop.style.backgroundSize).toBe(`${CELL_PX * 8}px ${CELL_PX / 2}px`);
  });
});

// The asset collection's "Edit in Loop Trimmer" (#2931) routes back into this
// component's one TrimPanel. The run in this fixture is APPROVED, which the
// pre-existing Scissors toggle never reaches — so the panel has to render
// outside the `!finalized && !approved` action block or the action silently
// does nothing on exactly the assets most worth trimming.
describe('WalkWorkflow trim requests', () => {
  it('shows no trim panel until a run is requested', () => {
    renderWalk(APPROVED_STRIP);
    expect(screen.queryByRole('button', { name: /Save trim/ })).toBeNull();
  });

  it('opens the trim panel for an approved run named by id', () => {
    renderWalk(APPROVED_STRIP, { trimRunId: 'run-east' });
    expect(screen.getByRole('button', { name: /Save trim \(8\/8\)/ })).toBeTruthy();
  });

  it('ignores a run id that is not in this record listing', () => {
    renderWalk(APPROVED_STRIP, { trimRunId: 'run-that-does-not-exist' });
    expect(screen.queryByRole('button', { name: /Save trim/ })).toBeNull();
  });
});
