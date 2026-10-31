import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  SHOT_ANGLES, SHOT_ANGLE_HINTS, SHOT_ANGLE_LABELS, SHOT_COMPOSITIONS, SHOT_COMPOSITION_HINTS, SHOT_COMPOSITION_LABELS,
  SHOT_EYELINES, SHOT_EYELINE_HINTS, SHOT_EYELINE_LABELS, SHOT_FACINGS, SHOT_FACING_HINTS, SHOT_FACING_LABELS,
  SHOT_FOCUSES, SHOT_FOCUS_HINTS, SHOT_FOCUS_LABELS, SHOT_LENSES, SHOT_LENS_HINTS, SHOT_LENS_LABELS,
  SHOT_MOVES, SHOT_MOVE_HINTS, SHOT_MOVE_LABELS,
  SHOT_TYPES, SHOT_TYPE_HINTS, SHOT_TYPE_LABELS,
} from '../../lib/shotGrammar';
import ShotDiagramPicker from './ShotDiagramPicker';

const FRAMING = { options: SHOT_TYPES, labels: SHOT_TYPE_LABELS, hints: SHOT_TYPE_HINTS };
const ANGLE = { options: SHOT_ANGLES, labels: SHOT_ANGLE_LABELS, hints: SHOT_ANGLE_HINTS };
const COMPOSITION = { options: SHOT_COMPOSITIONS, labels: SHOT_COMPOSITION_LABELS, hints: SHOT_COMPOSITION_HINTS };
const FACING = { options: SHOT_FACINGS, labels: SHOT_FACING_LABELS, hints: SHOT_FACING_HINTS };
const EYELINE = { options: SHOT_EYELINES, labels: SHOT_EYELINE_LABELS, hints: SHOT_EYELINE_HINTS };
const LENS = { options: SHOT_LENSES, labels: SHOT_LENS_LABELS, hints: SHOT_LENS_HINTS };
const FOCUS = { options: SHOT_FOCUSES, labels: SHOT_FOCUS_LABELS, hints: SHOT_FOCUS_HINTS };
const MOVE = { options: SHOT_MOVES, labels: SHOT_MOVE_LABELS, hints: SHOT_MOVE_HINTS };
const SETS = [['framing', FRAMING], ['angle', ANGLE], ['facing', FACING], ['eyeline', EYELINE], ['composition', COMPOSITION],
  ['lens', LENS], ['focus', FOCUS], ['move', MOVE]];

describe('ShotDiagramPicker', () => {
  // A value the server accepts but the picker can't draw or label would show an
  // empty frame or a raw id.
  it.each(SETS)('draws and labels every %s the server accepts', (_name, set) => {
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
    const all = SETS.flatMap(([, set]) => set.options);
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
