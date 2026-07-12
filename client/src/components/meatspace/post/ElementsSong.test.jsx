import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ElementsSong from './ElementsSong';

// The Flash Cards study mode (issue #2480) is a flip-to-reveal study surface —
// distinct from the Element Flash recall test — that must still advance element
// mastery through the shared submitMemoryPractice path. These tests pin that
// contract: the mode is offered, a card flips + self-rates, and completing the
// deck submits `mode: 'element-study'` with element-tagged results.

const submitMemoryPractice = vi.fn(() => Promise.resolve({ mastery: { overallPct: 10, chunks: {}, elements: {} } }));

vi.mock('../../../services/api', () => ({
  submitMemoryPractice: (...args) => submitMemoryPractice(...args),
  getMemoryMastery: () => Promise.resolve(null),
  getMemoryItem: () => Promise.resolve(null),
}));

// The RapidReader modal pulls in browser-only APIs; the study flow never opens
// it, so stub it out to keep the render lightweight.
vi.mock('../../RapidReader', () => ({ RapidReaderModal: () => null }));

const item = {
  id: 'elements-song',
  title: 'The Elements Song',
  content: {
    lines: [],
    chunks: [],
    elementMap: {
      H: { name: 'Hydrogen', atomicNumber: 1 },
      He: { name: 'Helium', atomicNumber: 2 },
    },
  },
  mastery: { overallPct: 0, chunks: {}, elements: {} },
};

const settle = () => act(async () => {});

beforeEach(() => submitMemoryPractice.mockClear());

describe('ElementsSong — Flash Cards study mode', () => {
  it('offers a Flash Cards study mode alongside the recall test', async () => {
    render(<ElementsSong item={item} onBack={() => {}} />);
    await settle();
    expect(screen.getByText('Flash Cards')).toBeInTheDocument();
    expect(screen.getByText('Study element name ↔ symbol pairings')).toBeInTheDocument();
    // The recall test is still present — study augments, it doesn't replace.
    expect(screen.getByText('Element Flash')).toBeInTheDocument();
  });

  it('flips a card to reveal the pairing, then self-rates through the deck and submits element-study mastery', async () => {
    render(<ElementsSong item={item} onBack={() => {}} />);
    await settle();

    fireEvent.click(screen.getByText('Flash Cards'));
    await settle();

    // Two elements → a 2-card deck. Reveal + rate each card.
    for (let i = 0; i < 2; i++) {
      // Reveal the hidden face (the explicit Reveal button under the card).
      fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
      await settle();
      // Self-rate: mark the first known, the second not-known, so the submitted
      // results carry a mix of correct flags.
      fireEvent.click(screen.getByText(i === 0 ? 'Got It' : 'Study Again'));
      await settle();
    }

    // Completion screen → persist the study reps.
    fireEvent.click(screen.getByText('Save & Return'));
    await settle();

    expect(submitMemoryPractice).toHaveBeenCalledTimes(1);
    const [id, payload] = submitMemoryPractice.mock.calls[0];
    expect(id).toBe('elements-song');
    expect(payload.mode).toBe('element-study');
    expect(payload.results).toHaveLength(2);
    // Every result is element-tagged (drives per-element mastery server-side) and
    // exactly one was marked known.
    expect(payload.results.every((r) => r.element === 'H' || r.element === 'He')).toBe(true);
    expect(payload.results.filter((r) => r.correct)).toHaveLength(1);
  });
});
