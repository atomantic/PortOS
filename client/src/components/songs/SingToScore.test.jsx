import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Drive the component off a mocked hook so we control phase/result without a
// real mic or AudioContext (neither exists in jsdom). The hook itself is tested
// separately in useSingToScore.test.jsx.
const start = vi.fn();
const stop = vi.fn();
const reset = vi.fn();
let hookState = { phase: 'idle', beat: null, result: null, error: null };

vi.mock('../../hooks/useSingToScore.js', () => ({
  __esModule: true,
  default: () => ({ ...hookState, start, stop, reset }),
  SING_IDLE: 'idle',
  SING_COUNT_IN: 'countIn',
  SING_RECORDING: 'recording',
}));

import SingToScore from './SingToScore.jsx';

describe('SingToScore', () => {
  beforeEach(() => {
    start.mockClear();
    stop.mockClear();
    reset.mockClear();
    hookState = { phase: 'idle', beat: null, result: null, error: null };
  });

  it('starts capture when Sing is pressed', () => {
    render(<SingToScore value="time: 4/4" tempo={120} />);
    fireEvent.click(screen.getByRole('button', { name: /sing/i }));
    expect(start).toHaveBeenCalled();
  });

  it('shows a Stop button and stops while recording', () => {
    hookState = { phase: 'recording', beat: 2, result: null, error: null };
    render(<SingToScore value="time: 4/4" tempo={120} />);
    const stopBtn = screen.getByRole('button', { name: /stop/i });
    fireEvent.click(stopBtn);
    expect(stop).toHaveBeenCalled();
  });

  it('previews and inserts a transcribed result (append)', () => {
    const onInsert = vi.fn();
    hookState = { phase: 'idle', beat: null, result: '| C4q D4q E4q F4q |', error: null };
    render(<SingToScore value={'clef: treble\nkey: C\ntime: 4/4'} tempo={120} onInsert={onInsert} />);
    // The transcribed DSL is shown for review.
    expect(screen.getByText('| C4q D4q E4q F4q |')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /append to score/i }));
    expect(onInsert).toHaveBeenCalledWith('| C4q D4q E4q F4q |', 'append');
    expect(reset).toHaveBeenCalled();
  });

  it('disables Replace selection when nothing is selected', () => {
    hookState = { phase: 'idle', beat: null, result: '| C4q |', error: null };
    render(<SingToScore value={'time: 4/4'} tempo={120} hasSelection={false} onInsert={vi.fn()} />);
    expect(screen.getByRole('button', { name: /replace selection/i })).toBeDisabled();
  });

  it('replaces the selection when one exists', () => {
    const onInsert = vi.fn();
    hookState = { phase: 'idle', beat: null, result: '| G4q |', error: null };
    render(<SingToScore value={'time: 4/4'} tempo={120} hasSelection onInsert={onInsert} />);
    fireEvent.click(screen.getByRole('button', { name: /replace selection/i }));
    expect(onInsert).toHaveBeenCalledWith('| G4q |', 'replace');
  });

  it('shows a hint when no notes were detected', () => {
    hookState = { phase: 'idle', beat: null, result: '', error: null };
    render(<SingToScore value={'time: 4/4'} tempo={120} onInsert={vi.fn()} />);
    expect(screen.getByText(/no clear notes detected/i)).toBeInTheDocument();
  });

  it('surfaces a mic error', () => {
    hookState = { phase: 'idle', beat: null, result: null, error: 'Microphone access denied' };
    render(<SingToScore value={'time: 4/4'} tempo={120} />);
    expect(screen.getByText(/microphone access denied/i)).toBeInTheDocument();
  });
});
