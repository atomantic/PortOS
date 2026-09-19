import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import UsageMeter, { meterTone, formatResetsAt, readingAttribution } from './UsageMeter';

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

describe('readingAttribution', () => {
  // #7662: staleness is a server-computed flag now, not a client-side clock —
  // these assert the component renders from `limit.stale`, never re-deriving
  // an age threshold of its own.
  it('renders nothing for a fresh reading, however old readAt looks', () => {
    const ancientButFresh = { readAt: '2000-01-01T00:00:00.000Z', readBy: 'peer-1', readByName: 'Example Box', stale: false };
    expect(readingAttribution(ancientButFresh)).toBeNull();
  });

  it('attributes a stale peer reading to the instance that took it', () => {
    const limit = { readAt: '2026-09-03T11:00:00.000Z', readBy: 'peer-1', readByName: 'Example Box', stale: true };
    expect(readingAttribution(limit)).toMatch(/^read .+ on Example Box$/);
  });

  it('captions a stale LOCAL reading too, with no "on <machine>" attribution', () => {
    const limit = { readAt: '2026-09-03T11:00:00.000Z', readBy: null, stale: true };
    expect(readingAttribution(limit)).toMatch(/^read .+$/);
    expect(readingAttribution(limit)).not.toMatch(/ on /);
  });

  it('falls back to naming the instance without an age when readAt is unparseable', () => {
    const limit = { readAt: null, readBy: 'peer-1', readByName: 'Example Box', stale: true };
    expect(readingAttribution(limit)).toBe('read on Example Box');
  });

  it('renders nothing for an undated stale local reading', () => {
    expect(readingAttribution({ readAt: null, readBy: null, stale: true })).toBeNull();
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

  // An unmeasured window is not an untouched one. Rendering `0% used` for a
  // plan that may be fully spent is the same fabrication the remainder and the
  // meter tone already refuse.
  it('renders an unmeasured used share as unknown, never as 0%', () => {
    render(<UsageMeter limit={{ key: 'week', label: 'Weekly', percentUsed: null, percentRemaining: null }} />);
    expect(screen.queryByText('0% used')).not.toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(2);
  });
});
