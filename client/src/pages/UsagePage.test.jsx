import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getProviderUsage: vi.fn(),
  getUsage: vi.fn(),
  getUsageBackfillStatus: vi.fn(),
  startUsageBackfill: vi.fn()
}));

vi.mock('../services/api', () => api);

const UsagePage = (await import('./UsagePage')).default;

const usage = {
  totalSessions: 1,
  totalMessages: 1,
  totalTokens: { input: 10, output: 5 },
  last7Days: [],
  hourlyActivity: Array(24).fill(0),
  topProviders: [],
  topModels: [],
  report: {
    pricingAsOf: '2026-07-01',
    providers: [],
    totals: { estimatedCost: 0, source: 'estimate' }
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getProviderUsage.mockResolvedValue({ providers: [] });
  api.getUsage.mockResolvedValue(usage);
  api.getUsageBackfillStatus.mockResolvedValue({ status: 'idle' });
  api.startUsageBackfill.mockResolvedValue({ status: 'complete', corrected: 2 });
});

describe('UsagePage historical reconciliation', () => {
  it('starts only from the explicit user action and reports completion', async () => {
    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    const button = await screen.findByRole('button', { name: 'Reconcile now' });
    expect(api.startUsageBackfill).not.toHaveBeenCalled();

    fireEvent.click(button);
    await waitFor(() => expect(api.startUsageBackfill).toHaveBeenCalledWith({ silent: true }));
    expect(await screen.findByText('Corrected 2 runs.')).toBeInTheDocument();
  });
});

describe('UsagePage breakdown visualization and responsiveness', () => {
  it('renders top providers and top models with visual percentage badges and cost metrics', async () => {
    const richUsage = {
      ...usage,
      topProviders: [
        { id: 'claude', name: 'Claude Code', sessions: 10, tokens: 8000 }
      ],
      topModels: [
        { model: 'claude-3-7-sonnet', sessions: 10, tokens: 8000 }
      ],
      report: {
        pricingAsOf: '2026-07-01',
        providers: [
          {
            id: 'claude',
            name: 'Claude Code',
            sessions: 10,
            tokensIn: 5000,
            tokensOut: 3000,
            cacheReadTokens: 1000,
            cacheWriteTokens: 200,
            estimatedCost: 1.5,
            source: 'measured',
            models: [
              {
                model: 'claude-3-7-sonnet',
                sessions: 10,
                tokensIn: 5000,
                tokensOut: 3000,
                cacheReadTokens: 1000,
                cacheWriteTokens: 200,
                estimatedCost: 1.5
              }
            ]
          }
        ],
        totals: { estimatedCost: 1.5, source: 'measured' }
      }
    };
    api.getUsage.mockResolvedValue(richUsage);

    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    expect(await screen.findByText('Top Providers')).toBeInTheDocument();
    expect(screen.getByText('Top Models')).toBeInTheDocument();

    // Check percentage share badges and cost
    const percentBadges = screen.getAllByText('100%');
    expect(percentBadges.length).toBeGreaterThan(0);

    const costDisplays = screen.getAllByText('$1.50');
    expect(costDisplays.length).toBeGreaterThan(0);
  });
});

describe('UsagePage provider reset times', () => {
  it('localizes an ISO reset and adds the relative countdown', async () => {
    // A minute past the 3h mark, so the floor in `timeUntil` can't round to 2h.
    const resetsAt = new Date(Date.now() + 3 * 60 * 60 * 1000 + 60_000).toISOString();
    api.getProviderUsage.mockResolvedValue({
      providers: [{
        family: 'claude',
        label: 'Claude',
        supported: true,
        limits: [{ key: 'week', label: 'Weekly', percentUsed: 40, percentRemaining: 60, resetsAt, timezone: 'UTC' }],
        activity: [],
        approximate: true,
        fetchedAt: new Date().toISOString()
      }]
    });

    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    // Every adapter emits ISO now, so the card must never show a CLI's own
    // wording — it shows a localized instant plus "in 3h".
    const reset = await screen.findByText(/resets .*\(in 3h\)/);
    expect(reset).toBeInTheDocument();
    expect(reset.textContent).not.toContain(resetsAt);
  });
});
