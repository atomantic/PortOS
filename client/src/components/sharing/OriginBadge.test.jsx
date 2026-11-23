import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import OriginBadge from './OriginBadge';

const origin = { source: 'Alice', bucketName: 'Shared', importedAt: '2026-05-25T10:00:00Z' };

describe('OriginBadge', () => {
  it('gives the compact chip accessible provenance text and hides the decorative icon', () => {
    const { container } = render(<OriginBadge origin={origin} compact />);
    expect(screen.getByText(/From Alice · via Shared/)).toHaveClass('sr-only');
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('does not duplicate provenance text in the full chip', () => {
    render(<OriginBadge origin={origin} />);
    expect(screen.getAllByText(/Alice/)).toHaveLength(1);
  });
});
