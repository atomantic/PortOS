import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

describe('PostDrillRunner Applied Numeracy', () => {
  it('uses a mobile-friendly unit input and explains the method after an answer', () => {
    render(<PostDrillRunner session={{
      currentDrill: { type: 'applied-numeracy', questions: [{ prompt: 'Convert 1.5 km to m.' }], timeLimitSec: 90 },
      currentQuestionIndex: 0,
      currentDrillIndex: 0,
      drillCount: 1,
      state: 'drilling',
      isTraining: true,
      lastAnswer: {
        prompt: 'Convert 1.5 km to m.', expected: '1500 m', answered: '1.5 km', correct: true,
        method: 'Use 1 km = 1000 m, then multiply 1.5 by 1000.',
      },
      submitAnswer: vi.fn(),
      skipQuestion: vi.fn(),
      acknowledgeAnswer: vi.fn(),
      timeExpired: vi.fn(),
    }} />);

    expect(screen.getByText('Shortest method')).toBeInTheDocument();
    expect(screen.getByText(/1 km = 1000 m/)).toBeInTheDocument();

    render(<PostDrillRunner session={{
      currentDrill: { type: 'applied-numeracy', questions: [{ prompt: 'Convert 1.5 km to m.' }], timeLimitSec: 90 },
      currentQuestionIndex: 0,
      currentDrillIndex: 0,
      drillCount: 1,
      state: 'drilling',
      isTraining: false,
      lastAnswer: null,
      submitAnswer: vi.fn(),
      skipQuestion: vi.fn(),
      acknowledgeAnswer: vi.fn(),
      timeExpired: vi.fn(),
    }} />);

    const input = screen.getByLabelText('Your numeric answer and unit when requested');
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveAttribute('inputmode', 'decimal');
  });
});

describe('PostDrillRunner multi-blank recall', () => {
  it('renders one labeled input per blank and submits indexed values', () => {
    const submitAnswer = vi.fn();
    render(<PostDrillRunner session={{
      currentDrill: {
        type: 'memory-fill-blank',
        questions: [{
          prompt: 'The ____ ____',
          answers: [
            { index: 1, word: 'quick' },
            { index: 2, word: 'fox' },
          ],
        }],
        timeLimitSec: 60,
      },
      currentQuestionIndex: 0,
      currentDrillIndex: 0,
      drillCount: 1,
      state: 'drilling',
      isTraining: false,
      lastAnswer: null,
      submitAnswer,
      skipQuestion: vi.fn(),
      acknowledgeAnswer: vi.fn(),
      timeExpired: vi.fn(),
    }} />);

    expect(screen.getByLabelText('Blank 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Blank 2')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Blank 2'), { target: { value: 'fox' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }));

    expect(submitAnswer).toHaveBeenCalledWith([
      { index: 1, value: null },
      { index: 2, value: 'fox' },
    ]);
  });
});
