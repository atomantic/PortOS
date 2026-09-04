import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getProviderUsage: vi.fn(),
  getUsage: vi.fn(),
  getUsageBackfillStatus: vi.fn(),
  startUsageBackfill: vi.fn(),
  updateSubscriptionCosts: vi.fn()
}));

vi.mock('../services/api', () => api);

const UsagePageModule = await import('./UsagePage');
const UsagePage = UsagePageModule.default;
const { arrangeQuotaCells } = UsagePageModule;

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
  api.updateSubscriptionCosts.mockResolvedValue({ costs: { claude: 200 } });
});

describe('UsagePage subscription savings', () => {
  const savings = {
    range: { start: '2026-02-01', end: '2026-02-07', days: 7 },
    configured: false,
    unmatchedApiCost: 0,
    families: [{
      family: 'claude', label: 'Claude Code', enabled: true, monthlyCost: 0, configured: false,
      periodCost: 0, apiCost: 30, savings: 0, multiplier: null
    }],
    totals: { monthlyCost: 0, periodCost: 0, apiCost: 0, savings: 0, savingsPercent: null, multiplier: null }
  };

  it('renders the savings editor from the report payload', async () => {
    api.getUsage.mockResolvedValue({ ...usage, subscriptionSavings: savings });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    expect(await screen.findByText('Subscription vs. API Cost')).toBeInTheDocument();
  });

  // A new plan price changes every derived figure in the report, so saving one
  // has to pull the whole report back down — not just the prices.
  it('refetches the report after a price is saved', async () => {
    api.getUsage.mockResolvedValue({ ...usage, subscriptionSavings: savings });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    const inputs = await screen.findAllByLabelText('Monthly cost for Claude Code');
    fireEvent.change(inputs[0], { target: { value: '200' } });
    const calls = api.getUsage.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /Save costs/ }));

    await waitFor(() => expect(api.updateSubscriptionCosts).toHaveBeenCalledWith({ claude: 200 }, { silent: true }));
    await waitFor(() => expect(api.getUsage.mock.calls.length).toBeGreaterThan(calls));
  });
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

describe('UsagePage per-provider refresh', () => {
  const card = (family, label, percentUsed) => ({
    family,
    label,
    supported: true,
    limits: [{ key: 'week', label: 'Weekly', percentUsed, percentRemaining: 100 - percentUsed }],
    activity: [],
    approximate: true,
    fetchedAt: new Date().toISOString()
  });

  beforeEach(() => {
    api.getProviderUsage.mockResolvedValue({ providers: [card('claude', 'Claude Code', 10), card('grok', 'Grok', 20)] });
  });

  it('re-reads only the clicked provider and swaps that card in', async () => {
    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    await screen.findByText('Grok');
    expect(await screen.findByText('20% used')).toBeInTheDocument();

    api.getProviderUsage.mockResolvedValueOnce({ providers: [card('grok', 'Grok', 77)] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));

    await waitFor(() => expect(api.getProviderUsage).toHaveBeenCalledWith({ refresh: true, family: 'grok', silent: false }));
    // The refreshed card updates; the untouched Claude card keeps its reading.
    expect(await screen.findByText('77% used')).toBeInTheDocument();
    expect(screen.getByText('10% used')).toBeInTheDocument();
  });

  it('keeps the four provider cards in a compact mobile grid', async () => {
    api.getProviderUsage.mockResolvedValue({
      providers: ['claude', 'agy', 'codex', 'grok'].map((family) => card(family, family, 20))
    });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    const providerGrid = await screen.findByLabelText('Subscription provider usage');
    expect(providerGrid.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['grid-cols-2', 'sm:grid-cols-1', 'lg:grid-cols-2'])
    );
    expect(within(providerGrid).getAllByRole('heading')).toHaveLength(4);
  });

  it('drops a card whose provider is no longer enabled', async () => {
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('Grok');

    api.getProviderUsage.mockResolvedValueOnce({ providers: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));

    await waitFor(() => expect(screen.queryByText('Grok')).not.toBeInTheDocument());
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
  });
});

