import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../ui/Toast');

import SoulWizard from './SoulWizard';

const stepDots = () => screen.getAllByRole('button', { name: /^Go to step \d+: / });

describe('SoulWizard step indicators', () => {
  it('names every step dot with its number and title', () => {
    render(<SoulWizard onComplete={vi.fn()} onCancel={vi.fn()} />);
    const dots = stepDots();
    expect(dots.length).toBeGreaterThan(1);
    dots.forEach((dot, index) => {
      expect(dot.getAttribute('aria-label')).toMatch(new RegExp(`^Go to step ${index + 1}: .+`));
    });
  });

  it('marks only the active step with aria-current="step"', () => {
    render(<SoulWizard onComplete={vi.fn()} onCancel={vi.fn()} />);
    const current = () => stepDots().map((d) => d.getAttribute('aria-current'));
    expect(current()).toEqual(['step', ...stepDots().slice(1).map(() => null)]);

    fireEvent.click(stepDots()[2]);
    expect(current()[2]).toBe('step');
    expect(current()[0]).toBeNull();
  });
});
