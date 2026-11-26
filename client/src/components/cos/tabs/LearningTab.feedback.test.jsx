import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import FeedbackSummary from './learning/FeedbackSummary';

describe('LearningTab FeedbackSummary', () => {
  it('labels the feedback population as durable across live and archived runs', () => {
    render(<FeedbackSummary feedback={{
      total: 12,
      positive: 9,
      neutral: 1,
      negative: 2,
      satisfactionRate: 75
    }} />);

    expect(screen.getByText('User Feedback')).toBeInTheDocument();
    expect(screen.getByText('Durable ratings across live and archived agent runs')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('12 rated runs retained in the current archive window')).toBeInTheDocument();
  });

  it('stays out of the learning view until a rating exists', () => {
    const { container } = render(<FeedbackSummary feedback={{ total: 0 }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
