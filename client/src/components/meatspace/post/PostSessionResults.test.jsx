import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import PostSessionResults from './PostSessionResults';

// Issue #2093 — the drill-breakdown expansion previously only ever showed
// data for LLM drills (`isLlm && isExpanded && result.evaluation`); math and
// cognitive drills rendered a dead, chevron-less button. These tests guard
// both the fix (per-question review for non-LLM drills) and the regression
// (LLM behavior stays exactly as it was).

function makeSession(overrides = {}) {
  return {
    drillResults: [
      {
        type: 'multiplication',
        score: 60,
        questions: [
          { prompt: '6 x 7', expected: 42, answered: 41, correct: false, responseMs: 2000 },
          { prompt: '3 x 3', expected: 9, answered: 9, correct: true, responseMs: 900 },
        ],
      },
      {
        type: 'word-association',
        score: 80,
        evaluation: { summary: 'Nice variety', scores: [{ score: 80, feedback: 'Good range' }] },
        responses: [{ response: 'apple, banana' }],
      },
    ],
    sessionScore: 70,
    state: 'complete',
    saveSession: vi.fn(),
    isTraining: false,
    ...overrides,
  };
}

function renderResults(overrides = {}) {
  return render(
    <PostSessionResults session={makeSession(overrides)} tags={{}} onSaved={() => {}} onBack={() => {}} />
  );
}

describe('PostSessionResults drill breakdown', () => {
  it('renders a chevron on every drill row — including non-LLM ones (regression: dead expand affordance)', () => {
    const { container } = renderResults();
    // Both rows start collapsed, so both show ChevronDown. Previously this
    // icon was gated behind `isLlm &&`, so a math/cognitive row (like
    // "multiplication" here) rendered no chevron at all.
    expect(container.querySelectorAll('.lucide-chevron-down')).toHaveLength(2);
  });

  it('expanding a math drill row reveals its per-question review (regression for the isLlm-only gate)', () => {
    const { container } = renderResults();
    fireEvent.click(screen.getByText('Multiplication'));
    const table = within(container.querySelector('table'));
    expect(table.getByText('6 x 7')).toBeInTheDocument();
    expect(table.getByText('41')).toBeInTheDocument();
    expect(table.getByText('42')).toBeInTheDocument();
  });

  it('leads the math review with a missed-items summary', () => {
    renderResults();
    fireEvent.click(screen.getByText('Multiplication'));
    expect(screen.getByText('1 missed')).toBeInTheDocument();
  });

  it('expanding an LLM drill row still shows its evaluation, unchanged', () => {
    renderResults();
    // "Nice variety" is already visible pre-expansion (it's the row subtitle);
    // expanding adds a second copy in the evaluation block, plus the
    // per-response feedback text which only exists once expanded.
    expect(screen.getAllByText('Nice variety')).toHaveLength(1);
    fireEvent.click(screen.getByText('Word Association'));
    expect(screen.getAllByText('Nice variety')).toHaveLength(2);
    expect(screen.getByText('Good range')).toBeInTheDocument();
  });

  it('does not render the per-question table for an LLM row', () => {
    renderResults();
    fireEvent.click(screen.getByText('Word Association'));
    expect(screen.queryByText('6 x 7')).not.toBeInTheDocument();
  });

  it('collapses the review again on a second click', () => {
    const { container } = renderResults();
    const row = screen.getByText('Multiplication');
    fireEvent.click(row);
    expect(within(container.querySelector('table')).getByText('6 x 7')).toBeInTheDocument();
    fireEvent.click(row);
    expect(container.querySelector('table')).not.toBeInTheDocument();
  });
});
