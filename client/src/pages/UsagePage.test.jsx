import socket from '../services/socket';
vi.mock('../services/socket', async () => {
  const { EventEmitter } = await import('events');
  return { default: new EventEmitter() };
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getClaudeCodeModelUsage: vi.fn(() => Promise.resolve({ filesScanned: 0, models: [], totals: {} })),
  getProviderUsage: vi.fn(),
  getUsage: vi.fn(),
  getUsageBackfillStatus: vi.fn(),
  getUsageRollingCost: vi.fn(() => Promise.resolve({ windowDays: 30, instanceCount: 1, series: [], points: [] })),
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
  it('describes retained opted-out history without showing a missing-data warning', async () => {
    api.getUsage.mockResolvedValue({ ...usage,
      coverage: { instanceCount: 2, missingInstances: [], notSyncingInstances: ['Saved peer'], incompleteMonths: [],
        classificationUnreported: [], transcriptUnreported: [], hourlyIncomplete: false },
      imageRenders: { incomplete: false, codexSessions: 0, savedOutputs: 0 },
      freeTier: { providers: [], blocks: [], blocksIncomplete: false },
    });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    const note = await screen.findByText('Usage sync is off for Saved peer. Their saved history remains included.');
    expect(note).not.toHaveClass('text-port-warning');
    expect(screen.queryByText(/No usage snapshot from/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Partial chart: some instance history/)).not.toBeInTheDocument();
    expect(screen.queryByText(/some instances did not report complete image receipts/)).not.toBeInTheDocument();
    expect(screen.queryByText(/have not reported their observed block history/)).not.toBeInTheDocument();
  });

  it('updates fleet counts with the selected period and identifies unavailable data', async () => {
    const report = (sessions, tokens, cost) => ({
      providers: [{ id: 'example', name: 'Example', sessions, messages: sessions, tokensIn: tokens, tokensOut: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCost: cost, models: [] }],
      totals: { sessions, messages: sessions, tokensIn: tokens, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCost: cost },
    });
    api.getUsage.mockImplementation(({ period }) => Promise.resolve({
      ...usage,
      report: period === '30d' ? report(300, 900, 30) : report(7, 21, 7),
      activity: [{ date: '2026-01-01', label: '2026-01-01', sessions: period === '30d' ? 300 : 7 }],
      hourlyActivity: Array(24).fill(0),
      imageRenders: { incomplete: true, codexSessions: 0, savedOutputs: 0 },
      coverage: { instanceCount: 2, missingInstances: ['Offline'], notSyncingInstances: [], incompleteMonths: ['2025-01'], hourlyIncomplete: true },
    }));
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    expect(await screen.findByText('Usage from 2 reported instances; peer data reflects the last sync.')).toBeInTheDocument();
    expect(screen.getByText(/No usage snapshot from Offline/)).toBeInTheDocument();
    expect(screen.getByText(/Partial months 2025-01 are excluded/)).toBeInTheDocument();
    expect(screen.getByText(/some instances did not report complete image receipts/)).toBeInTheDocument();
    expect(screen.getByText(/older sessions or unavailable instances/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    await waitFor(() => expect(api.getUsage).toHaveBeenLastCalledWith({ period: '30d' }, { silent: true }));
    expect(await screen.findByText('Showing usage for 30 days.')).toBeInTheDocument();
    expect(screen.getAllByText('300').length).toBeGreaterThan(0);
  });

  it('updates quota cards on completion without recurring fetches', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await waitFor(() => expect(api.getProviderUsage).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(api.getProviderUsage).toHaveBeenCalledTimes(1);
    api.getProviderUsage.mockResolvedValue({ providers: [{
      family: 'claude', label: 'Claude Code', supported: true,
      limits: [{ key: 'week', label: 'Updated window', percentUsed: 73, percentRemaining: 27 }],
    }] });
    await act(async () => { socket.emit('provider-quota:updated', {}); });
    expect(await screen.findByText('Updated window')).toBeInTheDocument();
    expect(api.getProviderUsage).toHaveBeenCalledTimes(2);
    expect(api.getProviderUsage).toHaveBeenLastCalledWith({ refresh: false, scope: 'instances' });
  });

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

  it('does not label complete subscription savings partial because fleet pricing is incomplete', async () => {
    api.getUsage.mockResolvedValue({ ...usage, subscriptionSavings: { ...savings, costIncomplete: false },
      coverage: { instanceCount: 2, pricingIncomplete: true, missingInstances: [], notSyncingInstances: [], incompleteMonths: [] } });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    expect(await screen.findByText(/Fleet API cost includes only classified usage and is incomplete/)).toBeInTheDocument();
    expect(screen.queryByText(/API costs and savings are incomplete/)).not.toBeInTheDocument();
  });

  it('renders the savings editor from the report payload', async () => {
    api.getUsage.mockResolvedValue({ ...usage, subscriptionSavings: savings });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    expect(screen.getByRole('tab', { name: 'Usage' })).toHaveAttribute('aria-selected', 'true');
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
  it('renders backfill events without polling and reconciles missed updates', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.getUsageBackfillStatus.mockResolvedValue({ status: 'running', processed: 1, total: 5 });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    expect(await screen.findByText('Processing 1 of 5 runs…')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.getUsageBackfillStatus).toHaveBeenCalledTimes(1);
    api.getUsageBackfillStatus.mockResolvedValue({ status: 'running', processed: 3, total: 5 });
    await act(async () => { socket.emit('usage-backfill:updated', {}); });
    expect(await screen.findByText('Processing 3 of 5 runs…')).toBeInTheDocument();
    expect(api.getUsageBackfillStatus).toHaveBeenCalledTimes(2);
    const usageReads = api.getUsage.mock.calls.length;
    api.getUsageBackfillStatus.mockResolvedValue({ status: 'complete', corrected: 4 });
    await act(async () => { socket.emit('usage-backfill:updated', {}); });
    expect(await screen.findByText('Corrected 4 runs.')).toBeInTheDocument();
    expect(api.getUsage.mock.calls.length).toBe(usageReads + 1);
    await act(async () => { socket.emit('connect'); });
    expect(api.getUsageBackfillStatus).toHaveBeenCalledTimes(4);
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    api.getUsageBackfillStatus.mockResolvedValue({ status: 'error', error: 'Example scan failed' });
    visibility.mockReturnValue('visible');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(api.getUsageBackfillStatus).toHaveBeenCalledTimes(5);
    expect(await screen.findByText('Example scan failed')).toBeInTheDocument();
  });

  it('reconciles a completion that beats the start response', async () => {
    api.startUsageBackfill.mockResolvedValue({ status: 'running' });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    const button = await screen.findByRole('button', { name: 'Reconcile now' });
    api.getUsageBackfillStatus.mockResolvedValue({ status: 'complete', corrected: 3 });
    fireEvent.click(button);
    expect(await screen.findByText('Corrected 3 runs.')).toBeInTheDocument();
    expect(api.startUsageBackfill).toHaveBeenCalledTimes(1);
  });

  it('shows the Grok rows reconcile added', async () => {
    api.startUsageBackfill.mockResolvedValue({
      status: 'complete',
      corrected: 2,
      grok: {
        added: 3,
        turns: 1,
        images: 2,
        videos: 0,
        backedUp: true,
        note: 'Long-context premiums were not added because no Grok usage scan has run yet.',
      },
    });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Reconcile now' }));
    expect(await screen.findByText('Corrected 2 runs.')).toBeInTheDocument();
    expect(await screen.findByText('Added 1 long-context turn and 2 images. Long-context premiums were not added because no Grok usage scan has run yet.')).toBeInTheDocument();
  });

  it('says when reconcile found the Grok ledger already repaired', async () => {
    api.startUsageBackfill.mockResolvedValue({
      status: 'complete',
      corrected: 0,
      grok: { added: 0, turns: 0, images: 0, videos: 0, backedUp: false, note: null },
    });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Reconcile now' }));
    expect(await screen.findByText('Grok usage was already recorded.')).toBeInTheDocument();
  });

  it('shows the Antigravity rows reconcile added', async () => {
    api.startUsageBackfill.mockResolvedValue({
      status: 'complete',
      corrected: 1,
      agy: {
        added: 4,
        images: 4,
        backedUp: true,
        note: null,
      },
    });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Reconcile now' }));
    expect(await screen.findByText('Corrected 1 run.')).toBeInTheDocument();
    expect(await screen.findByText('Added 4 images.')).toBeInTheDocument();
  });

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
                images: 2,
                videoSeconds: 6,
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
    expect(screen.getAllByText(/2 images/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/6s video/).length).toBeGreaterThan(0);
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

  it('shows one shared-account card using the newest reading and refreshes the local source', async () => {
    const peerName = 'an-unbroken-peer-name-'.repeat(5);
    const timestamp = (offset) => new Date(Date.now() + offset).toISOString();
    api.getProviderUsage.mockResolvedValue({ providers: [
      { ...card('grok', 'Grok', 20), fetchedAt: timestamp(-10_000), origin: { self: true, name: 'This instance' } },
      { ...card('grok', 'Grok', 40), fetchedAt: timestamp(-5_000), origin: { self: false, instanceId: 'peer-a', name: peerName } },
      { ...card('codex', 'Codex', 60), origin: { self: false, instanceId: 'peer-b', name: 'Peer B' } },
    ], unreportedInstances: ['Offline'] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    expect(await screen.findByText('40% used')).toBeInTheDocument();
    expect(screen.queryByText((text) => text.includes(peerName))).not.toBeInTheDocument();
    expect(screen.queryByText(/Quota reporting is unavailable from Offline/)).not.toBeInTheDocument();
    expect(screen.getByText(/readings from the same provider are assumed to share an account/i)).toBeInTheDocument();
    expect(screen.queryByText('20% used')).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Grok' })).toHaveLength(1);
    expect(screen.getByText('60% used')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Refresh Grok usage' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Refresh Codex usage' })).not.toBeInTheDocument();
    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...card('grok', 'Grok', 77), origin: { self: true, name: 'This instance' } }] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    expect(await screen.findByText('77% used')).toBeInTheDocument();
    expect(screen.queryByText('40% used')).not.toBeInTheDocument();
  });

  it('reconciles fleet charts and quota cards when usage sync applies', async () => {
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('Grok');
    await waitFor(() => expect(api.getUsageRollingCost).toHaveBeenCalled());
    api.getProviderUsage.mockClear(); api.getUsage.mockClear(); api.getUsageRollingCost.mockClear();
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    await waitFor(() => expect(api.getProviderUsage).toHaveBeenCalledWith({ refresh: false, scope: 'instances' }));
    await waitFor(() => expect(api.getUsage).toHaveBeenCalled());
    await waitFor(() => expect(api.getUsageRollingCost).toHaveBeenCalled());
  });

  it('does not replace a newer peer quota response with an older delayed one', async () => {
    let release;
    api.getProviderUsage.mockReset().mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    api.getProviderUsage.mockResolvedValue({ providers: [card('grok', 'Grok', 77)] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await waitFor(() => expect(api.getProviderUsage).toHaveBeenCalled());
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    expect(await screen.findByText('77% used')).toBeInTheDocument();
    await act(async () => release({ providers: [card('grok', 'Grok', 20)] }));
    expect(screen.getByText('77% used')).toBeInTheDocument();
    expect(screen.queryByText('20% used')).not.toBeInTheDocument();
  });

  it('keeps the last unexpired local meter beside failed family and full refreshes', async () => {
    const local = { ...card('grok', 'Grok', 20), origin: { self: true, name: 'This instance' } };
    api.getProviderUsage.mockResolvedValue({ providers: [local] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('20% used');

    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...local, limits: [], error: 'Family scrape failed' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    expect(await screen.findByText(/Family scrape failed/)).toBeInTheDocument();
    expect(screen.getByText('20% used')).toBeInTheDocument();

    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...local, limits: [], error: 'Full scrape failed' }] });
    fireEvent.click(screen.getByRole('button', { name: /Refresh all/ }));
    expect(await screen.findByText(/Full scrape failed/)).toBeInTheDocument();
    expect(screen.getByText('20% used')).toBeInTheDocument();

    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...card('grok', 'Grok', 55), origin: local.origin }] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    expect(await screen.findByText('55% used')).toBeInTheDocument();
    expect(screen.queryByText(/Full scrape failed/)).not.toBeInTheDocument();
  });

  it('keeps a passive failure visible beside the last reading until a passive recovery', async () => {
    const local = { ...card('grok', 'Grok', 20), origin: { self: true, name: 'This instance' } };
    api.getProviderUsage.mockResolvedValue({ providers: [local] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('20% used');

    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...local, limits: [], error: 'Passive scrape failed' }] });
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    expect(await screen.findByText(/Passive scrape failed/)).toBeInTheDocument();
    expect(screen.getByText('20% used')).toBeInTheDocument();

    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...card('grok', 'Grok', 55), origin: local.origin }] });
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    expect(await screen.findByText('55% used')).toBeInTheDocument();
    expect(screen.queryByText(/Passive scrape failed/)).not.toBeInTheDocument();
  });

  it('clears an older passive failure after a successful explicit family refresh', async () => {
    const local = { ...card('grok', 'Grok', 20), origin: { self: true, name: 'This instance' } };
    api.getProviderUsage.mockResolvedValue({ providers: [local] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('20% used');
    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...local, limits: [], error: 'Passive scrape failed' }] });
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    expect(await screen.findByText(/Passive scrape failed/)).toBeInTheDocument();
    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...card('grok', 'Grok', 55), origin: local.origin }] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    expect(await screen.findByText('55% used')).toBeInTheDocument();
    expect(screen.queryByText(/Passive scrape failed/)).not.toBeInTheDocument();
  });

  it('clears an older passive failure after a family refresh even if a full read overlaps it', async () => {
    const local = { ...card('grok', 'Grok', 20), origin: { self: true, name: 'This instance' } };
    api.getProviderUsage.mockResolvedValue({ providers: [local] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('20% used');
    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...local, limits: [], error: 'Old passive failure' }] });
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    expect(await screen.findByText(/Old passive failure/)).toBeInTheDocument();

    let finishFamily;
    api.getProviderUsage.mockImplementation(({ family }) => family === 'grok'
      ? new Promise((resolve) => { finishFamily = resolve; })
      : Promise.resolve({ providers: [local] }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    await act(async () => finishFamily({ providers: [{ ...card('grok', 'Grok', 55), origin: local.origin }] }));
    expect(await screen.findByText('55% used')).toBeInTheDocument();
    expect(screen.queryByText(/Old passive failure/)).not.toBeInTheDocument();
  });

  it('keeps a newer passive failure after an older family refresh succeeds', async () => {
    const local = { ...card('grok', 'Grok', 20), origin: { self: true, name: 'This instance' } };
    api.getProviderUsage.mockResolvedValue({ providers: [local] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('20% used');

    let finishFamily;
    api.getProviderUsage.mockImplementation(({ family }) => family === 'grok'
      ? new Promise((resolve) => { finishFamily = resolve; })
      : Promise.resolve({ providers: [{ ...local, limits: [], error: 'New passive failure' }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    expect(await screen.findByText(/New passive failure/)).toBeInTheDocument();
    await act(async () => finishFamily({ providers: [{ ...card('grok', 'Grok', 55), origin: local.origin }] }));
    expect(await screen.findByText('55% used')).toBeInTheDocument();
    expect(screen.getByText(/New passive failure/)).toBeInTheDocument();
  });

  it('does not let an older family failure replace a newer full-refresh failure', async () => {
    const local = { ...card('grok', 'Grok', 20), origin: { self: true } };
    api.getProviderUsage.mockResolvedValue({ providers: [local] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('20% used');
    let finishFamily;
    api.getProviderUsage.mockImplementation(({ family }) => family === 'grok'
      ? new Promise((resolve) => { finishFamily = resolve; })
      : Promise.resolve({ providers: [{ ...local, limits: [], error: 'New full failure' }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    fireEvent.click(screen.getByRole('button', { name: /Refresh all/ }));
    expect(await screen.findByText(/New full failure/)).toBeInTheDocument();
    await act(async () => finishFamily({ providers: [{ ...local, limits: [], error: 'Old family failure' }] }));
    expect(screen.getByText(/New full failure/)).toBeInTheDocument();
    expect(screen.queryByText(/Old family failure/)).not.toBeInTheDocument();
  });

  it('does not clear a newer passive failure when an older full refresh finishes', async () => {
    const local = { ...card('grok', 'Grok', 20), origin: { self: true, name: 'This instance' } };
    api.getProviderUsage.mockResolvedValue({ providers: [local] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('20% used');
    let finishFull;
    api.getProviderUsage.mockImplementation(({ refresh }) => refresh
      ? new Promise((resolve) => { finishFull = resolve; })
      : Promise.resolve({ providers: [{ ...local, limits: [], error: 'New passive failure' }] }));
    fireEvent.click(screen.getByRole('button', { name: /Refresh all/ }));
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    expect(await screen.findByText(/New passive failure/)).toBeInTheDocument();
    await act(async () => finishFull({ providers: [local] }));
    expect(screen.getByText(/New passive failure/)).toBeInTheDocument();
    expect(screen.getByText('20% used')).toBeInTheDocument();
  });

  it('keeps an explicit refresh error after a passive failure and recovery', async () => {
    const local = { ...card('grok', 'Grok', 20), origin: { self: true, name: 'This instance' } };
    api.getProviderUsage.mockResolvedValue({ providers: [local] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('20% used');

    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...local, limits: [], error: 'Explicit scrape failed' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    expect(await screen.findByText(/Explicit scrape failed/)).toBeInTheDocument();
    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...local, limits: [], error: 'Passive scrape failed' }] });
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    api.getProviderUsage.mockResolvedValueOnce({ providers: [local] });
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    expect(screen.getByText(/Explicit scrape failed/)).toBeInTheDocument();
    expect(screen.queryByText(/Passive scrape failed/)).not.toBeInTheDocument();
  });

  it('shows a newer passive limit warning without hiding an explicit refresh failure', async () => {
    const local = { ...card('codex', 'Codex', 20), fetchedAt: new Date(Date.now() - 60_000).toISOString(),
      origin: { self: true, name: 'This instance' } };
    api.getProviderUsage.mockResolvedValue({ providers: [local] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('20% used');
    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...local, limits: [], error: 'Explicit scrape failed' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Codex usage' }));
    expect(await screen.findByText(/Explicit scrape failed/)).toBeInTheDocument();

    const blocked = { ...local, limits: [], fetchedAt: new Date().toISOString(), error: 'Weekly limit reached',
      quotaStatus: 'limit_reached', quotaScope: 'week' };
    api.getProviderUsage.mockResolvedValueOnce({ providers: [blocked] });
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    expect(await screen.findByText(/Weekly limit reached/)).toBeInTheDocument();
    expect(screen.getByText(/Explicit scrape failed/)).toBeInTheDocument();
    expect(screen.getByText('20% used')).toBeInTheDocument();
  });

  it.each([false, true])('keeps a newer local full-read observation when an older family refresh finishes later (federation unavailable: %s)', async (federationUnavailable) => {
    const stamp = (ago) => new Date(Date.now() - ago).toISOString();
    const local = (used, ago) => ({ ...card('codex', 'Codex', used), fetchedAt: stamp(ago),
      origin: { self: true, name: 'This instance' } });
    const initial = local(20, 60_000), older = local(40, 20_000), newer = local(80, 10_000);
    api.getProviderUsage.mockResolvedValue({ providers: [initial] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('20% used');
    let finishFamily;
    api.getProviderUsage.mockImplementation(({ family }) => family === 'codex'
      ? new Promise((resolve) => { finishFamily = resolve; })
      : Promise.resolve({ providers: [newer], federationUnavailable }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Codex usage' }));
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    expect(await screen.findByText('80% used')).toBeInTheDocument();
    await act(async () => finishFamily({ providers: [older] }));
    expect(screen.getByText('80% used')).toBeInTheDocument();
    expect(screen.queryByText('40% used')).not.toBeInTheDocument();
  });

  it('does not re-add a provider omitted by a newer successful full read', async () => {
    const local = { ...card('grok', 'Grok', 20), origin: { self: true, name: 'This instance' } };
    api.getProviderUsage.mockResolvedValue({ providers: [local] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('20% used');

    let finishFamily;
    api.getProviderUsage.mockImplementation(({ family }) => family === 'grok'
      ? new Promise((resolve) => { finishFamily = resolve; })
      : Promise.resolve({ providers: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    expect(await screen.findByText('No enabled providers report subscription usage.')).toBeInTheDocument();
    await act(async () => finishFamily({ providers: [{ ...card('grok', 'Grok', 55), origin: local.origin }] }));
    expect(screen.getByText('No enabled providers report subscription usage.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Grok' })).not.toBeInTheDocument();
  });

  it('keeps the peer slot without restoring the local refresh button after a newer full read', async () => {
    const local = { ...card('grok', 'Grok', 20), fetchedAt: '2026-01-01T00:00:00.000Z', origin: { self: true } };
    const peer = { ...card('grok', 'Grok', 40), fetchedAt: '2026-01-02T00:00:00.000Z',
      origin: { self: false, instanceId: 'peer', capturedAt: '2026-01-02T00:00:00.000Z' } };
    api.getProviderUsage.mockResolvedValue({ providers: [local, peer] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByRole('button', { name: 'Refresh Grok usage' });

    let finishFamily;
    api.getProviderUsage.mockImplementation(({ family }) => family === 'grok'
      ? new Promise((resolve) => { finishFamily = resolve; })
      : Promise.resolve({ providers: [peer] }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Refresh Grok usage' })).not.toBeInTheDocument());
    await act(async () => finishFamily({ providers: [local, peer] }));
    expect(screen.getByText('40% used')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh Grok usage' })).not.toBeInTheDocument();
  });

  it('preserves a newer unsupported result when an older family refresh completes', async () => {
    const local = { ...card('grok', 'Grok', 20), origin: { self: true } };
    const unsupported = { ...local, supported: false, limits: [], activity: [] };
    api.getProviderUsage.mockResolvedValue({ providers: [local] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('20% used');

    let finishFamily;
    api.getProviderUsage.mockImplementation(({ family }) => family === 'grok'
      ? new Promise((resolve) => { finishFamily = resolve; })
      : Promise.resolve({ providers: [unsupported] }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    expect(await screen.findByText('Usage reporting is not available for this provider.')).toBeInTheDocument();
    await act(async () => finishFamily({ providers: [{ ...card('grok', 'Grok', 55), origin: local.origin }] }));
    expect(screen.getByText('Usage reporting is not available for this provider.')).toBeInTheDocument();
    expect(screen.queryByText('55% used')).not.toBeInTheDocument();
  });

  it('does not revive a retained quota window that reset during a failed refresh', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const local = { ...card('grok', 'Grok', 20), limits: [{ ...card('grok', 'Grok', 20).limits[0],
      resetsAt: new Date(now + 1000).toISOString() }], origin: { self: true, name: 'This instance' } };
    api.getProviderUsage.mockResolvedValue({ providers: [local] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('20% used');
    clock.mockReturnValue(now + 2000);
    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...local, limits: [], error: 'Scrape failed' }] });
    fireEvent.click(screen.getByRole('button', { name: /Refresh all/ }));
    expect(await screen.findByText(/Scrape failed/)).toBeInTheDocument();
    expect(screen.queryByText('20% used')).not.toBeInTheDocument();
  });

  it('expires retained windows at their reset times without another server event', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const now = Date.now();
    const local = { ...card('grok', 'Grok', 20), limits: [
      { key: 'session', label: 'Session', percentUsed: 20, percentRemaining: 80, resetsAt: new Date(now + 2000).toISOString() },
      { key: 'week', label: 'Weekly', percentUsed: 80, percentRemaining: 20, resetsAt: new Date(now + 5000).toISOString() },
    ], origin: { self: true } };
    api.getProviderUsage.mockResolvedValue({ providers: [local] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('20% used');
    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...local, limits: [], error: 'Scrape failed' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    expect(await screen.findByText(/Scrape failed/)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(screen.queryByText('20% used')).not.toBeInTheDocument();
    expect(screen.getByText('80% used')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.queryByText('80% used')).not.toBeInTheDocument();
    expect(screen.getByText(/last available quota reading has expired/i)).toBeInTheDocument();
    expect(screen.getByText(/Scrape failed/)).toBeInTheDocument();
  });

  it('cancels the old reset timer when a newer reading replaces it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const now = Date.now();
    const local = { ...card('grok', 'Grok', 20), limits: [{ ...card('grok', 'Grok', 20).limits[0],
      resetsAt: new Date(now + 2000).toISOString() }], origin: { self: true } };
    const newer = { ...card('grok', 'Grok', 80), limits: [{ ...card('grok', 'Grok', 80).limits[0],
      resetsAt: new Date(now + 10_000).toISOString() }], origin: local.origin };
    api.getProviderUsage.mockResolvedValue({ providers: [local] });
    const { unmount } = render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('20% used');
    api.getProviderUsage.mockResolvedValueOnce({ providers: [newer] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    await screen.findByText('80% used');
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(screen.getByText('80% used')).toBeInTheDocument();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.queryByText('80% used')).not.toBeInTheDocument();
  });

  it('caps a distant reset timer and re-arms it until the window expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T00:00:00.000Z'));
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const maxDelay = 2_147_483_647;
    const resetDelay = 3_000_000_000;
    const local = { ...card('grok', 'Grok', 20), limits: [{ ...card('grok', 'Grok', 20).limits[0],
      resetsAt: new Date(Date.now() + resetDelay).toISOString() }], origin: { self: true } };
    api.getProviderUsage.mockResolvedValue({ providers: [local] });
    const { unmount } = render(<MemoryRouter><UsagePage /></MemoryRouter>);
    // Wait for the resolved API calls and React's effects before inspecting the timer.
    await act(async () => {});
    expect(screen.getByText('20% used')).toBeInTheDocument();
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), maxDelay);
    await act(async () => { await vi.advanceTimersByTimeAsync(maxDelay); });
    expect(screen.getByText('20% used')).toBeInTheDocument();
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), resetDelay - maxDelay);
    await act(async () => { await vi.advanceTimersByTimeAsync(resetDelay - maxDelay - 1); });
    expect(screen.getByText('20% used')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.queryByText('20% used')).not.toBeInTheDocument();
    expect(screen.getByText(/last available quota reading has expired/i)).toBeInTheDocument();
    unmount();
  });

  it('applies concurrent family refreshes even when a fleet read overlaps', async () => {
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('Grok');
    let finishGrok, finishClaude;
    api.getProviderUsage.mockImplementation(({ family }) => {
      if (family === 'grok') return new Promise((resolve) => { finishGrok = resolve; });
      if (family === 'claude') return new Promise((resolve) => { finishClaude = resolve; });
      return Promise.resolve({ providers: [card('claude', 'Claude Code', 10), card('grok', 'Grok', 20)] });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Claude Code usage' }));
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    await act(async () => finishClaude({ providers: [card('claude', 'Claude Code', 55)] }));
    await act(async () => finishGrok({ providers: [card('grok', 'Grok', 77)] }));
    expect(await screen.findByText('55% used')).toBeInTheDocument();
    expect(screen.getByText('77% used')).toBeInTheDocument();
  });

  it('retains a completed family refresh when an older fleet read arrives afterward', async () => {
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('Grok');
    let finishFamily, finishFleet;
    let fullReads = 0;
    api.getProviderUsage.mockImplementation(({ family }) => family === 'grok'
      ? new Promise((resolve) => { finishFamily = resolve; })
      : ++fullReads === 1 ? new Promise((resolve) => { finishFleet = resolve; })
        : Promise.resolve({ providers: [card('grok', 'Grok', 77), card('claude', 'Claude Code', 10)] }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    await act(async () => finishFamily({ providers: [card('grok', 'Grok', 77)] }));
    await act(async () => finishFleet({ providers: [card('grok', 'Grok', 20), card('claude', 'Claude Code', 10)] }));
    expect(await screen.findByText('77% used')).toBeInTheDocument();
    expect(screen.queryByText('20% used')).not.toBeInTheDocument();
  });

  it('does not let a delayed full read roll back a newer peer from a family refresh', async () => {
    const local = { ...card('grok', 'Grok', 10), fetchedAt: '2026-01-01T00:00:00.000Z', origin: { self: true, name: 'This instance' } };
    const peer = (percentUsed, capturedAt) => ({ ...card('grok', 'Grok', percentUsed), fetchedAt: capturedAt,
      origin: { self: false, instanceId: 'peer', name: 'Peer', capturedAt } });
    const oldPeer = peer(20, '2026-01-02T00:00:00.000Z');
    const newPeer = peer(80, '2026-01-03T00:00:00.000Z');
    api.getProviderUsage.mockResolvedValue({ providers: [local, oldPeer] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    expect(await screen.findByText('20% used')).toBeInTheDocument();
    let finishFamily, finishOldFull;
    let fullReads = 0;
    api.getProviderUsage.mockImplementation(({ family }) => family
      ? new Promise((resolve) => { finishFamily = resolve; })
      : ++fullReads === 1 ? new Promise((resolve) => { finishOldFull = resolve; })
        : Promise.resolve({ providers: [local, newPeer] }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    await act(async () => finishFamily({ providers: [local, newPeer] }));
    expect(await screen.findByText('80% used')).toBeInTheDocument();
    await act(async () => finishOldFull({ providers: [local, oldPeer] }));
    expect(screen.getByText('80% used')).toBeInTheDocument();
    expect(screen.queryByText('20% used')).not.toBeInTheDocument();
  });

  it('retains a failed refresh diagnostic when a follow-up read serves an older cached card', async () => {
    const earlier = (ms) => new Date(Date.now() - ms).toISOString();
    const local = { ...card('grok', 'Grok', 20), fetchedAt: earlier(60_000), origin: { self: true, name: 'This instance' } };
    api.getProviderUsage.mockResolvedValue({ providers: [local] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    expect(await screen.findByText('20% used')).toBeInTheDocument();
    let finishFamily, finishOldFull;
    let fullReads = 0;
    api.getProviderUsage.mockImplementation(({ family }) => family
      ? new Promise((resolve) => { finishFamily = resolve; })
      : ++fullReads === 1 ? new Promise((resolve) => { finishOldFull = resolve; })
        : Promise.resolve({ providers: [local] }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    // A failed Codex-style fallback can carry telemetry older than even the
    // retained cache; the failed attempt itself happened after both.
    await act(async () => finishFamily({ providers: [{ ...local, limits: [], fetchedAt: earlier(120_000), error: 'Scrape failed' }] }));
    expect(await screen.findByText(/Scrape failed/)).toBeInTheDocument();
    expect(await screen.findByText('20% used')).toBeInTheDocument();
    await act(async () => finishOldFull({ providers: [local] }));
    expect(screen.getByText(/Scrape failed/)).toBeInTheDocument();
    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...local, limits: [], activity: [] }] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh Grok usage' })).toBeEnabled());
    expect(screen.getByText(/Scrape failed/)).toBeInTheDocument();
    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...local, fetchedAt: new Date().toISOString() }] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    await waitFor(() => expect(screen.queryByText(/Scrape failed/)).not.toBeInTheDocument());
  });

  it('retains a forced refresh error even when a quota event overtakes its response', async () => {
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    expect(await screen.findByText('20% used')).toBeInTheDocument();
    let finishForced;
    api.getProviderUsage.mockImplementation(({ refresh }) => refresh
      ? new Promise((resolve) => { finishForced = resolve; })
      : Promise.resolve({ providers: [card('claude', 'Claude Code', 10), card('grok', 'Grok', 20)] }));
    fireEvent.click(screen.getByRole('button', { name: /Refresh all/ }));
    await act(async () => { socket.emit('provider-quota:updated', {}); });
    await act(async () => finishForced({ providers: [card('claude', 'Claude Code', 10),
      { ...card('grok', 'Grok', 20), limits: [], error: 'Forced scrape failed' }] }));
    expect(await screen.findByText(/Forced scrape failed/)).toBeInTheDocument();
    expect(screen.getByText('20% used')).toBeInTheDocument();
  });

  it('shows an unsuccessful live refresh even when fallback telemetry contains a meter', async () => {
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('20% used');
    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...card('grok', 'Grok', 25), refreshUnavailable: true }] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    expect(await screen.findByText('25% used')).toBeInTheDocument();
    expect(screen.getByText('Live quota refresh was unavailable; displayed readings may be out of date.')).toBeInTheDocument();
    expect(screen.queryByText(/^This instance/)).not.toBeInTheDocument();
  });

  it('keeps a newer local meter when an unsuccessful live refresh falls back to older telemetry', async () => {
    const stamp = (ago) => new Date(Date.now() - ago).toISOString();
    const local = { ...card('codex', 'Codex', 80), fetchedAt: stamp(10_000), origin: { self: true, name: 'This instance' } };
    const fallback = { ...card('codex', 'Codex', 40), fetchedAt: stamp(20_000), origin: local.origin, refreshUnavailable: true };
    api.getProviderUsage.mockResolvedValue({ providers: [local] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('80% used');
    api.getProviderUsage.mockResolvedValueOnce({ providers: [fallback] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Codex usage' }));
    expect(await screen.findByText(/Live quota refresh was unavailable/)).toBeInTheDocument();
    expect(screen.getByText('80% used')).toBeInTheDocument();
    expect(screen.queryByText('40% used')).not.toBeInTheDocument();
  });

  it('does not hide a newer limit-reached warning while retaining an older meter', async () => {
    const local = { ...card('codex', 'Codex', 20), fetchedAt: new Date(Date.now() - 60_000).toISOString(),
      origin: { self: true, name: 'This instance' } };
    const blocked = { ...local, limits: [], fetchedAt: new Date().toISOString(), error: 'Weekly limit reached',
      quotaStatus: 'limit_reached', quotaScope: 'week' };
    api.getProviderUsage.mockResolvedValue({ providers: [local] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('20% used');
    api.getProviderUsage.mockResolvedValueOnce({ providers: [blocked] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Codex usage' }));
    expect(await screen.findByText(/Weekly limit reached/)).toBeInTheDocument();
    expect(screen.getByText('20% used')).toBeInTheDocument();
  });

  it('shows a failed live refresh when its local fallback expired but a peer meter is current', async () => {
    const local = { ...card('grok', 'Grok', 20), fetchedAt: '2026-01-01T00:00:00.000Z', origin: { self: true, name: 'Local Box' } };
    const peer = { ...card('grok', 'Grok', 55), fetchedAt: '2026-01-03T00:00:00.000Z', origin: { self: false, instanceId: 'peer', name: 'Peer' } };
    api.getProviderUsage.mockResolvedValue({ providers: [local, peer] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('55% used');
    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...local, limits: [], quotaStatus: 'expired', error: 'Old window reset', refreshUnavailable: true }, peer] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    expect(await screen.findByText('Live quota refresh was unavailable; displayed readings may be out of date.')).toBeInTheDocument();
    expect(screen.getByText('55% used')).toBeInTheDocument();
    expect(screen.queryByText('Old window reset')).not.toBeInTheDocument();
    expect(screen.queryByText('Peer')).not.toBeInTheDocument();
  });

  it('retains a forced refresh network failure after a cached read overtakes it', async () => {
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    expect(await screen.findByText('20% used')).toBeInTheDocument();
    let failForced;
    api.getProviderUsage.mockImplementation(({ refresh }) => refresh
      ? new Promise((_, reject) => { failForced = reject; })
      : Promise.resolve({ providers: [card('claude', 'Claude Code', 10), card('grok', 'Grok', 20)] }));
    fireEvent.click(screen.getByRole('button', { name: /Refresh all/ }));
    await act(async () => { socket.emit('provider-quota:updated', {}); });
    await act(async () => failForced(new Error('synthetic network error')));
    expect(await screen.findByText(/Couldn’t refresh all provider quotas/)).toBeInTheDocument();
    expect(screen.getByText('20% used')).toBeInTheDocument();
  });

  it('clears a local refresh failure when Refresh all confirms the provider was disabled', async () => {
    const local = { ...card('grok', 'Grok', 20), origin: { self: true, name: 'This instance' } };
    const peer = { ...card('grok', 'Grok', 40), origin: { self: false, instanceId: 'peer', name: 'Peer' } };
    api.getProviderUsage.mockResolvedValue({ providers: [local, peer] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByRole('button', { name: 'Refresh Grok usage' });
    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...local, limits: [], error: 'Local scrape failed' }, peer] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    expect(await screen.findByText(/Local scrape failed/)).toBeInTheDocument();
    api.getProviderUsage.mockResolvedValueOnce({ providers: [peer] });
    fireEvent.click(screen.getByRole('button', { name: /Refresh all/ }));
    await waitFor(() => expect(screen.queryByText(/Local scrape failed/)).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Grok' })).toBeInTheDocument();
  });

  it.each(['removed', 'unsupported'])('retires a local refresh failure when a passive read confirms the provider is %s', async (status) => {
    const local = { ...card('grok', 'Grok', 20), origin: { self: true, name: 'This instance' } };
    const peer = { ...card('grok', 'Grok', 40), origin: { self: false, instanceId: 'peer', name: 'Peer' } };
    api.getProviderUsage.mockResolvedValue({ providers: [local, peer] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByRole('button', { name: 'Refresh Grok usage' });
    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...local, limits: [], error: 'Retired local failure' }, peer] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    expect(await screen.findByText(/Retired local failure/)).toBeInTheDocument();
    const unsupported = { ...local, supported: false, limits: [], activity: [] };
    api.getProviderUsage.mockResolvedValueOnce({ providers: status === 'removed' ? [peer] : [unsupported, peer] });
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    await waitFor(() => expect(screen.queryByText(/Retired local failure/)).not.toBeInTheDocument());
    expect(screen.getByText('40% used')).toBeInTheDocument();
    if (status === 'removed') expect(screen.queryByRole('button', { name: 'Refresh Grok usage' })).not.toBeInTheDocument();
    // A later re-enable cannot resurrect the old local failure.
    api.getProviderUsage.mockResolvedValueOnce({ providers: [local, peer] });
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    expect(await screen.findByRole('button', { name: 'Refresh Grok usage' })).toBeInTheDocument();
    expect(screen.queryByText(/Retired local failure/)).not.toBeInTheDocument();
  });

  it('keeps a local failure while an older passive removal overlaps a newer family refresh', async () => {
    const local = { ...card('grok', 'Grok', 20), origin: { self: true, name: 'This instance' } };
    const peer = { ...card('grok', 'Grok', 40), origin: { self: false, instanceId: 'peer', name: 'Peer' } };
    api.getProviderUsage.mockResolvedValue({ providers: [local, peer] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByRole('button', { name: 'Refresh Grok usage' });
    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...local, limits: [], error: 'Earlier local failure' }, peer] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    expect(await screen.findByText(/Earlier local failure/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh Grok usage' })).toBeEnabled());
    let finishFull, finishFamily;
    api.getProviderUsage.mockImplementation(({ family }) => new Promise((resolve) => {
      if (family === 'grok') finishFamily = resolve;
      else finishFull = resolve;
    }));
    const refresh = screen.getByRole('button', { name: 'Refresh Grok usage' });
    await act(async () => {
      socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 });
      await Promise.resolve();
      await Promise.resolve();
      expect(finishFull).toEqual(expect.any(Function));
      fireEvent.click(refresh);
    });
    expect(finishFamily).toEqual(expect.any(Function));
    await act(async () => finishFull({ providers: [peer] }));
    expect(screen.getByText(/Earlier local failure/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh Grok usage' })).toBeInTheDocument();
    await act(async () => finishFamily({ providers: [{ ...local, limits: [], error: 'Newer local failure' }, peer] }));
    expect(screen.getByText(/Newer local failure/)).toBeInTheDocument();
  });

  it('keeps an image refresh failure through an incomplete passive omission', async () => {
    const local = { family: 'imagegen', label: 'Image Gen', supported: true,
      limits: [{ key: 'imagegen-grok', label: 'Grok images', percentUsed: 100 }], metrics: [], origin: { self: true, name: 'This instance' } };
    const peer = { ...local, limits: [], origin: { self: false, instanceId: 'peer', name: 'Peer' } };
    api.getProviderUsage.mockResolvedValue({ providers: [local, peer], imageQuotaComplete: true });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByRole('button', { name: 'Refresh Image Gen usage' });
    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...local, limits: [], error: 'Local image failure' }, peer], imageQuotaComplete: false });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Image Gen usage' }));
    expect(await screen.findByText(/Local image failure/)).toBeInTheDocument();
    api.getProviderUsage.mockResolvedValueOnce({ providers: [peer], imageQuotaComplete: false });
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    expect(screen.getByText(/Local image failure/)).toBeInTheDocument();
    api.getProviderUsage.mockResolvedValueOnce({ providers: [peer], imageQuotaComplete: true });
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    await waitFor(() => expect(screen.queryByText(/Local image failure/)).not.toBeInTheDocument());
  });

  it('keeps an image failure when an incomplete read omits the local card', async () => {
    const local = { family: 'imagegen', label: 'Image Gen', supported: true,
      limits: [{ key: 'imagegen-grok', label: 'Grok images', percentUsed: 100 }], metrics: [], origin: { self: true, name: 'This instance' } };
    const peer = { ...local, limits: [], metrics: [{ key: 'imagegen-grok', label: 'Grok images', value: 'No renders' }], origin: { self: false, instanceId: 'peer', name: 'Peer' } };
    api.getProviderUsage.mockResolvedValue({ providers: [local, peer], imageQuotaComplete: true });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByRole('button', { name: 'Refresh Image Gen usage' });
    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...local, limits: [], error: 'Local image read failed' }, peer], imageQuotaComplete: false });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Image Gen usage' }));
    expect(await screen.findByText(/Local image read failed/)).toBeInTheDocument();
    expect(screen.getByText(/Grok images: refusal observed/)).toBeInTheDocument();
    expect(screen.queryByText('No renders')).not.toBeInTheDocument();
    api.getProviderUsage.mockResolvedValueOnce({ providers: [{ ...local, limits: [], error: 'Local image read failed' }, peer], imageQuotaComplete: false });
    fireEvent.click(screen.getByRole('button', { name: /Refresh all/ }));
    expect(await screen.findByText('Image quota status is unavailable.')).toBeInTheDocument();
    expect(screen.getByText(/Grok images: refusal observed/)).toBeInTheDocument();
    api.getProviderUsage.mockResolvedValueOnce({ providers: [peer], imageQuotaComplete: false });
    fireEvent.click(screen.getByRole('button', { name: /Refresh all/ }));
    expect(await screen.findByText('Image quota status is unavailable.')).toBeInTheDocument();
    expect(screen.getByText(/Local image read failed/)).toBeInTheDocument();
    api.getProviderUsage.mockResolvedValueOnce({ providers: [peer], imageQuotaComplete: true });
    fireEvent.click(screen.getByRole('button', { name: /Refresh all/ }));
    await waitFor(() => expect(screen.queryByText(/Local image read failed/)).not.toBeInTheDocument());
    expect(screen.queryByText('Image quota status is unavailable.')).not.toBeInTheDocument();
  });

  it('keeps image failure status when another family refresh starts later', async () => {
    const image = { family: 'imagegen', label: 'Image Gen', supported: true, limits: [],
      metrics: [{ key: 'imagegen-grok', label: 'Grok images', value: 'No renders' }], origin: { self: true, name: 'This instance' } };
    const grok = card('grok', 'Grok', 20);
    api.getProviderUsage.mockResolvedValue({ providers: [image, grok], imageQuotaComplete: true });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByRole('button', { name: 'Refresh Image Gen usage' });
    let finishImage, finishGrok;
    api.getProviderUsage.mockImplementation(({ family }) => family === 'imagegen'
      ? new Promise((resolve) => { finishImage = resolve; })
      : new Promise((resolve) => { finishGrok = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Image Gen usage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    await act(async () => finishImage({ providers: [], imageQuotaComplete: false }));
    await act(async () => finishGrok({ providers: [grok], imageQuotaComplete: null }));
    expect(screen.getByText('Image quota status is unavailable.')).toBeInTheDocument();
    expect(screen.getByText('Image providers do not report a quota meter.')).toBeInTheDocument();
  });

  it('shows a passive image error beside the retained observation, including without a prior card', async () => {
    const image = { family: 'imagegen', label: 'Image Gen', supported: true,
      limits: [{ key: 'imagegen-grok', label: 'Grok images', percentUsed: 100 }], metrics: [], origin: { self: true, name: 'This instance' } };
    api.getProviderUsage.mockResolvedValue({ providers: [image], imageQuotaComplete: true });
    const { unmount } = render(<MemoryRouter><UsagePage /></MemoryRouter>);
    expect(await screen.findByText(/Grok images: refusal observed/)).toBeInTheDocument();
    const failed = { ...image, limits: [], error: 'Synthetic ledger failure' };
    api.getProviderUsage.mockResolvedValueOnce({ providers: [failed], imageQuotaComplete: false });
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    expect(await screen.findByText(/Synthetic ledger failure/)).toBeInTheDocument();
    expect(screen.getByText(/Grok images: refusal observed/)).toBeInTheDocument();
    api.getProviderUsage.mockResolvedValueOnce({ providers: [], imageQuotaComplete: false });
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    expect(screen.getByText(/Synthetic ledger failure/)).toBeInTheDocument();
    unmount();

    api.getProviderUsage.mockResolvedValue({ providers: [], imageQuotaComplete: true });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('No enabled providers report subscription usage.');
    api.getProviderUsage.mockResolvedValueOnce({ providers: [failed], imageQuotaComplete: false });
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    expect(await screen.findByText(/Synthetic ledger failure/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Image Gen' })).toBeInTheDocument();
  });

  it('applies an image failure after a later full request returns no status', async () => {
    const image = { family: 'imagegen', label: 'Image Gen', supported: true, limits: [],
      metrics: [{ key: 'imagegen-grok', label: 'Grok images', value: 'No renders' }], origin: { self: true, name: 'This instance' } };
    api.getProviderUsage.mockResolvedValue({ providers: [image], imageQuotaComplete: true });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByRole('button', { name: 'Refresh Image Gen usage' });
    let finishImage;
    api.getProviderUsage.mockImplementation(({ family }) => family === 'imagegen'
      ? new Promise((resolve) => { finishImage = resolve; })
      : Promise.reject(new Error('synthetic full-read failure')));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Image Gen usage' }));
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    await act(async () => finishImage({ providers: [], imageQuotaComplete: false }));
    expect(screen.getByText('Image quota status is unavailable.')).toBeInTheDocument();
  });

  it('keeps another forced failure without overwriting a newer family refresh', async () => {
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    expect(await screen.findByText('20% used')).toBeInTheDocument();
    const oldReadAt = new Date(Date.now() - 60_000).toISOString();
    let finishFamily, finishForced;
    api.getProviderUsage.mockImplementation(({ refresh, family }) => family === 'grok'
      ? new Promise((resolve) => { finishFamily = resolve; })
      : refresh ? new Promise((resolve) => { finishForced = resolve; })
        : Promise.resolve({ providers: [card('claude', 'Claude Code', 10), card('grok', 'Grok', 80)] }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    fireEvent.click(screen.getByRole('button', { name: /Refresh all/ }));
    await act(async () => finishFamily({ providers: [card('grok', 'Grok', 80)] }));
    await act(async () => finishForced({ providers: [
      { ...card('grok', 'Grok', 20), fetchedAt: oldReadAt, limits: [], error: 'Old Grok failure' },
      { ...card('claude', 'Claude Code', 10), limits: [], error: 'Claude failure' },
    ] }));
    expect(await screen.findByText(/Claude failure/)).toBeInTheDocument();
    expect(screen.queryByText(/Old Grok failure/)).not.toBeInTheDocument();
    expect(screen.getByText('80% used')).toBeInTheDocument();
  });

  it('retains peer readings when a full read fails while a family refresh is in flight', async () => {
    const local = { ...card('grok', 'Grok', 20), fetchedAt: '2026-01-01T00:00:00.000Z', origin: { self: true, name: 'This instance' } };
    const peer = { ...card('grok', 'Grok', 40), fetchedAt: '2026-01-02T00:00:00.000Z', origin: { self: false, instanceId: 'peer', name: 'Peer' } };
    api.getProviderUsage.mockResolvedValue({ providers: [local, peer] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    expect(await screen.findByText('40% used')).toBeInTheDocument();
    let finishFamily;
    api.getProviderUsage.mockImplementation(({ family }) => family
      ? new Promise((resolve) => { finishFamily = resolve; })
      : Promise.resolve({ providers: [local], federationUnavailable: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    await waitFor(() => expect(api.getProviderUsage).toHaveBeenCalledTimes(3));
    expect(screen.getByText('40% used')).toBeInTheDocument();
    expect(screen.queryByText('Peer quota readings are unavailable.')).not.toBeInTheDocument();
    await act(async () => finishFamily({ providers: [local, peer], federationUnavailable: false }));
    expect(screen.getByText('40% used')).toBeInTheDocument();
    expect(screen.queryByText('Peer quota readings are unavailable.')).not.toBeInTheDocument();
  });

  it('reconciles a full reading after a concurrent family refresh fails', async () => {
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('Grok');
    let failFamily;
    api.getProviderUsage.mockImplementation(({ family }) => family === 'grok'
      ? new Promise((_, reject) => { failFamily = reject; })
      : Promise.resolve({ providers: [card('grok', 'Grok', 55), card('claude', 'Claude Code', 10)] }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));
    await act(async () => { socket.emit('sync:progress', { phase: 'applied', category: 'usage', applied: 1 }); });
    await act(async () => failFamily(new Error('synthetic failure')));
    expect(await screen.findByText('55% used')).toBeInTheDocument();
  });

  it('re-reads only the clicked provider and swaps that card in', async () => {
    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    await screen.findByText('Grok');
    expect(await screen.findByText('20% used')).toBeInTheDocument();

    api.getProviderUsage.mockResolvedValueOnce({ providers: [card('grok', 'Grok', 77)] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Grok usage' }));

    await waitFor(() => expect(api.getProviderUsage).toHaveBeenCalledWith({ refresh: true, family: 'grok', scope: 'instances', silent: false }));
    // The refreshed card updates; the untouched Claude card keeps its reading.
    expect(await screen.findByText('77% used')).toBeInTheDocument();
    expect(screen.getByText('10% used')).toBeInTheDocument();
  });

  // The per-card control was a bare 12-14px icon (#8779): a finger that missed
  // it fell back on Refresh all, which respawns every family's scrape.
  it('gives both refresh controls a 44px touch target and blocks a duplicate per-card request', async () => {
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    const grokRefresh = await screen.findByRole('button', { name: 'Refresh Grok usage' });
    const refreshAll = screen.getByRole('button', { name: /Refresh all/ });
    for (const button of [grokRefresh, refreshAll]) {
      expect(button.className.split(/\s+/)).toEqual(expect.arrayContaining(['min-w-11', 'min-h-11']));
    }

    let settle;
    api.getProviderUsage.mockClear();
    api.getProviderUsage.mockReturnValueOnce(new Promise((resolve) => { settle = resolve; }));
    fireEvent.click(grokRefresh);
    await waitFor(() => expect(grokRefresh).toBeDisabled());
    fireEvent.click(grokRefresh);
    expect(api.getProviderUsage).toHaveBeenCalledTimes(1);
    expect(api.getProviderUsage).toHaveBeenCalledWith({ refresh: true, family: 'grok', scope: 'instances', silent: false });
    // The untouched card stays tappable while Grok's scrape is in flight.
    expect(screen.getByRole('button', { name: 'Refresh Claude Code usage' })).toBeEnabled();

    settle({ providers: [card('grok', 'Grok', 50)] });
    expect(await screen.findByText('50% used')).toBeInTheDocument();
    expect(grokRefresh).toBeEnabled();
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

  it('shows the subscription plan name on the quota card when the reading named a tier', async () => {
    api.getProviderUsage.mockResolvedValue({
      providers: [{
        family: 'grok',
        label: 'Grok',
        supported: true,
        plan: 'SuperGrok',
        limits: [{ key: 'week', label: 'Weekly', percentUsed: 8, percentRemaining: 92 }],
        activity: [],
        approximate: true,
        fetchedAt: '2026-09-03T11:00:00.000Z',
      }],
    });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    expect(await screen.findByText('SuperGrok')).toBeInTheDocument();
  });

  it('shows unified quota without source names or instance counts', async () => {
    api.getProviderUsage.mockResolvedValue({ providers: [fleetCard] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    expect(await screen.findByText('65% used')).toBeInTheDocument();
    expect(screen.queryByText('2 instances')).not.toBeInTheDocument();
    expect(screen.queryByText(/Example Box/)).not.toBeInTheDocument();
    expect(screen.queryByText(fleetCard.note)).not.toBeInTheDocument();
  });

  it('shows no fleet pill on a single-machine install', async () => {
    api.getProviderUsage.mockResolvedValue({ providers: [{ ...fleetCard, fleet: undefined, note: 'This machine only — other federated instances have not reported a reading yet.' }] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    await screen.findByText('Claude Code');
    expect(screen.queryByText(/^\d+ instances$/)).not.toBeInTheDocument();
  });

  it('uses a current quota without displaying a superseded expired peer', async () => {
    api.getProviderUsage.mockResolvedValue({ providers: [
      { family: 'grok', label: 'Grok', supported: true, fetchedAt: '2026-11-02T00:00:00.000Z',
        limits: [{ key: 'week', label: 'Weekly', percentUsed: 20, percentRemaining: 80 }], origin: { self: true, name: 'Local Box' } },
      { family: 'grok', label: 'Grok', supported: true, fetchedAt: '2026-10-20T00:00:00.000Z', limits: [],
        quotaStatus: 'expired', error: 'Every window in this reading has since reset — refresh for a current one.',
        origin: { self: false, instanceId: 'old', name: 'synthetic-offline-peer' } },
    ] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    expect(await screen.findByText('20% used')).toBeInTheDocument();
    const grid = screen.getByLabelText('Subscription provider usage');
    expect(grid).not.toHaveTextContent('synthetic-offline-peer');
    expect(grid).not.toHaveTextContent('Local Box');
    expect(grid).not.toHaveTextContent('since reset');
    expect(within(grid).queryByText(/^\d+ instances$/)).not.toBeInTheDocument();
  });

  it('shows one provider-level expired state when only activity and expired windows remain', async () => {
    api.getProviderUsage.mockResolvedValue({ providers: [
      { family: 'grok', label: 'Grok', supported: true, fetchedAt: '2026-11-02T00:00:00.000Z', limits: [],
        activity: [{ period: 'week', requests: 8, sessions: 2 }], origin: { self: true, name: 'Local Box' } },
      { family: 'grok', label: 'Grok', supported: true, fetchedAt: '2026-10-20T00:00:00.000Z', limits: [],
        quotaStatus: 'expired', error: 'Window reset', origin: { self: false, instanceId: 'old', name: 'synthetic-offline-peer' } },
    ] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    expect(await screen.findByText('The last available quota reading has expired. Refresh for a current reading.')).toBeInTheDocument();
    const grid = screen.getByLabelText('Subscription provider usage');
    expect(grid).not.toHaveTextContent('synthetic-offline-peer');
    expect(grid).not.toHaveTextContent('Local Box');
    expect(within(grid).queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('keeps an observed image refusal without per-source counts or names', async () => {
    api.getProviderUsage.mockResolvedValue({ providers: [
      { family: 'imagegen', label: 'Image Gen', supported: true, limits: [],
        metrics: [{ key: 'imagegen-grok', label: 'Grok images', value: 'No renders' }],
        fetchedAt: '2026-01-03T00:00:00.000Z', origin: { self: true, name: 'This instance' } },
      { family: 'imagegen', label: 'Image Gen', supported: true,
        limits: [{ key: 'imagegen-grok', label: 'Grok images', percentUsed: 100, percentRemaining: 0 }],
        fetchedAt: '2026-01-02T00:00:00.000Z', origin: { self: false, instanceId: 'peer', name: 'Peer' } },
      { family: 'imagegen', label: 'Image Gen', supported: true,
        limits: [{ key: 'imagegen-grok', label: 'Grok images', percentUsed: 100, percentRemaining: 0 }],
        fetchedAt: '2026-01-01T00:00:00.000Z', origin: { self: false, instanceId: 'peer-two', name: 'Other Peer' } },
    ] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    expect(await screen.findByText(/Grok images: refusal observed/)).toBeInTheDocument();
    expect(screen.getAllByText(/Grok images: refusal observed/)).toHaveLength(1);
    expect(screen.getByText(/Grok images: refusal observed/)).toHaveTextContent(/reported .* ago/);
    expect(screen.queryByText('No renders')).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Image Gen' })).toHaveLength(1);
    expect(screen.getByText('Image providers do not report a quota meter.')).toBeInTheDocument();
    expect(screen.queryByText(/^Peer/)).not.toBeInTheDocument();
  });

  it('shows a newer diagnostic alongside an older meter', async () => {
    api.getProviderUsage.mockResolvedValue({ providers: [
      { family: 'codex', label: 'Codex', supported: true, limits: [], error: 'Weekly limit reached', quotaStatus: 'limit_reached',
        fetchedAt: '2026-01-03T00:00:00.000Z', origin: { self: true, name: 'This instance' } },
      { family: 'codex', label: 'Codex', supported: true,
        limits: [{ key: 'week', label: 'Weekly', percentUsed: 20, percentRemaining: 80 }],
        fetchedAt: '2026-01-02T00:00:00.000Z', origin: { self: false, instanceId: 'peer', name: 'Peer' } },
    ] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    expect(await screen.findByText('20% used')).toBeInTheDocument();
    expect(screen.getByText('Weekly limit reached')).toBeInTheDocument();
    expect(screen.queryByText(/^This instance/)).not.toBeInTheDocument();
  });

  it('retains local advisories when a peer supplies the newest quota', async () => {
    api.getProviderUsage.mockResolvedValue({ providers: [
      { family: 'codex', label: 'Codex', supported: true, routingOverridden: true,
        limits: [{ key: 'week', label: 'Weekly', percentUsed: 10, percentRemaining: 90 }],
        fetchedAt: '2026-01-01T00:00:00.000Z', origin: { self: true, name: 'This instance' } },
      { family: 'codex', label: 'Codex', supported: true,
        limits: [{ key: 'week', label: 'Weekly', percentUsed: 20, percentRemaining: 80 }],
        fetchedAt: '2026-01-02T00:00:00.000Z', origin: { self: false, instanceId: 'peer', name: 'Peer' } },
    ] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    expect(await screen.findByText('20% used')).toBeInTheDocument();
    expect(screen.getByText('Model routing may bypass this quota.')).toBeInTheDocument();
  });

  // A federated card can be filled by a peer while this machine's own scrape is
  // still running. The meters are worth showing meanwhile, but the card must
  // keep saying it is still reading — that flag is what keeps the page polling
  // until the local reading lands, instead of settling on a stand-in.
  it('shows a peer reading while this machine is still scraping, without hiding that it is still reading', async () => {
    api.getProviderUsage.mockResolvedValue({ providers: [{ ...fleetCard, pending: true }] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    // Both, not either: the meters are the best number available right now, and
    // the spinner is what says a better one is coming (and what the page's
    // pending poll keys on, so the local reading actually swaps in).
    expect(await screen.findByText('65% used')).toBeInTheDocument();
    expect(screen.getByText('Reading quota…')).toBeInTheDocument();
  });

  it('shows an older reading age without a machine attribution', async () => {
    const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
    // `stale` is now a server-computed verdict (period-relative, see
    // server/lib/quotaWindows.js) — this fixture stands in for what the API
    // would have stamped: the 50h-old weekly reading is well past its window's
    // threshold, the moment-old session reading is not.
    api.getProviderUsage.mockResolvedValue({ providers: [{
      ...fleetCard,
      limits: [
        { key: 'week', label: 'Weekly', percentUsed: 12, percentRemaining: 88, readAt: hoursAgo(50), readBy: 'inst-peer', readByName: 'Example Box', stale: true },
        { key: 'session', label: 'Session', percentUsed: 30, percentRemaining: 70, readAt: hoursAgo(0), readBy: null, readByName: null, stale: false },
      ],
    }] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    // The stand-in says whose reading it is and how old — a 12% weekly figure
    // read two days ago must not read as this moment's.
    expect(await screen.findByText(/read 2d ago/)).toBeInTheDocument();
    expect(screen.queryByText(/on Example Box/)).not.toBeInTheDocument();
    // This machine's own reading carries no such caption.
    expect(screen.getByText('30% used')).toBeInTheDocument();
  });
});

describe('UsagePage mobile provider-card layout', () => {
  const metricsCard = {
    family: 'imagegen',
    label: 'Image Gen',
    supported: true,
    plan: 'pro',
    limits: [],
    activity: [],
    metrics: [
      { key: 'codex', label: 'Codex · image_gen', value: 'No renders · 24h', detail: 'quota not reported by this CLI' },
      { key: 'grok', label: 'Grok · image_gen', value: 'No renders · 24h', detail: 'quota not reported by this CLI' },
    ],
    fleet: {
      count: 2,
      instances: [
        { instanceId: 'inst-self', name: null, self: true, fetchedAt: '2026-09-03T10:00:00.000Z' },
        { instanceId: 'inst-peer', name: 'Example Box', self: false, fetchedAt: '2026-09-03T11:00:00.000Z' },
      ],
    },
  };

  it('hides the plan badge at phone width and omits instance details', async () => {
    api.getProviderUsage.mockResolvedValue({ providers: [metricsCard] });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    await screen.findByRole('heading', { name: 'Image Gen' });
    const tokens = screen.getByText('pro').className.split(/\s+/);
    expect(tokens).toContain('hidden');
    expect(tokens).not.toContain('inline-flex');
    expect(screen.queryByText('2 instances')).not.toBeInTheDocument();
    expect(screen.queryByText('No renders · 24h')).not.toBeInTheDocument();
    expect(screen.getByText('Image providers do not report a quota meter.')).toBeInTheDocument();
  });

  it('does not present per-source image render counts as account quota', async () => {
    const cardWithPeriods = {
      family: 'imagegen',
      label: 'Image Gen',
      supported: true,
      limits: [],
      activity: [],
      period: '24h',
      metrics: [
        {
          key: 'imagegen-agy',
          label: 'Agy · generate_image',
          value: '2 renders · 24h',
          detail: 'quota not reported by this CLI',
          periods: {
            '24h': { key: '24h', label: '24h', count: 2, failed: 0, value: '2 renders · 24h', detail: 'quota not reported by this CLI' },
            '7d': { key: '7d', label: 'Week', count: 7, failed: 1, value: '7 renders · week', detail: '1 failed' },
            '30d': { key: '30d', label: 'Month', count: 25, failed: 1, value: '25 renders · month', detail: '1 failed' },
          },
        },
      ],
    };

    api.getProviderUsage.mockResolvedValue({ providers: [cardWithPeriods] });
    // The report mounts other cards whose fetches settle after the quota heading.
    await act(async () => { render(<MemoryRouter><UsagePage /></MemoryRouter>); });

    await screen.findByRole('heading', { name: 'Image Gen' });
    expect(screen.queryByText('2 renders · 24h')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Usage period' })).not.toBeInTheDocument();
    expect(screen.getByText('Image providers do not report a quota meter.')).toBeInTheDocument();
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

describe('UsagePage free-tier section (#7408)', () => {
  const freeTier = {
    basis: 'ledger',
    providers: [{
      id: 'opencode-zen-cli',
      name: 'OpenCode Zen CLI',
      free: true,
      sessions: 3,
      messages: 5,
      tokensIn: 1200,
      tokensOut: 3400,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      source: 'mixed',
      estimatedCost: 0,
      rateMatch: 'free',
      models: [{
        model: 'opencode/big-pickle',
        sessions: 3,
        messages: 5,
        tokensIn: 1200,
        tokensOut: 3400,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        source: 'mixed',
        estimatedCost: 0,
        rateMatch: 'free'
      }]
    }],
    blocks: [{
      providerId: 'opencode-zen-cli',
      model: null,
      category: 'usage-limit',
      message: 'hit your usage limit',
      resetHint: '2 hours',
      at: Date.now() - 60_000,
      volumeSince: { sessions: 1, messages: 2, tokensIn: 100, tokensOut: 200 }
    }]
  };

  it('renders free-tier queries, tokens, and the observed block from the report payload', async () => {
    api.getUsage.mockResolvedValue({ ...usage, freeTier });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    expect(await screen.findByText('Free-tier usage')).toBeInTheDocument();
    expect(screen.getByText('OpenCode Zen CLI')).toBeInTheDocument();
    expect(screen.getByText('opencode/big-pickle')).toBeInTheDocument();
    // Observed block with its reset hint and since-volume.
    expect(screen.getByText(/provider said: 2 hours/)).toBeInTheDocument();
    expect(screen.getByText(/out since/)).toBeInTheDocument();
  });

  it('renders an empty state when no free-tier usage exists yet', async () => {
    api.getUsage.mockResolvedValue({ ...usage, freeTier: { basis: 'ledger', providers: [], blocks: [] } });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    expect(await screen.findByText('No free-tier usage recorded in this period.')).toBeInTheDocument();
  });
});

describe('UsagePage custom date range inputs', () => {
  it('keeps a half-typed date instead of resetting it, and commits once complete', async () => {
    api.getUsage.mockResolvedValue(usage);
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    // Settle mount-time fetches before interacting with the form. ClaudeCodeModelTokensCard
    // calls getClaudeCodeModelUsage on mount; waiting here ensures all mount effects complete
    // before we read the input value, avoiding act warnings from deferred state updates.
    await act(async () => {});
    const from = await screen.findByLabelText('From date');
    const callsBefore = api.getUsage.mock.calls.length;

    // Partially typed segments surface as value "" (happy-dom lacks badInput, so
    // assert the complete-date path plus that a stray year-0002 date never commits).
    fireEvent.change(from, { target: { value: '0002-09-29' } });
    expect(from.value).toBe('0002-09-29');
    expect(api.getUsage.mock.calls.length).toBe(callsBefore);

    // The commit has no debounce: it updates the URL param, and an effect then refetches.
    // Awaiting act flushes that whole chain, so the assertion never races a wall-clock timeout.
    await act(async () => { fireEvent.change(from, { target: { value: '2026-09-29' } }); });
    expect(api.getUsage.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(from.value).toBe('2026-09-29');
  });
});

describe('UsagePage report range freshness (#10687)', () => {
  const pricedUsage = (estimatedCost) => ({ ...usage, report: { ...usage.report, totals: { estimatedCost } } });

  it('labels retained figures during a pending and failed replacement, then clears the error on retry', async () => {
    api.getUsage.mockResolvedValueOnce(pricedUsage(123.45));
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    expect(await screen.findByText('$123.45')).toBeInTheDocument();
    let rejectRange;
    api.getUsage.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectRange = reject; }));
    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    expect(await screen.findByText('Loading selected usage range…')).toBeInTheDocument();
    expect(screen.getByText('Showing usage for 7 days. Retained figures may be stale.')).toBeInTheDocument();
    expect(screen.getByText('$123.45')).toBeInTheDocument();
    await act(async () => rejectRange(new Error('Example unavailable')));
    expect(screen.getByRole('alert')).toHaveTextContent('Usage unavailable for the selected range.');
    expect(screen.getByText('Showing usage for 7 days. Retained figures may be stale.')).toBeInTheDocument();
    api.getUsage.mockResolvedValueOnce(pricedUsage(456.78));
    fireEvent.click(screen.getByRole('button', { name: 'Retry usage' }));
    expect(await screen.findByText('$456.78')).toBeInTheDocument();
    expect(screen.getByText('Showing usage for 30 days.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.getUsage).toHaveBeenLastCalledWith({ period: '30d' }, { silent: true });
  });

  it('keeps controls and retry available after an initial invalid custom-range failure', async () => {
    api.getUsage.mockRejectedValueOnce(new Error('Example invalid range'));
    render(<MemoryRouter initialEntries={['/?from=2026-09-30&to=2026-09-01']}><UsagePage /></MemoryRouter>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Usage unavailable');
    expect(screen.queryByText('No usage data available')).not.toBeInTheDocument();
    const from = screen.getByLabelText('From date');
    expect(from).toHaveValue('2026-09-30');
    expect(screen.getByRole('button', { name: 'Retry usage' })).toBeEnabled();
    api.getUsage.mockResolvedValueOnce(pricedUsage(12.34));
    fireEvent.change(from, { target: { value: '2026-08-01' } });
    expect(await screen.findByText('$12.34')).toBeInTheDocument();
    expect(screen.getByText('Showing usage for 2026-08-01 to 2026-09-01.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('ignores a superseded failure without clearing the latest pending request or successful report', async () => {
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    await screen.findByText('Showing usage for 7 days.');
    let rejectOlder;
    let resolveLatest;
    api.getUsage.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectOlder = reject; }));
    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    api.getUsage.mockReturnValueOnce(new Promise((resolve) => { resolveLatest = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: '90 days' }));
    await act(async () => rejectOlder(new Error('Example stale failure')));
    expect(screen.getByText('Loading selected usage range…')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => resolveLatest(pricedUsage(90)));
    expect(screen.getByText('Showing usage for 90 days.')).toBeInTheDocument();
    expect(screen.getByText('$90.00')).toBeInTheDocument();
    expect(screen.queryByText('Loading selected usage range…')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});


describe('UsagePage image accounting', () => {
  it('shows image accounting as unavailable without hiding the text report or inventing zero usage', async () => {
    api.getUsage.mockResolvedValue({ ...usage, report: { ...usage.report, totals: { estimatedCost: 12 } }, imageRenders: { error: 'Image render usage is unavailable.' } });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    const card = await screen.findByRole('region', { name: 'Codex image usage' });
    expect(within(card).getByRole('status')).toHaveTextContent('Image render usage is unavailable. Text usage remains available.');
    expect(within(card).queryByText(/saved outputs|\$0/)).not.toBeInTheDocument();
    expect(screen.getAllByText('$12.00').length).toBeGreaterThan(0);
  });

  it('shows saved render activity separately from unknown image cost and allowance', async () => {
    api.getUsage.mockResolvedValue({ ...usage, imageRenders: { renderGroups: 8, codexSessions: 6, savedOutputs: 10, jobIdentityGroups: 2, imageCostUsd: null } });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    const card = await screen.findByRole('region', { name: 'Codex image usage' });
    expect(within(card).getByText(/6 Codex sessions · 10 saved outputs/)).toBeInTheDocument();
    expect(within(card).getByText(/Image tokens, image cost and subscription allowance attribution: unknown/)).toBeInTheDocument();
    expect(within(card).queryByText(/\$0/)).not.toBeInTheDocument();
    expect(within(card).getByText(/2 additional render groups use saved job IDs/)).toBeInTheDocument();
    const reads = api.getUsage.mock.calls.length;
    await act(async () => { socket.emit('image-gen:completed', { mode: 'codex' }); });
    await waitFor(() => expect(api.getUsage.mock.calls.length).toBe(reads + 1));
  });

  it('renders PageHeader with the BarChart3 icon', async () => {
    api.getUsage.mockResolvedValue(usage);
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    const heading = screen.getByRole('heading', { level: 1, name: 'Subscription Usage' });
    expect(heading).toBeInTheDocument();
    const icon = heading.parentElement?.parentElement?.querySelector('svg');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveClass('lucide-chart-column');
    await act(async () => {});
  });
});
