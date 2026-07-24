import { describe, it, expect, vi } from 'vitest';
import {
  render, screen, act, fireEvent,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Coverage for the walk viewer's loop preview (#2924). The load-bearing behavior:
// the stepped background animation is derived from the packaged strip's own
// geometry, so a 12-frame imported redraw cycle animates over 12 steps while a
// native 8-phase run keeps stepping 8 times.

vi.mock('../../services/apiSprites.js', () => ({
  generateSpriteWalk: vi.fn(),
  approveSpriteWalk: vi.fn(() => Promise.resolve({})),
  postprocessSpriteWalk: vi.fn(() => Promise.resolve({})),
  unlockSpriteWalk: vi.fn(() => Promise.resolve({})),
  reopenSpriteWalk: vi.fn(() => Promise.resolve({})),
  setSpriteWalkTarget: vi.fn(() => Promise.resolve({})),
}));

import WalkWorkflow from './WalkWorkflow';
import { postprocessSpriteWalk, reopenSpriteWalk, setSpriteWalkTarget } from '../../services/apiSprites.js';

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

  // A strip painted as a CSS background-image fires no onError, so a missing/404
  // file would otherwise render a silent blank box. The server drops the path
  // for a known-missing strip, but a preload probe is the client-side backstop:
  // a strip that fails to load shows an explicit placeholder instead of a gap.
  it('shows a "strip missing" placeholder when the strip fails to load', async () => {
    const OriginalImage = global.Image;
    // Simulate the strip 404ing: fire onerror as soon as src is assigned.
    global.Image = class {
      set src(_v) { if (this.onerror) queueMicrotask(() => this.onerror()); }
    };
    try {
      render(
        <MemoryRouter>
          <WalkWorkflow
            record={{ id: 'example-walker' }}
            reference={{ manifest: { mainReference: { locked: true }, anchors: [{ direction: 'east', status: 'locked' }] } }}
            walk={{
              runs: [{ id: 'run-east', direction: 'east', status: 'approved', stripPreview: APPROVED_STRIP }],
              selection: { directions: { east: { status: 'approved', runId: 'run-east' } } },
              walkSet: null,
            }}
            renders={noRenders()}
            duration={6}
            onDurationChange={vi.fn()}
            onGenerate={vi.fn()}
            onChanged={vi.fn()}
          />
        </MemoryRouter>,
      );
      expect(await screen.findByText('strip missing')).toBeInTheDocument();
      // The animated loop is NOT rendered in the failed state.
      expect(screen.queryByRole('img', { name: 'walk loop preview' })).toBeNull();
    } finally {
      global.Image = OriginalImage;
    }
  });

  // When the server flags a run stripMissing (its packed strip is gone on disk)
  // it drops the stripPath, so the loop can't render. The card must show an
  // explicit indicator pointing at the recovery that works for the direction's
  // state — regenerate an unapproved/unfinalized direction, unlock a finalized
  // set — never the status==='error' "Retry postprocess" that would 409.
  const renderMissing = ({ finalized }) => render(
    <MemoryRouter>
      <WalkWorkflow
        record={{ id: 'example-walker' }}
        reference={{ manifest: { mainReference: { locked: true }, anchors: [{ direction: 'east', status: 'locked' }] } }}
        walk={{
          runs: [{ id: 'run-east', direction: 'east', status: 'candidate', stripMissing: true, stripPreview: { frameCount: 8, fps: 12, cellWidth: 384, cellHeight: 384 } }],
          selection: { directions: { east: { status: 'approved', runId: 'run-east' } } },
          walkSet: finalized ? { directions: { east: { status: 'approved' } } } : null,
        }}
        renders={noRenders()}
        duration={6}
        onDurationChange={vi.fn()}
        onGenerate={vi.fn()}
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  );

  it('shows a regenerate-oriented strip-missing indicator on an unfinalized direction', () => {
    renderMissing({ finalized: false });
    expect(screen.getByText(/Walk strip missing on disk — regenerate to repack it\./)).toBeInTheDocument();
    // No dead "Retry postprocess" button (that path is gated on status==='error').
    expect(screen.queryByRole('button', { name: /Retry postprocess|Re-run postprocess/ })).toBeNull();
    expect(screen.queryByRole('img', { name: 'walk loop preview' })).toBeNull();
  });

  it('points a finalized direction at unlock instead of regenerate', () => {
    renderMissing({ finalized: true });
    expect(screen.getByText(/Walk strip missing on disk — unlock the set to regenerate this direction\./)).toBeInTheDocument();
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

// Loop trimming moved to its own deep-linkable workspace (#2933): the inline
// TrimPanel is gone and each card just links into the trimmer. The link stands
// for approved/finalized directions too (a trim is a non-destructive artifact),
// and now for ANY run that carries a packed strip — the trim service resolves
// geometry layout-agnostically, so the old `grok/`-only gate is gone.
describe('WalkWorkflow loop trimmer link', () => {
  it('offers "Edit in Loop Trimmer" for an approved grok run and fires with its id', () => {
    const onOpenTrimmer = vi.fn();
    renderWalk(APPROVED_STRIP, { onOpenTrimmer });
    const link = screen.getByRole('button', { name: /Edit in Loop Trimmer/ });
    link.click();
    expect(onOpenTrimmer).toHaveBeenCalledWith('run-east');
  });

  it('renders no inline trim panel', () => {
    renderWalk(APPROVED_STRIP, { onOpenTrimmer: vi.fn() });
    expect(screen.queryByRole('button', { name: /Save trim/ })).toBeNull();
  });

  it('offers the link for an imported/redraw run whose strip is not under grok/', () => {
    // The exact case that left pioneer's east without a trim button: a strip
    // outside grok/ (imported runs/ or an imagegen redraw) is now trimmable.
    const onOpenTrimmer = vi.fn();
    renderWalk({
      stripPath: 'imagegen/v19/clean-alpha.png', frameCount: 12, fps: 12, cellWidth: 384, cellHeight: 384,
    }, { onOpenTrimmer });
    const link = screen.getByRole('button', { name: /Edit in Loop Trimmer/ });
    link.click();
    expect(onOpenTrimmer).toHaveBeenCalledWith('run-east');
  });
});

// Render the workflow with a single run of the given shape. Router-wrapped so
// the card's <Link> (shown while rendering) resolves in every case.
// `walkTarget` is the server-resolved set-level cycle target (#2985); tests that
// care about provenance/drift override it, the rest get the plain default.
const renderRun = (run, { walkTarget, onChanged = vi.fn() } = {}) => render(
  <MemoryRouter>
    <WalkWorkflow
      record={{ id: 'example-walker' }}
      reference={{ manifest: { mainReference: { locked: true }, anchors: [{ direction: 'east', status: 'locked' }] } }}
      walk={{
        runs: [run],
        selection: { directions: {} },
        walkSet: null,
        walkTarget: walkTarget || {
          track: 'walk', frameCount: 12, fps: 10, source: 'default', drift: [],
        },
      }}
      renders={noRenders()}
      duration={2}
      onDurationChange={vi.fn()}
      onGenerate={vi.fn()}
      onChanged={onChanged}
    />
  </MemoryRouter>,
);

describe('WalkWorkflow failed-run clip', () => {
  it('renders grok\'s raw clip and the error text when postprocess failed', () => {
    renderRun({
      id: 'walk-east-deadbeef', direction: 'east', status: 'error',
      postprocessError: 'Measured background [0,0,0] is not a usable #FF00FF matte',
      sourceVideoPath: 'runs/walk-east-deadbeef/generated/source-video.mp4',
    });
    const video = screen.getByLabelText('raw grok walk clip (east)');
    expect(video.getAttribute('src')).toBe(
      '/data/sprites/example-walker/runs/walk-east-deadbeef/generated/source-video.mp4',
    );
    expect(screen.getByText(/not a usable #FF00FF matte/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Retry postprocess/ })).toBeTruthy();
  });

  it('shows only the error text when no clip landed', () => {
    renderRun({
      id: 'walk-east-deadbeef', direction: 'east', status: 'error', postprocessError: 'boom',
    });
    expect(screen.queryByLabelText('raw grok walk clip (east)')).toBeNull();
    expect(screen.getByText('boom')).toBeTruthy();
  });
});

describe('WalkWorkflow observable render', () => {
  it('links to the live Shell session while grok is rendering', () => {
    renderRun({
      id: 'walk-east-abc12345', direction: 'east', status: 'rendering', shellSession: 'walk-east-abc12345',
    });
    const link = screen.getByRole('link', { name: /Watch in Shell/ });
    expect(link.getAttribute('href')).toBe('/shell/walk-east-abc12345');
    // Generate is disabled while rendering (server truth), showing the spinner.
    expect(screen.getByRole('button', { name: /Rendering/ })).toBeDisabled();
  });

  it('shows no shell link once the render has moved on to packaging', () => {
    renderRun({
      id: 'walk-east-abc12345', direction: 'east', status: 'postprocessing', shellSession: 'walk-east-abc12345',
    });
    expect(screen.queryByRole('link', { name: /Watch in Shell/ })).toBeNull();
  });
});

describe('WalkWorkflow authoring controls', () => {
  it('offers a set-level Cycle target, Preview speed, and grok-real Clip options', () => {
    renderRun({ id: 'walk-east-deadbeef', direction: 'east', status: 'error', postprocessError: 'x' });
    // Clip length is now just grok's real 6s/10s options (shorter was a no-op).
    const clip = screen.getByRole('combobox', { name: /Clip/ });
    expect([...clip.options].map((o) => o.value)).toEqual(['6', '10']);
    // Frame count + speed are ONE set-level target now (#2985), not per-render
    // inputs that can drift between directions.
    expect(screen.getByRole('combobox', { name: /Cycle target/ })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: /Preview speed/ })).toBeTruthy();
    // …and the cycle-duration readout reflects the defaults (12f / 10fps = 1.20s).
    expect(screen.getByText(/1\.20s \/ cycle/)).toBeTruthy();
  });

  it('labels the target with where the value came from', () => {
    renderRun(
      { id: 'walk-east-deadbeef', direction: 'east', status: 'error', postprocessError: 'x' },
      { walkTarget: { frameCount: 8, fps: 12, source: 'derived', drift: [] } },
    );
    expect(screen.getByText('from the first approved direction')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: /Cycle target/ }).value).toBe('8');
  });

  it('renders the target read-only and names the app when the publish binding pins it', () => {
    renderRun(
      { id: 'walk-east-deadbeef', direction: 'east', status: 'error', postprocessError: 'x' },
      {
        walkTarget: {
          frameCount: 16, fps: 10, source: 'app', frameCountLocked: true, appId: 'example-game', drift: [],
        },
      },
    );
    expect(screen.getByRole('combobox', { name: /Cycle target/ }).disabled).toBe(true);
    expect(screen.getByText(/locked by the bound app \(example-game\)/)).toBeTruthy();
    // fps is not in the contract, so it stays editable.
    expect(screen.getByRole('combobox', { name: /Preview speed/ }).disabled).toBe(false);
  });

  it('saves a new target to the set and refreshes', async () => {
    const onChanged = vi.fn();
    renderRun(
      { id: 'walk-east-deadbeef', direction: 'east', status: 'error', postprocessError: 'x' },
      { onChanged },
    );
    const select = screen.getByRole('combobox', { name: /Cycle target/ });
    await act(async () => {
      fireEvent.change(select, { target: { value: '14' } });
    });
    expect(setSpriteWalkTarget).toHaveBeenCalledWith(
      'example-walker', { frameCount: 14, fps: 10 }, { silent: true },
    );
    expect(onChanged).toHaveBeenCalled();
  });
});

describe('WalkWorkflow cycle-target drift', () => {
  const DRIFTED = {
    walkTarget: {
      frameCount: 12,
      fps: 10,
      source: 'set',
      drift: [{
        direction: 'east', frameCount: 8, fps: 10, frameCountDrifts: true, fpsDrifts: false,
      }],
    },
  };

  it('badges a packaged direction that no longer matches the target', () => {
    renderRun({
      id: 'walk-east-abc12345',
      direction: 'east',
      status: 'candidate',
      sourceVideoPath: 'runs/walk-east-abc12345/generated/source-video.mp4',
      stripPreview: { stripPath: 'runs/walk-east-abc12345/generated/strip.png', frameCount: 8, fps: 10, cellWidth: 384, cellHeight: 384 },
    }, DRIFTED);
    expect(screen.getByText(/8f · re-derive to 12f @ 10fps/)).toBeTruthy();
    expect(screen.getByText('reprocess it from its clip')).toBeTruthy();
    // …and a set-level summary so it is visible before eight renders are spent.
    expect(screen.getByText(/1 of 8 packaged directions differs from the 12f @ 10fps target/)).toBeTruthy();
  });

  it('points a drifted direction with no source clip at an import instead', () => {
    renderRun({
      id: 'imported-east',
      direction: 'east',
      status: 'candidate',
      stripPreview: { stripPath: 'runs/imported-east/generated/strip.png', frameCount: 8, fps: 10, cellWidth: 384, cellHeight: 384 },
    }, DRIFTED);
    expect(screen.getByText('import this direction\'s source clip to re-derive it')).toBeTruthy();
  });
});

describe('WalkWorkflow reprocess + reopen', () => {
  it('reprocesses a candidate from its on-disk clip at the current count/fps', async () => {
    renderRun({
      id: 'walk-east-abc12345', direction: 'east', status: 'candidate',
      stripPreview: { stripPath: 'runs/walk-east-abc12345/generated/strip.png', frameCount: 12, fps: 10, cellWidth: 384, cellHeight: 384 },
    });
    await act(async () => { screen.getByRole('button', { name: /Reprocess/ }).click(); });
    expect(postprocessSpriteWalk).toHaveBeenCalledWith(
      'example-walker',
      { runId: 'walk-east-abc12345', frameCount: 12, fps: 10 },
      { silent: true },
    );
  });

  it('reopens an approved direction after an inline confirm', async () => {
    render(
      <MemoryRouter>
        <WalkWorkflow
          record={{ id: 'example-walker' }}
          reference={{ manifest: { mainReference: { locked: true }, anchors: [{ direction: 'east', status: 'locked' }] } }}
          walk={{
            runs: [{ id: 'run-east', direction: 'east', status: 'approved', stripPreview: { stripPath: 'runs/run-east/generated/strip.png', frameCount: 12, fps: 10, cellWidth: 384, cellHeight: 384 } }],
            selection: { directions: { east: { status: 'approved', runId: 'run-east' } } },
            walkSet: null,
          }}
          renders={noRenders()}
          duration={6}
          onDurationChange={vi.fn()}
          onGenerate={vi.fn()}
          onChanged={vi.fn()}
        />
      </MemoryRouter>,
    );
    act(() => { screen.getByRole('button', { name: /^Reopen$/ }).click(); });
    // Inline confirm surfaces, then the confirm fires the API.
    await act(async () => { screen.getByRole('button', { name: /^Reopen$/ }).click(); });
    expect(reopenSpriteWalk).toHaveBeenCalledWith('example-walker', { direction: 'east' }, { silent: true });
  });
});
