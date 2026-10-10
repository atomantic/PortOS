import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import FilmLookControls from './FilmLookControls.jsx';
import { filmLookPreset } from '../../lib/filmLook.js';

describe('FilmLookControls', () => {
  it('applies a preset as a whole saved look, names each control in photography terms and writes the look as prompt words', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(<FilmLookControls look={null} onChange={onChange} onCommit={onCommit} />);
    expect(screen.getByTestId('film-look-words')).toHaveTextContent(/Move a control/);

    fireEvent.click(screen.getByRole('button', { name: 'Polaroid' }));
    const polaroid = filmLookPreset('polaroid');
    expect(onChange).toHaveBeenLastCalledWith(polaroid);
    expect(onCommit).toHaveBeenLastCalledWith(polaroid);
  });

  it('streams slider moves without saving, saves on release, and reveals a tint only once its effect is on', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const { rerender } = render(<FilmLookControls look={filmLookPreset('none')} onChange={onChange} onCommit={onCommit} />);
    expect(screen.queryByLabelText(/Halation color/)).toBeNull();

    const halation = screen.getByLabelText(/^Halation halation · highlight bloom$/);
    fireEvent.change(halation, { target: { value: '0.7' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ halation: 0.7, preset: 'custom' }));
    expect(onCommit).not.toHaveBeenCalled();

    const live = onChange.mock.calls.at(-1)[0];
    rerender(<FilmLookControls look={live} onChange={onChange} onCommit={onCommit} />);
    fireEvent.pointerUp(screen.getByLabelText(/^Halation halation · highlight bloom$/));
    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ halation: 0.7 }));
    expect(screen.getByLabelText(/Halation color/)).toBeInTheDocument();
    expect(screen.getByTestId('film-look-words')).toHaveTextContent(/halation/);
  });
});
