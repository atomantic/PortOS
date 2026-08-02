import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { typeSettled } from '../../test/settledInput';

vi.mock('../../services/apiSprites.js', () => ({
  generateSpriteReference: vi.fn(() => Promise.resolve({ jobId: 'job-1' })),
  lockSpriteReference: vi.fn(() => Promise.resolve({})),
  unlockSpriteReferenceAnchor: vi.fn(() => Promise.resolve({ walkInvalidated: true })),
  unlockSpriteMainReference: vi.fn(() => Promise.resolve({ walkInvalidated: true })),
  unlockSpriteTurnaround: vi.fn(() => Promise.resolve({
    walkInvalidatedDirections: ['south', 'east'],
  })),
  updateSpriteRecord: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../ui/Toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('../imageGen/GalleryImagePicker.jsx', () => ({ default: () => null }));
vi.mock('./SpriteReferencePicker.jsx', () => ({ default: () => null }));
vi.mock('./ForkSpriteModal.jsx', () => ({ default: () => null }));
vi.mock('./SpritePreview.jsx', () => ({
  default: ({ path, className }) => (
    <button type="button" aria-label={`Enlarge ${path}`} className={className} />
  ),
}));

import ReferenceWorkflow from './ReferenceWorkflow.jsx';
import {
  generateSpriteReference,
  unlockSpriteReferenceAnchor, unlockSpriteMainReference, unlockSpriteTurnaround,
} from '../../services/apiSprites.js';

const DIRECTIONS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];

const renders = {
  pendingJobs: {},
  beginSubmit: vi.fn(),
  resolveSubmit: vi.fn(),
  cancelSubmit: vi.fn(),
};

const renderWorkflow = ({ turnaround, trackDefinitions } = {}) => render(
  <ReferenceWorkflow
    record={{ id: 'example-pioneer', name: 'Example Pioneer', chromaKey: '#FF00FF' }}
    reference={{
      manifest: {
        status: 'complete',
        ...(turnaround ? { turnaround } : {}),
        mainReference: { locked: true, path: 'reference/example-pioneer-main-v1.png' },
        anchors: DIRECTIONS.map((direction) => ({
          id: `anchor-${direction}`,
          direction,
          status: 'locked',
          path: `reference/example-pioneer-${direction}-v1.png`,
        })),
      },
      candidates: [{
        target: 'turnaround',
        path: 'reference/candidates/example-pioneer-turnaround-candidate-01.png',
        mode: 'codex',
      }],
    }}
    renders={renders}
    corrections={{}}
    onCorrectionChange={vi.fn()}
    backends={[{ id: 'codex', label: 'Codex' }]}
    trackDefinitions={trackDefinitions}
    mode="codex"
    onModeChange={vi.fn()}
    onChanged={vi.fn()}
    onForked={vi.fn()}
  />,
);

describe('ReferenceWorkflow workspace', () => {
  it('pairs the active turnaround review with the locked main on wide containers', () => {
    renderWorkflow();

    const turnaround = screen.getByRole('region', { name: 'Turnaround sheet' });
    const main = screen.getByRole('region', { name: 'Main reference' });
    const desktopWorkspace = turnaround.parentElement;

    expect(desktopWorkspace).toContainElement(main);
    expect(desktopWorkspace.className).toContain('@5xl:grid-cols-');
    expect(within(turnaround).getByRole('heading', { name: 'Candidate review' })).toBeInTheDocument();
    expect(within(turnaround).getByRole('button', { name: /Enlarge .*turnaround-candidate-01/ })).toBeInTheDocument();
    expect(within(main).getByRole('button', { name: 'Fork from this reference' })).toBeInTheDocument();
    expect(screen.getAllByText('8/8 locked').length).toBeGreaterThan(0);
  });

  it('keeps a complete anchor set compact until the user asks to inspect it', async () => {
    const user = userEvent.setup();
    renderWorkflow();

    const anchors = screen.getByRole('region', { name: 'Directional anchors' });
    expect(within(anchors).queryByRole('button', { name: /Enlarge .*north-v1/ })).not.toBeInTheDocument();

    await user.click(within(anchors).getByRole('button', { name: 'Show anchors' }));

    expect(within(anchors).getByRole('button', { name: /Enlarge .*north-v1/ })).toBeInTheDocument();
    expect(within(anchors).getByRole('button', { name: 'Hide anchors' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('confirms and unlocks one turnaround-derived anchor without exposing south', async () => {
    const user = userEvent.setup();
    renderWorkflow({
      turnaround: {
        locked: true,
        path: 'reference/example-pioneer-turnaround-v1.png',
      },
    });

    const anchors = screen.getByRole('region', { name: 'Directional anchors' });
    await user.click(within(anchors).getByRole('button', { name: 'Show anchors' }));
    expect(within(anchors).queryByRole('button', { name: 'Unlock south anchor' })).not.toBeInTheDocument();

    await user.click(within(anchors).getByRole('button', { name: 'Unlock north anchor' }));
    expect(within(anchors).getByText('Regenerate north from turnaround?')).toBeInTheDocument();
    const anchorConfirm = within(anchors).getByRole('group', { name: 'Confirm unlock north anchor' });
    await user.click(within(anchorConfirm).getByRole('button', { name: 'Unlock' }));

    expect(unlockSpriteReferenceAnchor).toHaveBeenCalledWith(
      'example-pioneer',
      { direction: 'north' },
      { silent: true },
    );
  });

  it('confirms the dependent reset before unlocking a frozen turnaround', async () => {
    const user = userEvent.setup();
    unlockSpriteTurnaround.mockClear();
    renderWorkflow({
      turnaround: {
        locked: true,
        path: 'reference/example-pioneer-turnaround-v1.png',
      },
    });

    const turnaround = screen.getByRole('region', { name: 'Turnaround sheet' });
    await user.click(within(turnaround).getByRole('button', { name: 'Unlock turnaround' }));
    expect(within(turnaround).getByText(/Reopen the turnaround, main, all 8 anchors/)).toBeInTheDocument();

    const turnaroundConfirm = within(turnaround).getByRole('group', { name: 'Confirm unlock turnaround' });
    await user.click(within(turnaroundConfirm).getByRole('button', { name: 'Unlock for regeneration' }));
    expect(unlockSpriteTurnaround).toHaveBeenCalledWith(
      'example-pioneer',
      { silent: true },
    );
  });

  it('reopens the main while retaining the locked turnaround', async () => {
    const user = userEvent.setup();
    unlockSpriteMainReference.mockClear();
    renderWorkflow({
      turnaround: {
        locked: true,
        path: 'reference/example-pioneer-turnaround-v1.png',
      },
    });

    const main = screen.getByRole('region', { name: 'Main reference' });
    await user.click(within(main).getByRole('button', { name: 'Unlock main reference' }));
    // No definitions supplied → the generic noun, never a track name this record
    // may not carry.
    expect(within(main).getByText(/Reopen the main reference and its south animations\?/)).toBeInTheDocument();
    const mainConfirm = within(main).getByRole('group', { name: 'Confirm unlock main reference' });
    await user.click(within(mainConfirm).getByRole('button', { name: 'Unlock for regeneration' }));
    expect(unlockSpriteMainReference).toHaveBeenCalledWith('example-pioneer', { silent: true });
  });

  // #3152 made every non-walk track user-defined, so the reopen warnings may not
  // name `scanner` (or any other seeded row) as copy: an install whose user
  // deleted it would be warned about an animation it does not have, and one who
  // authored their own would not be warned about the approvals being dropped.
  it('names this record\'s own directional tracks in the reopen warnings', async () => {
    const user = userEvent.setup();
    renderWorkflow({
      turnaround: { locked: true, path: 'reference/example-pioneer-turnaround-v1.png' },
      trackDefinitions: [
        { id: 'walk', label: 'Walk cycle', directional: true },
        { id: 'chest-open', label: 'Chest opening', directional: true },
        // Non-directional tracks seed from the main itself, not a per-facing
        // anchor, so they are NOT part of the anchor-dependent sweep.
        { id: 'ambient', label: 'Ambient loop', directional: false },
      ],
    });

    const main = screen.getByRole('region', { name: 'Main reference' });
    await user.click(within(main).getByRole('button', { name: 'Unlock main reference' }));
    const warning = within(main).getByText(/Reopen the main reference and its south/);
    expect(warning.textContent).toContain('walk cycle / chest opening');
    expect(warning.textContent).not.toContain('scanner');
    expect(warning.textContent).not.toContain('ambient loop');
  });

  it('re-processes one turnaround attempt with its own correction note', async () => {
    const user = userEvent.setup();
    generateSpriteReference.mockClear();
    renderWorkflow();
    const turnaround = screen.getByRole('region', { name: 'Turnaround sheet' });
    const note = within(turnaround).getByPlaceholderText(/Correction for this attempt/);
    await typeSettled(user, note, 'add the missing sleeve pocket');
    await user.click(within(turnaround).getByRole('button', { name: 'Re-process with note' }));
    expect(generateSpriteReference).toHaveBeenCalledWith('example-pioneer', {
      target: 'turnaround',
      mode: 'codex',
      initImageCandidate: 'reference/candidates/example-pioneer-turnaround-candidate-01.png',
      correctionPrompt: 'add the missing sleeve pocket',
    }, { silent: true });
  });
});

// The main derives from the locked sheet with no design input of its own, so
// before #3134 it could only be re-rolled blind. It now takes the same additive
// correction the anchors do, under its OWN key in the shared page-owned map.
describe('main-reference correction note (#3134)', () => {
  const renderUnlockedMain = (props = {}) => render(
    <ReferenceWorkflow
      record={{ id: 'example-pioneer', name: 'Example Pioneer', chromaKey: '#FF00FF' }}
      reference={{
        manifest: {
          status: 'in-progress',
          turnaround: { locked: true, path: 'reference/example-pioneer-turnaround-v1.png' },
          mainReference: { locked: false },
          anchors: [],
        },
        candidates: [],
      }}
      renders={renders}
      corrections={{}}
      onCorrectionChange={vi.fn()}
      backends={[{ id: 'codex', label: 'Codex' }]}
      mode="codex"
      onModeChange={vi.fn()}
      onChanged={vi.fn()}
      onForked={vi.fn()}
      {...props}
    />,
  );

  it('sends the main note as correctionPrompt on the main re-roll', async () => {
    const user = userEvent.setup();
    generateSpriteReference.mockClear();
    renderUnlockedMain({ corrections: { main: '  the cloak hem is cut off  ' } });
    const main = screen.getByRole('region', { name: 'Main reference' });
    await user.click(within(main).getByRole('button', { name: 'Generate candidate' }));
    expect(generateSpriteReference).toHaveBeenCalledWith('example-pioneer', {
      target: 'main',
      mode: 'codex',
      correctionPrompt: 'the cloak hem is cut off',
    }, { silent: true });
  });

  it('omits correctionPrompt entirely for a blank note (blind regenerate unchanged)', async () => {
    const user = userEvent.setup();
    generateSpriteReference.mockClear();
    renderUnlockedMain({ corrections: { main: '   ' } });
    const main = screen.getByRole('region', { name: 'Main reference' });
    await user.click(within(main).getByRole('button', { name: 'Generate candidate' }));
    expect(generateSpriteReference).toHaveBeenCalledWith(
      'example-pioneer', { target: 'main', mode: 'codex' }, { silent: true },
    );
  });

  it('does not let an anchor note ride the main re-roll', async () => {
    const user = userEvent.setup();
    generateSpriteReference.mockClear();
    renderUnlockedMain({ corrections: { east: 'no pocket on the right sleeve' } });
    const main = screen.getByRole('region', { name: 'Main reference' });
    await user.click(within(main).getByRole('button', { name: 'Generate candidate' }));
    expect(generateSpriteReference.mock.calls[0][1]).not.toHaveProperty('correctionPrompt');
  });
});
