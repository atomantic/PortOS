import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

// ── Mock toast ────────────────────────────────────────────────────────────────
const mockToast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('../../ui/Toast', () => ({ default: mockToast }));

// ── Mock API ──────────────────────────────────────────────────────────────────
const api = vi.hoisted(() => ({
  getBrainInbox: vi.fn(),
  getBrainSettings: vi.fn(),
}));
vi.mock('../../../services/api', () => api);

const TrustTab = (await import('./TrustTab')).default;

const COUNTS = { total: 128, filed: 96, needs_review: 18, corrected: 12, error: 2 };

const renderTab = async () => {
  const result = render(<TrustTab />);
  // Flush the mount fetches (inbox + settings).
  await act(async () => {});
  return result;
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getBrainInbox.mockResolvedValue({ entries: [], counts: COUNTS });
  api.getBrainSettings.mockResolvedValue({
    confidenceThreshold: 0.6,
    dailyDigestTime: '09:00',
    weeklyReviewDay: 'sunday',
    weeklyReviewTime: '16:00',
    defaultProvider: 'lmstudio',
  });
});

// The header laid the title block and 5 stat counters out as one non-wrapping
// row, which pushed the counters past a 375px viewport and forced the page body
// to scroll horizontally (#3527). jsdom has no layout engine, so these assert
// the structure that makes the row wrap rather than measured pixel widths.
describe('TrustTab mobile header', () => {
  const stats = () => screen.getByText(/^Total:/).parentElement;

  it('stacks the title block above the stats under sm and re-joins them from sm up', async () => {
    await renderTab();
    const header = stats().parentElement;

    expect(header.className).toContain('flex-col');
    expect(header.className).toContain('sm:flex-row');
    expect(header.children).toHaveLength(2);
  });

  it('wraps the stat counters instead of overflowing the row', async () => {
    await renderTab();

    expect(stats().className).toContain('flex-wrap');
  });

  // Passes against the pre-fix markup too — it is not an overflow assertion. It
  // guards the tempting wrong fix for this bug: hiding counters behind
  // `hidden sm:inline` so the row fits, which drops them off the phone entirely.
  it('keeps all five counters rendered rather than hiding any on mobile', async () => {
    await renderTab();

    for (const label of ['Total: 128', 'Filed: 96', 'Review: 18', 'Corrected: 12', 'Errors: 2']) {
      const counter = screen.getByText(label);
      expect(counter).toBeInTheDocument();
      // `hidden` would render it in jsdom but hide it on the phone this fixes.
      expect(counter.className).not.toContain('hidden');
    }
  });

  it('wraps the status-filter row so the Refresh button never spills off screen', async () => {
    await renderTab();
    const filters = screen.getByText('Filter by status:').parentElement;

    expect(filters.className).toContain('flex-wrap');
  });
});
