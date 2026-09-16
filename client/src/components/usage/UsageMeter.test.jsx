import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import UsageMeter, { meterColor, formatResetsAt } from './UsageMeter';

describe('meterColor', () => {
  // The thresholds are the whole reason this meter was extracted rather than
  // copied: a plan that reads "comfortable" on one page and "critical" on
  // another is worse than no meter at all.
  it('escalates from comfortable to critical as a window is consumed', () => {
    expect(meterColor(10)).toBe('bg-port-success');
    expect(meterColor(69)).toBe('bg-port-success');
    expect(meterColor(70)).toBe('bg-port-warning');
    expect(meterColor(89)).toBe('bg-port-warning');
    expect(meterColor(90)).toBe('bg-port-error');
  });

  // An unread percentage must not render as "0% used, all clear".
  it('renders an unknown percentage as neutral, not as comfortable', () => {
    expect(meterColor(null)).toBe('bg-gray-500');
    expect(meterColor(undefined)).toBe('bg-gray-500');
  });
});

describe('formatResetsAt', () => {
  it('passes through a non-ISO reading from an older peer unchanged', () => {
    expect(formatResetsAt('in about 3 hours')).toBe('in about 3 hours');
    expect(formatResetsAt(null)).toBeNull();
  });

  it('localizes an ISO reset', () => {
    expect(formatResetsAt('2026-03-01T12:00:00.000Z')).toMatch(/\d/);
  });
});

describe('UsageMeter', () => {
  it('shows the window, the remaining share and the used share', () => {
    render(<UsageMeter limit={{ key: 'week', label: 'Weekly', percentUsed: 40, percentRemaining: 60 }} />);
    expect(screen.getByText('Weekly')).toBeInTheDocument();
    expect(screen.getByText('60% left')).toBeInTheDocument();
    expect(screen.getByText('40% used')).toBeInTheDocument();
  });

  // A provider that reports usage but not a remainder must show an em dash,
  // never a fabricated 100%.
  it('renders a missing remainder as unknown', () => {
    render(<UsageMeter limit={{ key: 'week', label: 'Weekly', percentUsed: 40, percentRemaining: null }} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
