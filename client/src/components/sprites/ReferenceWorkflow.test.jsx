import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/apiSprites.js', () => ({
  generateSpriteReference: vi.fn(() => Promise.resolve({ jobId: 'job-1' })),
  lockSpriteReference: vi.fn(() => Promise.resolve({})),
  unlockSpriteReferenceAnchor: vi.fn(() => Promise.resolve({ walkInvalidated: true })),
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
  unlockSpriteReferenceAnchor, unlockSpriteTurnaround,
} from '../../services/apiSprites.js';

const DIRECTIONS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];

const renders = {
  pendingJobs: {},
  beginSubmit: vi.fn(),
  resolveSubmit: vi.fn(),
  cancelSubmit: vi.fn(),
};

const renderWorkflow = ({ turnaround } = {}) => render(
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
    await user.click(within(anchors).getByRole('button', { name: 'Confirm unlock north anchor' }));

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

    await user.click(within(turnaround).getByRole('button', { name: 'Confirm unlock turnaround' }));
    expect(unlockSpriteTurnaround).toHaveBeenCalledWith(
      'example-pioneer',
      { silent: true },
    );
  });

  it('re-processes one turnaround attempt with its own correction note', async () => {
    const user = userEvent.setup();
    generateSpriteReference.mockClear();
    renderWorkflow();
    const turnaround = screen.getByRole('region', { name: 'Turnaround sheet' });
    const note = within(turnaround).getByPlaceholderText(/Correction for this attempt/);
    await user.type(note, 'add the missing sleeve pocket');
    await user.click(within(turnaround).getByRole('button', { name: 'Re-process with note' }));
    expect(generateSpriteReference).toHaveBeenCalledWith('example-pioneer', {
      target: 'turnaround',
      mode: 'codex',
      initImageCandidate: 'reference/candidates/example-pioneer-turnaround-candidate-01.png',
      correctionPrompt: 'add the missing sleeve pocket',
    }, { silent: true });
  });
});