describe('UsagePage federated quota readings', () => {
  const fleetCard = {
    family: 'claude',
    label: 'Claude Code',
    supported: true,
    limits: [{ key: 'week', label: 'Weekly', percentUsed: 65, percentRemaining: 35 }],
    activity: [],
    approximate: true,
    fetchedAt: '2026-09-03T11:00:00.000Z',
    note: 'Across 2 federated instances (this machine, Example Box) — meters show the freshest reading across them.',
    fleet: {
      count: 2,
      instances: [
        { instanceId: 'inst-self', name: null, self: true, fetchedAt: '2026-09-03T10:00:00.000Z' },
        { instanceId: 'inst-peer', name: 'Example Box', self: false, fetchedAt: '2026-09-03T11:00:00.000Z' },
      ],
    },
  };

  it('says the card spans instances and names which ones', async () => {
    api.getProviderUsage.mockResolvedValue({ providers: [fleetCard] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    const pill = await screen.findByText('2 instances');
    expect(pill.closest('[title]').getAttribute('title')).toContain('Example Box');
    expect(screen.getByText(fleetCard.note)).toBeInTheDocument();
  });

  it('shows no fleet pill on a single-machine install', async () => {
    api.getProviderUsage.mockResolvedValue({ providers: [{ ...fleetCard, fleet: undefined, note: 'This machine only — other federated instances have not reported a reading yet.' }] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    await screen.findByText('Claude Code');
    expect(screen.queryByText(/^\d+ instances$/)).not.toBeInTheDocument();
  });
});

describe('arrangeQuotaCells', () => {
  const q = (family) => ({ family, label: family });

  it('orders Claude, Antigravity, then a shared Codex+Grok cell, then the rest', () => {
    // Server order deliberately differs from display order.
    const cells = arrangeQuotaCells(['claude', 'codex', 'agy', 'grok', 'imagegen'].map(q));
    expect(cells.map((c) => c.cards.map((card) => card.family))).toEqual([
      ['claude'], ['agy'], ['codex', 'grok'], ['imagegen']
    ]);
  });

  it('collapses a shared cell to the one family of the pair that is enabled', () => {
    const cells = arrangeQuotaCells([q('grok'), q('claude')]);
    expect(cells.map((c) => c.key)).toEqual(['claude', 'grok']);
  });

  it('renders a family it has no display preference for exactly once, in server order', () => {
    const cells = arrangeQuotaCells([q('imagegen'), q('newthing')]);
    expect(cells.map((c) => c.cards.map((card) => card.family))).toEqual([['imagegen'], ['newthing']]);
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
    expect(reset.className.split(/\s+/)).not.toContain('hidden');
    expect(reset.textContent).not.toContain(resetsAt);
  });

  it('gives the Grok weekly reset its own full-width row on the cramped mobile card', async () => {
    // Grok shares a mobile grid cell with Codex, so its card is the narrowest —
    // the reset row must stack under "% used" (flex-col) rather than squeeze
    // onto the same line (flex-row), which was clipping/overlapping it.
    const resetsAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 60_000).toISOString();
    api.getProviderUsage.mockResolvedValue({
      providers: [{
        family: 'grok',
        label: 'Grok',
        supported: true,
        limits: [{ key: 'weekly', label: 'Weekly', percentUsed: 8, percentRemaining: 92, resetsAt }],
        activity: [],
        approximate: true,
        fetchedAt: new Date().toISOString()
      }]
    });

    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    const reset = await screen.findByText(/resets .*\(in 2d\)/);
    expect(reset.className.split(/\s+/)).not.toContain('hidden');
    const row = reset.parentElement;
    expect(row.className.split(/\s+/)).toEqual(expect.arrayContaining(['flex-col', 'sm:flex-row']));
  });
});

// The provider-quota section reads every provider on mount, well after the page
// shell has painted. A centered spinner there let the whole page below it jump
// by the card grid's height once the reading landed (#4147).
describe('UsagePage provider-quota loading state (#4147)', () => {
  it('reserves the quota card grid instead of centering a spinner', async () => {
    // Never resolves — hold the section on its loading branch.
    api.getProviderUsage.mockReturnValue(new Promise(() => {}));

    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    const region = await screen.findByRole('status', { name: 'Reading provider usage' });
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    // Mirrors the loaded grid so the cards land where the placeholders were.
    expect(region.innerHTML).toContain('lg:grid-cols-2');
  });
});
