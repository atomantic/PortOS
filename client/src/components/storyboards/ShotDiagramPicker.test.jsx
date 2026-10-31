import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  SHOT_ANGLES, SHOT_ANGLE_HINTS, SHOT_ANGLE_LABELS, SHOT_COMPOSITIONS, SHOT_COMPOSITION_HINTS, SHOT_COMPOSITION_LABELS,
  SHOT_FACINGS, SHOT_FACING_HINTS, SHOT_FACING_LABELS,
  SHOT_TYPES, SHOT_TYPE_HINTS, SHOT_TYPE_LABELS,
} from '../../lib/shotGrammar';
import ShotDiagramPicker from './ShotDiagramPicker';

const FRAMING = { options: SHOT_TYPES, labels: SHOT_TYPE_LABELS, hints: SHOT_TYPE_HINTS };
const ANGLE = { options: SHOT_ANGLES, labels: SHOT_ANGLE_LABELS, hints: SHOT_ANGLE_HINTS };
const COMPOSITION = { options: SHOT_COMPOSITIONS, labels: SHOT_COMPOSITION_LABELS, hints: SHOT_COMPOSITION_HINTS };
const FACING = { options: SHOT_FACINGS, labels: SHOT_FACING_LABELS, hints: SHOT_FACING_HINTS };

describe('ShotDiagramPicker', () => {
  // A value the server accepts but the picker can't draw or label would show an
  // empty frame or a raw id.
  it.each([['framing', FRAMING], ['angle', ANGLE], ['facing', FACING], ['composition', COMPOSITION]])('draws and labels every %s the server accepts', (_name, set) => {
    render(<ShotDiagramPicker {...set} value={null} onChange={() => {}} />);
    for (const type of set.options) {
      expect(set.hints[type]).toBeTruthy();
      const tile = screen.getByRole('button', { name: set.labels[type] });
      expect(tile.querySelector('svg').querySelectorAll('path, circle').length).toBeGreaterThan(0);
    }
  });

  // ShotDiagram looks every kind up in one table, so a value shared by two
  // vocabularies would draw the wrong diagram in one of them.
  it('keeps every vocabulary value distinct', () => {
    const all = [FRAMING, ANGLE, FACING, COMPOSITION].flatMap((set) => set.options);
    expect(new Set(all).size).toBe(all.length);
  });

  it('picks a framing and clears it with a second tap', () => {
    const onChange = vi.fn();
    render(<ShotDiagramPicker {...FRAMING} value="close" onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Close-up' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Two-shot' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close-up' }));
    expect(onChange.mock.calls).toEqual([['two-shot'], [null]]);
  });
});
