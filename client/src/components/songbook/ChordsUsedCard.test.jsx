import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import ChordsUsedCard from './ChordsUsedCard.jsx';

// Invented placeholder content only (privacy convention) — nonsense lyrics.
const SAMPLE = `[Verse 1]
C        G
Nonsense lyric line
[C]Hello [G]world`;

// The card is a controlled disclosure — the viewer owns (and persists) the
// open flag — so the tests drive it through a tiny host rather than reaching
// into the component's internals.
const Host = ({ text = SAMPLE, defaultOpen = true, instrument = 'guitar' }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <ChordsUsedCard
      text={text}
      instrument={instrument}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    />
  );
};

describe('ChordsUsedCard', () => {
  it('lists unique chords in first-appearance order with a diagram each', () => {
    const { container } = render(<Host />);
    // C, G on the chords line + [C]/[G] chordlyric — unique set is {C, G}.
    expect(screen.getByRole('button', { name: /Chords used \(2\)/ })).toBeTruthy();
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(1);
  });

  it('renders nothing for a sheet with no chords — no empty header band', () => {
    const { container } = render(<Host text={'Just a lyric line\nand another'} />);
    expect(container.firstChild).toBeNull();
  });

  it('hides the diagrams when collapsed and names the chords in the header instead', () => {
    render(<Host />);
    const toggle = screen.getByRole('button', { name: /Chords used/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // Collapsed: the diagrams are gone and the summary names the chords, so a
    // closed card still says what the song asks for.
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById('song-chords-used')).toBeNull();
    expect(toggle.textContent).toContain('C · G');
  });
});
