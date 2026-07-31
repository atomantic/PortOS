import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import PostDrillRunner from './PostDrillRunner';

describe('PostDrillRunner Powers training feedback', () => {
  it('teaches the named mental path after a missed Powers answer', () => {
    render(<PostDrillRunner session={{
      currentDrill: { type: 'powers', questions: [{ prompt: '2^13', expected: 8192 }], timeLimitSec: 90 },
      currentQuestionIndex: 0,
      currentDrillIndex: 0,
      drillCount: 1,
      state: 'drilling',
      isTraining: true,
      lastAnswer: { prompt: '2^13', expected: 8192, answered: 4096, correct: false },
      submitAnswer: vi.fn(),
      skipQuestion: vi.fn(),
      acknowledgeAnswer: vi.fn(),
      timeExpired: vi.fn(),
    }} />);

    expect(screen.getByText('Double up from 2^10')).toBeInTheDocument();
    expect(screen.getByText('× 2 → 2^13 = 8,192')).toBeInTheDocument();
  });
});
