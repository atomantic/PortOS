import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SHOT_TYPES, SHOT_TYPE_LABELS } from '../../lib/shotGrammar';
import FramingPicker from './FramingPicker';

describe('FramingPicker', () => {
  // A framing the server accepts but the picker can't draw would show an empty frame.
  it('draws a diagram for every framing the server accepts', () => {
    render(<FramingPicker value={null} onChange={() => {}} />);
    for (const type of SHOT_TYPES) {
      const tile = screen.getByRole('button', { name: SHOT_TYPE_LABELS[type] });
      expect(tile.querySelector('svg').querySelectorAll('path, circle').length).toBeGreaterThan(0);
    }
  });

  it('picks a framing and clears it with a second tap', () => {
    const onChange = vi.fn();
    render(<FramingPicker value="close" onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Close-up' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Two-shot' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close-up' }));
    expect(onChange.mock.calls).toEqual([['two-shot'], [null]]);
  });
});
