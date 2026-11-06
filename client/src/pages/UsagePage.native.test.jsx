import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
vi.mock('../services/socket', async () => {
  const { EventEmitter } = await import('events');
  return { default: new EventEmitter() };
});
const api = vi.hoisted(() => ({
  getNativeUsageMatrix: vi.fn(), getUsage: vi.fn(), getProviderUsage: vi.fn(),
  getUsageBackfillStatus: vi.fn(), getUsageRollingCost: vi.fn(), getClaudeCodeModelUsage: vi.fn(),
}));
vi.mock('../services/api', () => api);
import UsagePage from './UsagePage';
const codex = (tokens = 123456, extra = {}) => ({ family: 'codex', status: 'available',
  totals: { lifetimeTokens: tokens, dailyBuckets: [{ startDate: '2026-01-31', tokens: 10 }, { startDate: '2026-02-01', tokens: 20 }, { startDate: '2026-02-03', tokens: 30 }] },
  runtime: { status: 'observed', versions: ['1.2.3'] }, ...extra,
});
const retained = (family, totalTokens, extra = {}) => ({ family, status: 'partial',
  totals: { totalTokens, tokensIn: 1200, tokensOut: 234, cacheReadTokens: 0, cacheWriteTokens: null },
  tokenFields: { totalTokens: 'measured', tokensIn: 'measured', cacheWriteTokens: 'unsupported' },
  coverage: { files: 2, measuredRecords: 3, missingUsageRecords: 1, unreadableFiles: 0 },
  scanCaps: { capped: true, stoppedEarly: false, limits: { records: 10000 } },
  findings: ['scan-capped'], runtime: { status: 'unknown', versions: [] }, ...extra,
});
const snapshot = (...providers) => ({ mode: 'read-only', scope: 'local-instance', contractVersion: 4,
  generatedAt: '2026-02-04T12:00:00Z', peerReports: 'not-collected', providers: providers.length ? providers : [codex(),
    retained('claude', 1434), retained('grok', 9876, { cost: { nativeCostSignal: { knownCostUsdTicks: 7654, measuredRecords: 2, missingRecords: 1, conflictingRecords: 0 } } }),
    retained('agy', null, { totals: { totalTokens: null, tokensIn: 40, tokensOut: 20, cacheReadTokens: 200, cacheWriteTokens: 0, thinkingOutputTokens: 12, responseOutputTokens: 8 }, tokenFields: { totalTokens: 'unverified-overlap' } }),
  ], families: [], refusals: [] });
function Location() { return <output aria-label="Location">{useLocation().search}</output>; }
const show = () => render(<MemoryRouter initialEntries={['/devtools/usage']}><UsagePage /><Location /></MemoryRouter>);
beforeEach(() => {
  vi.clearAllMocks();
  api.getNativeUsageMatrix.mockResolvedValue(snapshot());
  api.getProviderUsage.mockResolvedValue({ providers: [] });
  api.getUsage.mockResolvedValue({ totalTokens: {}, last7Days: [], hourlyActivity: [], topProviders: [], topModels: [], report: { providers: [], totals: { estimatedCost: 0 } } });
  api.getUsageBackfillStatus.mockResolvedValue({ status: 'idle' });
  api.getUsageRollingCost.mockResolvedValue({ windowDays: 30, series: [], points: [] });
  api.getClaudeCodeModelUsage.mockResolvedValue({ filesScanned: 0, models: [], totals: {} });
});
const read = () => fireEvent.click(screen.getByRole('button', { name: 'Read native sources' }));
const refresh = () => fireEvent.click(screen.getByRole('button', { name: 'Refresh native sources' }));
const card = name => screen.getByRole('region', { name: `${name} native history` });
const metric = (region, label) => within(region).getByText(label).nextElementSibling;

