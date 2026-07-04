import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import DrillQuestionReview from './DrillQuestionReview';

// Shared per-question/per-trial mistake review (issue #2093). Covers the
// generic math/memory table, and the type-appropriate cognitive views —
// each drill family's `questions[]` shape captures different things per
// trial, so the dispatch-by-type behavior is the load-bearing contract here.
//
// The missed-items summary chip re-renders each missed question's `prompt`,
// so table assertions are scoped with `within(table)` to avoid ambiguous
// double-matches against that chip.

describe('DrillQuestionReview — generic (math/memory/fallback)', () => {
  const questions = [
    { prompt: '6 x 7', expected: 42, answered: 41, correct: false, responseMs: 2200 },
    { prompt: '3 x 3', expected: 9, answered: 9, correct: true, responseMs: 900 },
    { prompt: '8 x 8', expected: 64, answered: null, correct: false, responseMs: 0 },
  ];

  it('renders every question with prompt, answered, and expected', () => {
    const { container } = render(<DrillQuestionReview type="multiplication" questions={questions} />);
    const table = within(container.querySelector('table'));
    expect(table.getByText('6 x 7')).toBeInTheDocument();
    expect(table.getByText('41')).toBeInTheDocument();
    expect(table.getByText('42')).toBeInTheDocument();
    expect(table.getAllByText('9')).toHaveLength(2); // correct row: answered === expected
  });

  it('leads with a missed-items summary counting only the incorrect questions', () => {
    render(<DrillQuestionReview type="multiplication" questions={questions} />);
    expect(screen.getByText('2 missed')).toBeInTheDocument();
  });

  it('shows "No misses" when every question is correct', () => {
    render(<DrillQuestionReview type="multiplication" questions={[questions[1]]} />);
    expect(screen.getByText('No misses')).toBeInTheDocument();
  });

  it('renders an unanswered question as "skipped", distinct from a wrong answer', () => {
    const { container } = render(<DrillQuestionReview type="multiplication" questions={questions} />);
    const table = within(container.querySelector('table'));
    expect(table.getByText('skipped')).toBeInTheDocument();
    // The wrong-but-answered question still shows its actual (incorrect) value.
    expect(table.getByText('41')).toBeInTheDocument();
  });

  it('falls back to answers[] for the expected column when a question has no scalar `expected` (e.g. memory-fill-blank)', () => {
    const { container } = render(
      <DrillQuestionReview
        type="memory-fill-blank"
        questions={[{
          prompt: 'The ____ ____ jumps',
          answered: 'quick brown',
          correct: false,
          responseMs: 1200,
          answers: [{ index: 1, word: 'quick' }, { index: 2, word: 'fox' }],
        }]}
      />
    );
    const table = within(container.querySelector('table'));
    expect(table.getByText('quick / fox')).toBeInTheDocument();
  });

  it('formats mental-rotation option indices as human-readable option numbers', () => {
    render(
      <DrillQuestionReview
        type="mental-rotation"
        questions={[{ prompt: 'shape L', expected: 1, answered: 0, correct: false, responseMs: 650 }]}
      />
    );
    expect(screen.getByText('Option 2')).toBeInTheDocument(); // expected (index 1)
    expect(screen.getByText('Option 1')).toBeInTheDocument(); // answered (index 0)
  });

  it('renders nothing when there are no questions', () => {
    const { container } = render(<DrillQuestionReview type="multiplication" questions={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('DrillQuestionReview — n-back', () => {
  // Classification is derived purely from answered+correct (no isTarget field
  // is stored on the question) — this is the reconstruction under test.
  const questions = [
    { prompt: 'A', index: 2, expected: 'match', answered: 'match', correct: true, responseMs: 400 }, // hit
    { prompt: 'C', index: 3, expected: 'no-match', answered: 'match', correct: false, responseMs: 300 }, // false alarm
    { prompt: 'B', index: 4, expected: 'match', answered: null, correct: false, responseMs: 0 }, // miss
    { prompt: 'D', index: 5, expected: 'no-match', answered: null, correct: true, responseMs: 0 }, // correct reject
  ];

  it('classifies every trial as hit / false alarm / miss / correct reject', () => {
    render(<DrillQuestionReview type="n-back" questions={questions} />);
    expect(screen.getByText(/Hit \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/False alarm \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Miss \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Correct reject \(1\)/)).toBeInTheDocument();
  });

  it('counts the false alarm and the miss as the 2 "missed" trials', () => {
    render(<DrillQuestionReview type="n-back" questions={questions} />);
    expect(screen.getByText('2 missed')).toBeInTheDocument();
  });
});

describe('DrillQuestionReview — digit-span', () => {
  it('shows the shown digits (expected) alongside the recalled digits (answered)', () => {
    const questions = [
      { prompt: '3-digit (forward)', index: 0, expected: '123', answered: '124', correct: false, responseMs: 1500, length: 3 },
    ];
    render(<DrillQuestionReview type="digit-span" questions={questions} />);
    expect(screen.getByText('123')).toBeInTheDocument();
    expect(screen.getByText('124')).toBeInTheDocument();
  });

  it('renders a skipped round distinctly, not as a wrong recall', () => {
    const questions = [
      { prompt: '3-digit (forward)', index: 0, expected: '123', answered: null, correct: false, responseMs: 0, length: 3 },
    ];
    render(<DrillQuestionReview type="digit-span" questions={questions} />);
    expect(screen.getByText('skipped')).toBeInTheDocument();
    expect(screen.getByText('123')).toBeInTheDocument();
  });

  it('backward drills show the TRUE shown sequence plus the reversed expected recall (regression: expected is the recall order, not what was shown)', () => {
    const questions = [
      { prompt: '3-digit (backward)', index: 0, expected: '321', answered: '123', correct: false, responseMs: 1100, length: 3 },
    ];
    const drillData = {
      config: { direction: 'backward' },
      sequences: [{ digits: [1, 2, 3], length: 3 }],
    };
    render(<DrillQuestionReview type="digit-span" questions={questions} drillData={drillData} />);
    expect(screen.getByText('Shown')).toBeInTheDocument();
    expect(screen.getByText('Expected')).toBeInTheDocument();
    // Shown column carries the digits as displayed (123), Expected the
    // required reversed recall (321) — previously "Shown" wrongly showed 321.
    expect(screen.getAllByText('123').length).toBeGreaterThan(0); // shown + (wrong) recalled
    expect(screen.getByText('321')).toBeInTheDocument();
  });

  it('backward drills without drillData still derive the shown sequence by un-reversing expected', () => {
    const questions = [
      { prompt: '3-digit (backward)', index: 0, expected: '321', answered: null, correct: false, responseMs: 0, length: 3 },
    ];
    render(<DrillQuestionReview type="digit-span" questions={questions} />);
    // Direction inferred from the prompt; shown = expected un-reversed.
    expect(screen.getByText('123')).toBeInTheDocument(); // shown
    expect(screen.getByText('321')).toBeInTheDocument(); // expected recall
  });
});

describe('DrillQuestionReview — stroop', () => {
  it('renders the word, the ink color (expected), and the picked answer', () => {
    const questions = [
      { prompt: 'RED', index: 0, expected: 'blue', answered: 'red', correct: false, responseMs: 800 },
    ];
    const drillData = { options: [{ name: 'blue', hex: '#3b82f6' }, { name: 'red', hex: '#ef4444' }] };
    const { container } = render(<DrillQuestionReview type="stroop" questions={questions} drillData={drillData} />);
    const table = within(container.querySelector('table'));
    expect(table.getByText('RED')).toBeInTheDocument();
    expect(table.getByText('blue')).toBeInTheDocument();
    expect(table.getByText('red')).toBeInTheDocument();
  });

  it('does not crash when drillData is absent (falls back to plain text, no swatch)', () => {
    const questions = [
      { prompt: 'GREEN', index: 0, expected: 'green', answered: 'green', correct: true, responseMs: 400 },
    ];
    render(<DrillQuestionReview type="stroop" questions={questions} />);
    expect(screen.getByText('GREEN')).toBeInTheDocument();
  });
});

describe('DrillQuestionReview — schulte-table / reaction-time timing review', () => {
  it('flags a response time far above the others as an outlier', () => {
    const questions = [
      { prompt: '1', index: 0, expected: 1, answered: 1, correct: true, responseMs: 500 },
      { prompt: '2', index: 1, expected: 2, answered: 2, correct: true, responseMs: 520 },
      { prompt: '3', index: 2, expected: 3, answered: 3, correct: true, responseMs: 510 },
      { prompt: '4', index: 3, expected: 4, answered: 4, correct: true, responseMs: 6000 },
    ];
    const { container } = render(<DrillQuestionReview type="schulte-table" questions={questions} />);
    expect(container.querySelector('[aria-label="Outlier response time"]')).toBeInTheDocument();
  });

  it('does not flag anything as an outlier when times are all similar', () => {
    const questions = [
      { prompt: '1', index: 0, expected: 1, answered: 1, correct: true, responseMs: 500 },
      { prompt: '2', index: 1, expected: 2, answered: 2, correct: true, responseMs: 520 },
      { prompt: '3', index: 2, expected: 3, answered: 3, correct: true, responseMs: 510 },
    ];
    const { container } = render(<DrillQuestionReview type="schulte-table" questions={questions} />);
    expect(container.querySelector('[aria-label="Outlier response time"]')).not.toBeInTheDocument();
  });

  it('flags a false start distinctly from a wrong pick in reaction-time', () => {
    const questions = [
      { prompt: 'react', index: 0, answered: null, correct: false, responseMs: 0, falseStart: true },
      { prompt: 'react', index: 1, answered: 'react', correct: true, responseMs: 300 },
    ];
    render(<DrillQuestionReview type="reaction-time" questions={questions} />);
    expect(screen.getByText('False start')).toBeInTheDocument();
    expect(screen.getByText('Correct')).toBeInTheDocument();
  });
});
