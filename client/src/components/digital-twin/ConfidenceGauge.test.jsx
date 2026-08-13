import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import ConfidenceGauge from './ConfidenceGauge';

vi.mock('../../services/api', () => ({ calculateDigitalTwinConfidence: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

const confidence = {
  overall: 0.72,
  dimensions: { openness: 0.9, boundaries: 0.4 }
};

describe('ConfidenceGauge accessibility', () => {
  it('exposes the overall gauge as a meter carrying the percentage', () => {
    render(<ConfidenceGauge confidence={confidence} />);

    const gauge = screen.getByRole('meter', { name: 'Digital Twin overall confidence' });
    expect(gauge).toHaveAttribute('aria-valuenow', '72');
    expect(gauge).toHaveAttribute('aria-valuemin', '0');
    expect(gauge).toHaveAttribute('aria-valuemax', '100');
    expect(gauge.getAttribute('aria-valuetext')).toContain('72%');
  });

  it('exposes each dimension bar as its own labelled meter', () => {
    render(<ConfidenceGauge confidence={confidence} />);

    expect(screen.getByRole('meter', { name: 'Openness confidence' })).toHaveAttribute('aria-valuenow', '90');
    expect(screen.getByRole('meter', { name: 'Boundaries confidence' })).toHaveAttribute('aria-valuenow', '40');
  });

  it('reports zero rather than a missing value when confidence is absent', () => {
    render(<ConfidenceGauge confidence={null} />);

    expect(screen.getByRole('meter', { name: 'Digital Twin overall confidence' })).toHaveAttribute('aria-valuenow', '0');
  });
});
