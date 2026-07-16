import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

  it('hides ChordPro meta directives — values belong in badges, not the sheet', () => {
    const { container } = render(
      <TabSheetView text={'{title: Example Song}\n{capo: 3}\nC G\nNonsense line'} />,
    );
    expect(container.textContent).not.toContain('{title: Example Song}');
    expect(container.textContent).not.toContain('{capo: 3}');
    expect(container.textContent).toContain('Nonsense line');
  });

  it("format='plain' renders verbatim: no headings, no chord highlighting, no chord UI", () => {
    const { container } = render(
      <TabSheetView text={SAMPLE} format="plain" showChordStrip instrumentView="piano" />,
    );
    // The raw [Verse 1] marker stays literal text (not a styled heading)...
    expect(container.textContent).toContain('[Verse 1]');
    expect(container.querySelector('.uppercase.tracking-wide')).toBeNull();
    // ...and no chord token gets the accent highlight.
    expect(container.querySelector('.text-port-accent.font-semibold')).toBeNull();
    // plain is the opt-out of ALL notation UI: no popover buttons, no
    // chords-used strip, and tab staffs stay verbatim (no collapse note) even
    // in a non-guitar view.
    expect(container.querySelector('[aria-haspopup="dialog"]')).toBeNull();
    expect(screen.queryByText('Chords used')).toBeNull();
    expect(container.textContent).toContain('e|--3--2--|');
    expect(screen.queryByText(/switch to Guitar view/)).toBeNull();
  });

  describe('chord popover (instrument views, #2656)', () => {
    it('renders chord tokens as keyboard-accessible popover buttons', () => {
      render(<TabSheetView text={SAMPLE} />);
      const button = screen.getAllByRole('button', { name: 'C' })[0];
      expect(button.getAttribute('aria-haspopup')).toBe('dialog');
      expect(button.getAttribute('aria-expanded')).toBe('false');
    });

    it('opens a voicing popover for the active instrument on tap and closes on Escape', () => {
      render(<TabSheetView text={SAMPLE} instrumentView="ukulele" />);
      const button = screen.getAllByRole('button', { name: 'C' })[0];
      fireEvent.click(button);
      const dialog = screen.getByRole('dialog', { name: 'C chord voicing' });
      expect(dialog.textContent).toContain('ukulele');
      expect(dialog.querySelector('svg')).toBeTruthy();
      expect(button.getAttribute('aria-expanded')).toBe('true');
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(button.getAttribute('aria-expanded')).toBe('false');
    });

    it('toggles the popover closed when the same chord is tapped again', () => {
      render(<TabSheetView text={SAMPLE} />);
      const button = screen.getAllByRole('button', { name: 'G' })[0];
      fireEvent.click(button);
      expect(screen.getByRole('dialog')).toBeTruthy();
      fireEvent.click(button);
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('shows piano note chips in the popover for the piano view', () => {
      render(<TabSheetView text={SAMPLE} instrumentView="piano" />);
      fireEvent.click(screen.getAllByRole('button', { name: 'G' })[0]);
      const dialog = screen.getByRole('dialog');
      expect(dialog.querySelector('svg')).toBeNull();
      expect(dialog.textContent).toContain('B');
      expect(dialog.textContent).toContain('D');
    });
  });

  describe('chords-used strip', () => {
    it('is off by default and lists unique chords in first-appearance order when enabled', () => {
      const { rerender } = render(<TabSheetView text={SAMPLE} />);
      expect(screen.queryByText('Chords used')).toBeNull();
      rerender(<TabSheetView text={SAMPLE} showChordStrip />);
      // C, G on the chords line + [C]/[G] chordlyric — unique set is {C, G}.
      expect(screen.getByText('Chords used')).toBeTruthy();
      expect(screen.getByText('(2)')).toBeTruthy();
    });

    it('collapses and re-expands', () => {
      const { container } = render(<TabSheetView text={SAMPLE} showChordStrip />);
      const toggle = screen.getByRole('button', { name: /Chords used/ });
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(container.querySelectorAll('svg').length).toBeGreaterThan(0);
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(container.querySelectorAll('svg')).toHaveLength(1); // chevron only
    });
  });

  describe('tabstaff collapse in non-guitar views', () => {
    it('keeps tab staffs visible in the guitar view', () => {
      render(<TabSheetView text={SAMPLE} instrumentView="guitar" />);
      expect(screen.getByText('e|--3--2--|')).toBeTruthy();
      expect(screen.queryByText(/switch to Guitar view/)).toBeNull();
    });

    it('collapses staff blocks to a note with an inline expand in other views', () => {
      render(<TabSheetView text={SAMPLE} instrumentView="piano" />);
      expect(screen.queryByText('e|--3--2--|')).toBeNull();
      expect(screen.getByText(/guitar tab — switch to Guitar view/)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'show' }));
      expect(screen.getByText('e|--3--2--|')).toBeTruthy();
      expect(screen.getByText('B|--0-----|')).toBeTruthy();
    });
  });
});
