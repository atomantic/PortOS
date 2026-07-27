import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CorrectionNote, {
  CorrectionNoteToggle, correctionPromptPayload,
  anchorCorrectionKey, walkCorrectionKey, scannerCorrectionKey,
  MAIN_CORRECTION_KEY, AMBIENT_REFERENCE_CORRECTION_KEY, AMBIENT_LOOP_CORRECTION_KEY,
} from './CorrectionNote.jsx';

// The shared anchor-correction module (#2964). `correctionPromptPayload` is the
// single source at the REQUEST layer — both re-roll surfaces (the reference
// workflow grid and the asset card via Sprites' generateAnchor) spread it, so a
// regression that dropped the correction or stopped trimming would flip these.
describe('correctionPromptPayload', () => {
  it('sends a non-empty correction as correctionPrompt', () => {
    expect(correctionPromptPayload({ east: 'no pocket on the right sleeve' }, 'east'))
      .toEqual({ correctionPrompt: 'no pocket on the right sleeve' });
  });

  it('trims surrounding whitespace before sending', () => {
    expect(correctionPromptPayload({ east: '  fix the arm  ' }, 'east'))
      .toEqual({ correctionPrompt: 'fix the arm' });
  });

  it('omits the field for a whitespace-only note (server treats it as absent)', () => {
    expect(correctionPromptPayload({ east: '   ' }, 'east')).toEqual({});
  });

  it('omits the field when the direction has no note', () => {
    expect(correctionPromptPayload({ west: 'x' }, 'east')).toEqual({});
    expect(correctionPromptPayload({}, 'east')).toEqual({});
  });

  it('tolerates a null/undefined corrections map', () => {
    expect(correctionPromptPayload(null, 'east')).toEqual({});
    expect(correctionPromptPayload(undefined, 'east')).toEqual({});
  });
});

// The whole point of namespacing (#3134): one page-owned map serves every
// surface, but a still-image anchor note must never ride a walk VIDEO re-roll.
describe('correction keys are namespaced per surface (#3134)', () => {
  it('keeps the bare direction for anchors so pre-#3134 state still resolves', () => {
    expect(anchorCorrectionKey('east')).toBe('east');
  });

  it('gives every other surface a distinct key', () => {
    const keys = [
      anchorCorrectionKey('east'),
      walkCorrectionKey('east'),
      scannerCorrectionKey('east'),
      MAIN_CORRECTION_KEY,
      AMBIENT_REFERENCE_CORRECTION_KEY,
      AMBIENT_LOOP_CORRECTION_KEY,
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('does not let an anchor note leak into that direction\'s walk or scanner re-roll', () => {
    const corrections = { east: 'no pocket on the right sleeve' };
    expect(correctionPromptPayload(corrections, anchorCorrectionKey('east')))
      .toEqual({ correctionPrompt: 'no pocket on the right sleeve' });
    expect(correctionPromptPayload(corrections, walkCorrectionKey('east'))).toEqual({});
    expect(correctionPromptPayload(corrections, scannerCorrectionKey('east'))).toEqual({});
  });

  it('keeps each direction\'s walk note separate', () => {
    const corrections = { [walkCorrectionKey('east')]: 'the legs barely lift' };
    expect(correctionPromptPayload(corrections, walkCorrectionKey('east')))
      .toEqual({ correctionPrompt: 'the legs barely lift' });
    expect(correctionPromptPayload(corrections, walkCorrectionKey('west'))).toEqual({});
  });
});

describe('CorrectionNote component', () => {
  it('renders the shared value and writes a per-direction updater on change', async () => {
    const onChange = vi.fn();
    render(<CorrectionNote direction="east" value="keep pose" onChange={onChange} />);
    const textarea = screen.getByLabelText(/Correction guidance for the east pose/i);
    expect(textarea).toHaveValue('keep pose');
    await userEvent.type(textarea, '!');
    const updater = onChange.mock.calls[0][0];
    // The updater merges by direction, preserving other directions' notes.
    const merged = updater({ west: 'other' });
    expect(merged.west).toBe('other');
    expect(merged).toHaveProperty('east');
  });

  it('writes through an explicit noteKey, so a namespaced surface merges correctly', async () => {
    // Driven through real page-owned state (the production wiring): the updater
    // reads the event lazily, so only a live reducer proves the value lands.
    function Host() {
      const [corrections, setCorrections] = useState({ east: 'anchor note' });
      return (
        <>
          <CorrectionNote
            noteKey={walkCorrectionKey('east')}
            value={corrections[walkCorrectionKey('east')]}
            onChange={setCorrections}
          />
          <output data-testid="state">{JSON.stringify(corrections)}</output>
        </>
      );
    }
    render(<Host />);
    await userEvent.type(screen.getByLabelText(/Correction guidance/i), 'hi');
    // The anchor's still-image note survives; the walk note lands on its own key.
    expect(JSON.parse(screen.getByTestId('state').textContent))
      .toEqual({ east: 'anchor note', 'walk:east': 'hi' });
  });
});

describe('CorrectionNoteToggle', () => {
  it('starts collapsed with no note and reveals the textarea on toggle', async () => {
    const onChange = vi.fn();
    render(
      <CorrectionNoteToggle
        noteKey={walkCorrectionKey('east')}
        label="east walk cycle"
        corrections={{}}
        onChange={onChange}
      />,
    );
    expect(screen.queryByLabelText(/Correction guidance/i)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Show correction note for east walk cycle/i }));
    expect(screen.getByLabelText(/Correction guidance for the east walk cycle re-roll/i)).toBeInTheDocument();
  });

  it('auto-opens with an existing note so a set correction is never invisible', () => {
    render(
      <CorrectionNoteToggle
        noteKey={walkCorrectionKey('east')}
        label="east walk cycle"
        corrections={{ 'walk:east': 'the legs barely lift' }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/Correction guidance for the east walk cycle re-roll/i))
      .toHaveValue('the legs barely lift');
  });
});
