import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import StoryCraftPanel from './StoryCraftPanel';

const evaluation = {
  overallScore: 3.1,
  maxScore: 5,
  answersQuestion: true,
  revision: 'End on what the taste stands in for.',
  moves: [
    { id: 'curiosity', label: 'Create curiosity', score: 4, evidence: 'opens on a question', suggestion: 'hold the answer longer' },
    { id: 'takeaway', label: 'Land with a takeaway', score: 0, evidence: '', suggestion: 'say what it meant' }
  ],
  cart: [
    { id: 'context', label: 'Context', present: true, note: 'kitchen table' },
    { id: 'takeaway', label: 'Takeaway', present: false, note: 'missing' }
  ]
};

describe('StoryCraftPanel', () => {
  it('renders a labeled meter per move, including a zero-scored one', () => {
    render(<StoryCraftPanel evaluation={evaluation} />);

    // A zero score must still draw its row — the rubric is the fixed seven
    // moves, and a missing row would read as "not part of the rubric" rather
    // than "you didn't do this".
    expect(screen.getByRole('progressbar', { name: 'Create curiosity score' })).toHaveAttribute('aria-valuenow', '80');
    expect(screen.getByRole('progressbar', { name: 'Land with a takeaway score' })).toHaveAttribute('aria-valuenow', '0');
  });

  it('shows each move\'s evidence and suggestion when the model gave them', () => {
    render(<StoryCraftPanel evaluation={evaluation} />);

    expect(screen.getByText('opens on a question')).toBeInTheDocument();
    expect(screen.getByText(/hold the answer longer/)).toBeInTheDocument();
    expect(screen.getByText(/End on what the taste stands in for/)).toBeInTheDocument();
  });

  it('flags a story that does not answer its question, and stays quiet when it does', () => {
    const { rerender } = render(<StoryCraftPanel evaluation={evaluation} />);
    expect(screen.queryByText(/answer its question/)).not.toBeInTheDocument();

    rerender(<StoryCraftPanel evaluation={{ ...evaluation, answersQuestion: false }} />);
    expect(screen.getByText(/answer its question/)).toBeInTheDocument();
  });

  it('renders nothing before a story has been scored', () => {
    const { container } = render(<StoryCraftPanel evaluation={null} />);

    expect(container).toBeEmptyDOMElement();
  });
});
