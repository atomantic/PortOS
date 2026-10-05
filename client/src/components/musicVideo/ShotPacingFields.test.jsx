// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ShotPacingFields from './ShotPacingFields.jsx';

describe('ShotPacingFields', () => {
  it('saves an in-range value locally and to the project', () => {
    const onEditLocal = vi.fn();
    const onSave = vi.fn();
    render(<ShotPacingFields project={{ id: 'p', pacing: { hookSec: 2 } }} onEditLocal={onEditLocal} onSave={onSave} />);
    const input = screen.getByLabelText('Longest shot (s)');
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.blur(input);
    expect(onEditLocal).toHaveBeenCalledWith({ pacing: { hookSec: 2, maxShotSec: 4 } });
    expect(onSave).toHaveBeenCalledWith({ pacing: { hookSec: 2, maxShotSec: 4 } });
  });

  it('refuses an out-of-range value and restores the saved one', () => {
    const onSave = vi.fn();
    render(<ShotPacingFields project={{ id: 'p', pacing: { minShotSec: 1 } }} onEditLocal={vi.fn()} onSave={onSave} />);
    const input = screen.getByLabelText('Shortest shot (s)');
    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.blur(input);
    expect(onSave).not.toHaveBeenCalled();
    expect(input.value).toBe('1');
  });

  it('clears the pacing object when the last field is emptied', () => {
    const onSave = vi.fn();
    render(<ShotPacingFields project={{ id: 'p', pacing: { hookSec: 2 } }} onEditLocal={vi.fn()} onSave={onSave} />);
    const input = screen.getByLabelText('Opening hook (s)');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onSave).toHaveBeenCalledWith({ pacing: null });
  });
});
