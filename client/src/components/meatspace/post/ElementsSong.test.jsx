import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ElementsSong, { recommendedElementsMode } from './ElementsSong';

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

// The practice mode is URL-driven — PostTab owns the route and feeds it back as
// the `mode` prop (issue #3249). This stands in for that routing so the tests
// can drive a mode by clicking its card, exactly as a user does.
function RoutedElementsSong(props) {
  const [mode, setMode] = useState(null);
  return (
    <ElementsSong
      {...props}
      mode={mode}
      onSelectMode={setMode}
      onExitMode={() => setMode(null)}
    />
  );
}

beforeEach(() => submitMemoryPractice.mockClear());

describe('ElementsSong — Flash Cards study mode', () => {
  it('offers a Flash Cards study mode alongside the recall test', async () => {
    render(<RoutedElementsSong item={item} onBack={() => {}} />);
    await settle();
    expect(screen.getByText('Flash Cards')).toBeInTheDocument();
    expect(screen.getByText('Study element name ↔ symbol pairings')).toBeInTheDocument();
    // The recall test is still present — study augments, it doesn't replace.
    expect(screen.getByText('Element Flash')).toBeInTheDocument();
  });

  it('flips a card to reveal the pairing, then self-rates through the deck and submits element-study mastery', async () => {
    render(<RoutedElementsSong item={item} onBack={() => {}} />);
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

describe('ElementsSong — routed practice modes (issue #3249)', () => {
  it('enters a mode via the mode prop alone, with no click — a cold deep link', async () => {
    render(<ElementsSong item={item} mode="element-flash" onSelectMode={() => {}} onExitMode={() => {}} onBack={() => {}} />);
    await settle();
    // The recall quiz is running, not the mode picker.
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    expect(screen.queryByText('Periodic Table')).not.toBeInTheDocument();
  });

  it('reports mode selection to the router instead of holding it in local state', async () => {
    const onSelectMode = vi.fn();
    render(<ElementsSong item={item} mode={null} onSelectMode={onSelectMode} onExitMode={() => {}} onBack={() => {}} />);
    await settle();
    fireEvent.click(screen.getByText('Element Flash'));
    await settle();
    expect(onSelectMode).toHaveBeenCalledWith('element-flash');
    // Nothing entered locally — the URL is the source of truth, so the picker
    // is still rendered until the router feeds `mode` back in.
    expect(screen.getByText('Periodic Table')).toBeInTheDocument();
  });

  it('leads with Practice above the Periodic Table, flagging the recommended mode', async () => {
    const { container } = render(<RoutedElementsSong item={item} onBack={() => {}} />);
    await settle();
    const headings = [...container.querySelectorAll('h3')].map((h) => h.textContent);
    expect(headings.indexOf('Practice')).toBeLessThan(headings.indexOf('Periodic Table'));
    // Nothing practiced yet → Flash Cards is the "Start here" entry point.
    const startHere = screen.getByText('Start here');
    expect(startHere.closest('button').textContent).toContain('Flash Cards');
  });
});

describe('recommendedElementsMode', () => {
  it('sends a never-practiced user to the study deck first', () => {
    expect(recommendedElementsMode({ elements: {}, chunks: {} })).toBe('element-study');
    expect(recommendedElementsMode(null)).toBe('element-study');
    // Zero attempts is "not practiced", not "practiced badly".
    expect(recommendedElementsMode({ elements: { H: { attempts: 0, correct: 0 } } })).toBe('element-study');
  });

  it('sends weak element recall to the recall test', () => {
    expect(recommendedElementsMode({ elements: { H: { attempts: 10, correct: 3 } } })).toBe('element-flash');
  });

  it('sends solid elements but weak verses to the lyrics drill', () => {
    const mastery = {
      elements: { H: { attempts: 10, correct: 9 } },
      chunks: { v1: { attempts: 10, correct: 4 } },
    };
    expect(recommendedElementsMode(mastery)).toBe('fill-blank');
    // Elements solid but verses never attempted → still the lyrics drill.
    expect(recommendedElementsMode({ elements: { H: { attempts: 10, correct: 9 } }, chunks: {} })).toBe('fill-blank');
  });

  it('falls back to the recall test as maintenance once everything is solid', () => {
    expect(recommendedElementsMode({
      elements: { H: { attempts: 10, correct: 9 } },
      chunks: { v1: { attempts: 10, correct: 9 } },
    })).toBe('element-flash');
  });
});

describe('ElementsSong — Element Flash recall test', () => {
  it('advances to the next question when Enter is pressed after a result is shown', async () => {
    render(<RoutedElementsSong item={item} onBack={() => {}} />);
    await settle();

    fireEvent.click(screen.getByText('Element Flash'));
    await settle();

    // 2 elements → a 2-question quiz.
    expect(screen.getByText('1 / 2')).toBeInTheDocument();

    // Answer + submit with Enter from the input → the result is shown and the
    // input unmounts (replaced by the "Next" button).
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle();
    expect(screen.getByText('Next')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    // A second Enter (now caught by the window listener, since the input is
    // gone) must advance to question 2 rather than doing nothing.
    fireEvent.keyDown(window, { key: 'Enter' });
    await settle();
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('does not hijack Enter fired from a focused button (no double-advance)', async () => {
    render(<RoutedElementsSong item={item} onBack={() => {}} />);
    await settle();

    fireEvent.click(screen.getByText('Element Flash'));
    await settle();
    expect(screen.getByText('1 / 2')).toBeInTheDocument();

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle();

    // Enter originating from the focused Next button must be ignored by the
    // window listener — the button's own activation is the single advance, so
    // the window listener firing too would skip a question. (RTL keyDown does
    // not trigger the native click, so the guard working = no advance here.)
    const nextBtn = screen.getByText('Next');
    fireEvent.keyDown(nextBtn, { key: 'Enter' });
    await settle();
    expect(screen.getByText('1 / 2')).toBeInTheDocument();

    // A genuine click on Next still advances exactly once.
    fireEvent.click(nextBtn);
    await settle();
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
  });
});
