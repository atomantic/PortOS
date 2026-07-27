import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// The place/object surface has two independent regeneration actions — the at-rest
// identity still and the image-to-video loop — and #3134 gave each its own
// correction note in the shared page-owned map. The load-bearing behavior here is
// that the two notes stay separate (a reference fix must not ride the loop
// prompt) and that the reference note is ADDITIVE to the design prompt rather
// than a replacement for it.

vi.mock('../../services/apiSprites.js', () => ({
  approveSpriteAmbient: vi.fn(() => Promise.resolve({})),
  lockSpriteReference: vi.fn(() => Promise.resolve({})),
}));

import AmbientWorkflow from './AmbientWorkflow.jsx';

const record = { id: 'example-grove', kind: 'place', name: 'Example Grove' };
const CANDIDATE = { target: 'main', path: 'reference/candidates/main-candidate-01.png' };

const renderAmbient = (props = {}) => render(
  <AmbientWorkflow
    record={record}
    reference={{ manifest: { mainReference: { locked: false } }, candidates: [CANDIDATE] }}
    ambient={{ runs: [], selection: null, ambientSet: null }}
    renders={{ pendingJobs: {} }}
    hasBackend
    mode="codex"
    onGenerateReference={vi.fn()}
    onGenerateAmbient={vi.fn()}
    onChanged={vi.fn()}
    {...props}
  />,
);

// A locked main flips the panel from the reference step to the loop step.
const lockedReference = { manifest: { mainReference: { locked: true, path: 'reference/example-grove-main-v1.png' } }, candidates: [] };

describe('AmbientWorkflow correction notes (#3134)', () => {
  it('offers a reference correction once there is a candidate to correct', () => {
    const onCorrectionChange = vi.fn();
    renderAmbient({ corrections: {}, onCorrectionChange });
    fireEvent.click(screen.getByRole('button', { name: /Show correction note for ambient reference/i }));
    fireEvent.change(screen.getByLabelText(/Correction guidance for the ambient reference/i), {
      target: { value: 'the trunk leans too far right' },
    });
    const merged = onCorrectionChange.mock.calls[0][0]({});
    expect(merged).toHaveProperty('ambient-reference');
    // The design prompt is a SEPARATE control — the correction is additive, so it
    // must not be written into the design field's state.
    expect(merged).not.toHaveProperty('designPrompt');
  });

  it('does not offer a reference correction before the first render exists', () => {
    renderAmbient({
      reference: { manifest: { mainReference: { locked: false } }, candidates: [] },
      corrections: {},
      onCorrectionChange: vi.fn(),
    });
    expect(screen.queryByRole('button', { name: /correction note/i })).toBeNull();
  });

  it('gives the loop its own note, distinct from the reference note', () => {
    const onCorrectionChange = vi.fn();
    renderAmbient({ reference: lockedReference, corrections: {}, onCorrectionChange });
    fireEvent.click(screen.getByRole('button', { name: /Show correction note for ambient loop/i }));
    fireEvent.change(screen.getByLabelText(/Correction guidance for the ambient loop/i), {
      target: { value: 'the branches barely move' },
    });
    const merged = onCorrectionChange.mock.calls[0][0]({ 'ambient-reference': 'keep me' });
    expect(merged['ambient-reference']).toBe('keep me');
    expect(merged).toHaveProperty('ambient-loop');
  });

  it('prefills an existing loop note so a set correction is never invisible', () => {
    renderAmbient({
      reference: lockedReference,
      corrections: { 'ambient-loop': 'the branches barely move' },
      onCorrectionChange: vi.fn(),
    });
    expect(screen.getByLabelText(/Correction guidance for the ambient loop/i))
      .toHaveValue('the branches barely move');
  });

  it('omits every affordance when the page supplies no writer', () => {
    renderAmbient({ reference: lockedReference });
    expect(screen.queryByRole('button', { name: /correction note/i })).toBeNull();
  });

  it('hides the loop note once the ambient set is finalized', () => {
    renderAmbient({
      reference: lockedReference,
      ambient: { runs: [], selection: null, ambientSet: { status: 'final' } },
      corrections: {},
      onCorrectionChange: vi.fn(),
    });
    expect(screen.queryByRole('button', { name: /correction note/i })).toBeNull();
  });
});
