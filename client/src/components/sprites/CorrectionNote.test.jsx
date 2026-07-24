import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CorrectionNote, { correctionPromptPayload } from './CorrectionNote.jsx';

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
});