describe('native usage default view', () => {
  it('starts unscanned, reads all four providers only on explicit request, and keeps legacy accounting URL-backed', async () => {
    show();
    expect(screen.getAllByText(/Not scanned yet/)).toHaveLength(4);
    expect(api.getNativeUsageMatrix).not.toHaveBeenCalled();
    expect(api.getUsage).not.toHaveBeenCalled();
    expect(api.getProviderUsage).not.toHaveBeenCalled();
    expect(api.getClaudeCodeModelUsage).not.toHaveBeenCalled();
    read();
    expect(await screen.findByText('123,456')).toBeInTheDocument();
    expect(api.getNativeUsageMatrix).toHaveBeenCalledExactlyOnceWith({ silent: true });
    expect(metric(card('Claude Code'), 'Measured retained tokens')).toHaveTextContent('1,434');
    expect(metric(card('Grok'), 'Measured retained tokens')).toHaveTextContent('9,876');
    expect(metric(card('Grok'), 'Native cost ticks (unverified scope)')).toHaveTextContent('7,654');
    expect(metric(card('Antigravity'), 'Measured retained tokens')).toHaveTextContent('Unknown');
    expect(metric(card('Antigravity'), 'Input tokens')).toHaveTextContent('40');
    expect(metric(card('Antigravity'), 'Output tokens')).toHaveTextContent('20');
    expect(metric(card('Antigravity'), 'Cache read tokens')).toHaveTextContent('200');
    expect(metric(card('Antigravity'), 'Cache write tokens')).toHaveTextContent('0');
    expect(metric(card('Antigravity'), 'Thinking output tokens')).toHaveTextContent('12');
    expect(metric(card('Antigravity'), 'Response output tokens')).toHaveTextContent('8');
    expect(metric(card('Claude Code'), 'Cache write tokens')).toHaveTextContent('Unknown');
    expect(screen.queryByText(/\$7,654/)).not.toBeInTheDocument();
    expect(card('Codex')).toHaveTextContent('1.2.3');
    expect(card('Claude Code')).toHaveTextContent('scan-capped');
    expect(card('Claude Code')).toHaveTextContent('10,000');
    fireEvent.click(screen.getByRole('tab', { name: 'Legacy analytics' }));
    await waitFor(() => expect(api.getUsage).toHaveBeenCalled());
    expect(screen.getByLabelText('Location')).toHaveTextContent('view=legacy');
    fireEvent.click(screen.getByRole('tab', { name: 'Native history' }));
    expect(screen.getByLabelText('Location')).not.toHaveTextContent('view=legacy');
    expect(screen.getAllByText(/Not scanned yet/)).toHaveLength(4);
    expect(api.getNativeUsageMatrix).toHaveBeenCalledTimes(1);
  });

  it('shows native calendar buckets without inventing gaps and shares month selection in the URL', async () => {
    show(); read();
    await screen.findByText('123,456');
    fireEvent.click(screen.getByText('Daily native token history'));
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    fireEvent.change(screen.getByLabelText('Reported month'), { target: { value: '2026-01' } });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(screen.getByLabelText('Location')).toHaveTextContent('nativeMonth=2026-01');
    expect(api.getNativeUsageMatrix).toHaveBeenCalledTimes(1);
  });

  it('retains explicitly stale data after transport failure but replaces successes with unavailable snapshots and recovers', async () => {
    api.getNativeUsageMatrix.mockResolvedValueOnce(snapshot(codex(0)));
    show(); read();
    await waitFor(() => expect(metric(card('Codex'), 'Native lifetime tokens')).toHaveTextContent('0'));
    api.getNativeUsageMatrix.mockRejectedValueOnce(new Error('synthetic network failure'));
    refresh();
    expect(await screen.findByRole('alert')).toHaveTextContent('Stale: the previous snapshot remains');
    expect(metric(card('Codex'), 'Native lifetime tokens')).toHaveTextContent('0');
    api.getNativeUsageMatrix.mockResolvedValueOnce(snapshot(codex(null, { status: 'unavailable', totals: null, findings: ['source-unavailable'] })));
    refresh();
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(metric(card('Codex'), 'Native lifetime tokens')).toHaveTextContent('Unknown');
    expect(card('Codex')).toHaveTextContent('History unavailable');
    refresh();
    expect(await screen.findByText('123,456')).toBeInTheDocument();
  });

  it('separates local measurements from refused selected-account totals and missing peers', async () => {
    const response = snapshot();
    response.families = [{ family: 'agy', scope: 'selected-account-retained-records',
      merge: { status: 'refused', reasons: ['member-report-missing'], totals: null },
      accounts: [{ accountLabel: 'example-subscription', status: 'refused', totals: null,
        members: ['local', 'peer'], membersWithoutReport: ['peer'], findings: ['retained-history-completeness-unknown'] }], unresolvedParticipants: ['other'] }];
    response.refusals = [{ code: 'selections-invalid', family: null }];
    api.getNativeUsageMatrix.mockResolvedValueOnce(response);
    show(); read(); await screen.findByText('123,456');
    const agy = card('Antigravity');
    expect(agy).toHaveTextContent('2 selected members · 1 members without reports');
    expect(agy).toHaveTextContent('Missing peer reports');
    expect(agy).toHaveTextContent('member-report-missing');
    expect(agy).toHaveTextContent('unresolved account selection');
    expect(agy).toHaveTextContent('not a fleet-complete total');
    expect(screen.getByText('All providers: selections-invalid')).toBeInTheDocument();
    expect(metric(agy, 'Input tokens')).toHaveTextContent('40');
    expect(within(agy).getAllByText('Measured retained tokens')).toHaveLength(1);
  });

  it('shows a valid partial account union separately without implying complete account history', async () => {
    const response = snapshot();
    const totals = { totalTokens: null, tokensIn: 80, tokensOut: 30, cacheReadTokens: 300, cacheWriteTokens: 0, thinkingOutputTokens: 18, responseOutputTokens: 12 };
    response.families = [{ family: 'agy', merge: { status: 'partial', reasons: [], totals },
      accounts: [{ accountLabel: 'example-subscription', status: 'partial', totals, members: ['local'], membersWithoutReport: [], findings: ['retained-history-completeness-unknown'] }] }];
    api.getNativeUsageMatrix.mockResolvedValueOnce(response);
    show(); read(); await screen.findByText('123,456');
    const union = within(card('Antigravity')).getByText('Selected account union').parentElement;
    expect(union).toHaveTextContent('partial');
    expect(union).toHaveTextContent('not a fleet-complete total');
    expect(within(union).getAllByText('Input tokens').map(label => label.nextElementSibling.textContent)).toEqual(['80', '80']);
    expect(within(union).getAllByText('Measured retained tokens').map(label => label.nextElementSibling.textContent)).toEqual(['Unknown', 'Unknown']);
    expect(within(card('Antigravity')).getAllByText('Input tokens')[0].nextElementSibling).toHaveTextContent('40');
  });

  it('guards repeated clicks and ignores an old response after leaving and re-entering the view', async () => {
    let finishOld;
    api.getNativeUsageMatrix.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    show();
    const button = screen.getByRole('button', { name: 'Read native sources' });
    fireEvent.click(button); fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(api.getNativeUsageMatrix).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('tab', { name: 'Legacy analytics' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Native history' }));
    expect(api.getNativeUsageMatrix).toHaveBeenCalledTimes(1);
    read();
    expect(await screen.findByText('123,456')).toBeInTheDocument();
    await act(async () => { finishOld(snapshot(codex(999))); });
    expect(screen.queryByText('999')).not.toBeInTheDocument();
    expect(screen.getByText('123,456')).toBeInTheDocument();
  });
});
