import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import UsageMeter, { meterTone, formatResetsAt } from './UsageMeter';

describe('meterTone', () => {
  // The thresholds are the whole reason this meter was extracted rather than
  // copied: a plan that reads "comfortable" on one page and "critical" on
  // another is worse than no meter at all.
  it('escalates from comfortable to critical as a window is consumed', () => {
    expect(meterTone(10)).toBe('success');
    expect(meterTone(69)).toBe('success');
    expect(meterTone(70)).toBe('warning');
    expect(meterTone(89)).toBe('warning');
    expect(meterTone(90)).toBe('error');
  });

  // An unread percentage must not render as "0% used, all clear".
  it('renders an unknown percentage as neutral, not as comfortable', () => {
    expect(meterTone(null)).toBe('muted');
    expect(meterTone(undefined)).toBe('muted');
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
