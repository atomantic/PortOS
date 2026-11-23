import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseScore } from '../../lib/scoreNotation.js';

const start = vi.fn();
const stop = vi.fn();
const cancel = vi.fn();
const reset = vi.fn();
const toggleAccept = vi.fn();
const acceptAll = vi.fn();
let hookState = { phase: 'idle', beat: null, rows: [], error: null };

vi.mock('./useSingToVerify.js', () => ({
  __esModule: true,
  default: () => ({ ...hookState, start, stop, cancel, reset, toggleAccept, acceptAll }),
  VERIFY_IDLE: 'idle',
  VERIFY_COUNT_IN: 'countIn',
  VERIFY_RECORDING: 'recording',
}));

vi.mock('./ScoreSheet.jsx', () => ({
  default: ({ activeNoteIndex }) => <div data-testid="score-sheet" data-active={activeNoteIndex ?? ''} />,
}));

import SingToVerify from './SingToVerify.jsx';

const value = 'key: C\ntime: 4/4\n| C4q D4q |';
const parsedNotes = parseScore(value).measures[0].notes;

describe('SingToVerify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hookState = { phase: 'idle', beat: null, rows: [], error: null };
  });

  it('starts at the selected bar and stops an active capture', () => {
    const { rerender } = render(<SingToVerify value={`${value}\n| E4q |`} tempo={120} />);
    fireEvent.change(screen.getByLabelText(/start bar/i), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /^sing$/i }));
    expect(start).toHaveBeenCalledWith(2);

    hookState = { ...hookState, phase: 'recording', beat: 1 };
    rerender(<SingToVerify value={`${value}\n| E4q |`} tempo={120} />);
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(stop).toHaveBeenCalled();
  });

  it('toggles one written-to-sung row between accept and keep', () => {
    hookState = {
      phase: 'idle',
      beat: null,
      error: null,
      rows: [{
        index: 0,
        note: parsedNotes[0],
        written: { letter: 'C', accidental: '', octave: 4 },
        sung: { letter: 'D', accidental: 'b', octave: 4 },
        cents: 100,
        grade: 'off',
        accepted: false,
      }],
    };
    const { rerender } = render(<SingToVerify value={value} tempo={120} />);
    fireEvent.click(screen.getByRole('button', { name: /accept sung/i }));
    expect(toggleAccept).toHaveBeenCalledWith(0);

    hookState = { ...hookState, rows: [{ ...hookState.rows[0], accepted: true }] };
    rerender(<SingToVerify value={value} tempo={120} />);
    fireEvent.click(screen.getByRole('button', { name: /keep written/i }));
    expect(toggleAccept).toHaveBeenLastCalledWith(0);
  });

  it('commits only accepted pitches through onChange', () => {
    const onChange = vi.fn();
    hookState = {
      phase: 'idle',
      beat: null,
      error: null,
      rows: [
        {
          index: 0,
          note: parsedNotes[0],
          written: { letter: 'C', accidental: '', octave: 4 },
          sung: { letter: 'F', accidental: '#', octave: 4 },
          cents: 600,
          grade: 'off',
          accepted: true,
        },
        {
          index: 1,
          note: parsedNotes[1],
          written: { letter: 'D', accidental: '', octave: 4 },
          sung: { letter: 'E', accidental: '', octave: 4 },
          cents: 200,
          grade: 'off',
          accepted: false,
        },
      ],
    };
    render(<SingToVerify value={value} tempo={120} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /commit accepted notes/i }));
    expect(onChange).toHaveBeenCalledWith('key: C\ntime: 4/4\n| F#4q D4q |');
    expect(reset).toHaveBeenCalled();
  });

  it('cancels an active capture when the score text changes', () => {
    const { rerender } = render(<SingToVerify value={value} tempo={120} />);
    vi.clearAllMocks();
    hookState = { ...hookState, phase: 'recording' };

    rerender(<SingToVerify value={`${value}\n| E4q |`} tempo={120} />);

    expect(cancel).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
  });
});
