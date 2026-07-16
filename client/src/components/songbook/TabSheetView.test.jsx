import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import TabSheetView from './TabSheetView.jsx';

// Invented placeholder content only (privacy convention) — nonsense lyrics.
const SAMPLE = `[Verse 1]
C        G
Nonsense lyric line
e|--3--2--|
B|--0-----|
[C]Hello [G]world`;

describe('TabSheetView', () => {
  it('renders section labels as headings', () => {
    render(<TabSheetView text={SAMPLE} />);
    expect(screen.getByText('Verse 1')).toBeTruthy();
  });

  it('highlights chord tokens on chords lines', () => {
    const { container } = render(<TabSheetView text={SAMPLE} />);
    const highlighted = [...container.querySelectorAll('.text-port-accent.font-semibold')]
      .map((el) => el.textContent.trim());
    expect(highlighted).toContain('C');
    expect(highlighted).toContain('G');
  });

  it('renders the lyric line under the chords', () => {
    render(<TabSheetView text={SAMPLE} />);
    expect(screen.getByText('Nonsense lyric line')).toBeTruthy();
  });

  it('groups consecutive tabstaff lines into one horizontally-scrollable block', () => {
    const { container } = render(<TabSheetView text={SAMPLE} />);
    const staffBlocks = [...container.querySelectorAll('.overflow-x-auto')]
      .filter((el) => el.textContent.includes('e|--3--2--|'));
    expect(staffBlocks.length).toBe(1);
    // Both staff lines live in the same block so they scroll together.
    expect(staffBlocks[0].textContent).toContain('B|--0-----|');
  });

  it('renders chordlyric lines as a chord row above the bare lyric', () => {
    const { container } = render(<TabSheetView text={SAMPLE} />);
    // Bare lyric (brackets stripped)
    expect(screen.getByText('Hello world')).toBeTruthy();
    // Chord row: names padded out to their col offsets ("C" at 0, "G" at 6).
    const chordRow = [...container.querySelectorAll('.whitespace-pre')]
      .find((el) => /^C\s+G$/.test(el.textContent));
    expect(chordRow).toBeTruthy();
    expect(chordRow.textContent.indexOf('G')).toBe(6);
  });

  it('applies the font size scale', () => {
    const { container } = render(<TabSheetView text="plain words" fontSizeRem={1.25} />);
    expect(container.firstChild.style.fontSize).toBe('1.25rem');
  });

  it('renders empty text without crashing', () => {
    const { container } = render(<TabSheetView text="" />);
    expect(container.firstChild).toBeTruthy();
  });
});
