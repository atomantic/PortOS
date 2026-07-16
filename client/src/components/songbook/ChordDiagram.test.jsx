import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import ChordDiagram from './ChordDiagram.jsx';

describe('ChordDiagram', () => {
  it('renders a 6-string fretbox for guitar with muted/open markers and dots', () => {
    const { container } = render(<ChordDiagram name="Am" instrument="guitar" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    // Am = x02210 → 1 muted marker (×), 2 open circles, 3 finger dots.
    expect(container.textContent).toContain('×');
    const dots = svg.querySelectorAll('g circle');
    expect(dots.length).toBe(3);
    // First position — no window label.
    expect(container.textContent).not.toMatch(/fr/);
  });

  it('labels the fret window for shapes above the nut', () => {
    // C#m7 = A-form barre at fret 4.
    const { container } = render(<ChordDiagram name="C#m7" instrument="guitar" />);
    expect(container.textContent).toContain('4fr');
  });

  it('renders a 4-string fretbox for ukulele', () => {
    // G7 = 0212 → 4 strings, 3 dots, 1 open marker.
    const { container } = render(<ChordDiagram name="G7" instrument="ukulele" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg.querySelectorAll('g circle').length).toBe(3);
    expect(container.textContent).not.toContain('×');
  });

  it('renders piano voicings as note chips, prepending the slash bass', () => {
    const { container } = render(<ChordDiagram name="Am/G" instrument="piano" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toContain('A');
    expect(container.textContent).toContain('C');
    expect(container.textContent).toContain('E');
    expect(container.textContent).toContain('G');
    expect(container.textContent).toContain('bass');
    // Bass chip comes first.
    expect(container.textContent.indexOf('G')).toBeLessThan(container.textContent.indexOf('A'));
  });

  it('shows the slash-bass hint under string-instrument diagrams', () => {
    const { container } = render(<ChordDiagram name="G/B" instrument="guitar" />);
    expect(container.textContent).toContain('/B bass');
  });

  it('degrades to a muted fallback for unknown chords — no crash', () => {
    const { container } = render(<ChordDiagram name="Zq7" instrument="guitar" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toContain('no diagram');
  });
});
