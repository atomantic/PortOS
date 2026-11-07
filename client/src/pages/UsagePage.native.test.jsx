import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
vi.mock('../services/socket', async () => {
  const { EventEmitter } = await import('events');
  return { default: new EventEmitter() };
});
const api = vi.hoisted(() => ({
  getNativeUsageMatrix: vi.fn(), rebuildNativeUsageSources: vi.fn(), getUsage: vi.fn(), getProviderUsage: vi.fn(),
  getUsageBackfillStatus: vi.fn(), getUsageRollingCost: vi.fn(), getClaudeCodeModelUsage: vi.fn(),
}));
vi.mock('../services/api', () => api);
import UsagePage from './UsagePage';
import { getNativeUsageMatrix as requestNativeMatrix } from '../services/apiSystem';
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
const fleetSnapshot = () => {
  const local = snapshot();
  const participantKey = 'a'.repeat(32);
  const peerKey = 'b'.repeat(32);
  const capturedAt = '2026-02-04T12:00:00Z';
  return { ...local, scope: 'configured-peers', peerReports: 'collected', participantKey,
    peerCollection: { status: 'partial', maxPeers: 8, requested: 2, received: 1,
      peers: [{ participantKey: peerKey, status: 'available', capturedAt },
        { participantKey: 'c'.repeat(32), status: 'stale', capturedAt: '2026-02-01T12:00:00Z' },
        { participantKey: 'd'.repeat(32), status: 'invalid', capturedAt: null },
        { participantKey: 'e'.repeat(32), status: 'not-configured', capturedAt: null },
        { participantKey: null, status: 'identity-unknown', capturedAt: null },
        { participantKey: 'f'.repeat(32), status: 'unavailable', retained: true, capturedAt: '2026-02-01T12:00:00Z' }], findings: ['peer-report-stale'] },
    participants: [{ participantKey, capturedAt, providers: local.providers },
      { participantKey: 'f'.repeat(32), capturedAt: '2026-02-01T12:00:00Z', retained: true, providers: [retained('claude', 5555)] },
      { participantKey: peerKey, capturedAt, providers: [retained('claude', 9999, {
        freshness: { earliestObserved: '2026-02-01T12:00:00Z', latestObserved: '2026-02-03T12:00:00Z' },
        coverage: { measuredRecords: 4000, missingUsageRecords: 12 },
      })] }],
  };
};
function Location() {
  const navigate = useNavigate();
  return <><output aria-label="Location">{useLocation().search}</output>
    <button type="button" onClick={() => navigate(-1)}>Back</button><button type="button" onClick={() => navigate(1)}>Forward</button></>;
}
const show = (path = '/devtools/usage') => render(<MemoryRouter initialEntries={[path]}><UsagePage /><Location /></MemoryRouter>);
beforeEach(() => {
  vi.clearAllMocks();
  api.getNativeUsageMatrix.mockResolvedValue(snapshot());
  api.getProviderUsage.mockResolvedValue({ providers: [] });
  api.getUsage.mockResolvedValue({ totalTokens: {}, last7Days: [], hourlyActivity: [], topProviders: [], topModels: [], report: { providers: [], totals: { estimatedCost: 0 } } });
  api.getUsageBackfillStatus.mockResolvedValue({ status: 'idle' });
  api.getUsageRollingCost.mockResolvedValue({ windowDays: 30, series: [], points: [] });
  api.getClaudeCodeModelUsage.mockResolvedValue({ filesScanned: 0, models: [], totals: {} });
});
afterEach(() => vi.restoreAllMocks());
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
    expect(api.getNativeUsageMatrix).toHaveBeenCalledExactlyOnceWith({ scope: 'local' }, { silent: true });
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

  it('rebuilds on request and shows the result of that read', async () => {
    api.rebuildNativeUsageSources.mockResolvedValue(snapshot(codex(777)));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild from sources' }));
    expect(await screen.findByText('777')).toBeInTheDocument();
    expect(api.rebuildNativeUsageSources).toHaveBeenCalledExactlyOnceWith({ scope: 'local' }, { silent: true });
    expect(api.getNativeUsageMatrix).not.toHaveBeenCalled();
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

  it('shows fleet collection failures and accepted participant coverage without mixing local counters or asserting account identity', async () => {
    api.getNativeUsageMatrix.mockResolvedValueOnce(fleetSnapshot());
    show('/devtools/usage?nativeScope=fleet');
    expect(screen.getByLabelText('Native history scope')).toHaveValue('fleet');
    expect(api.getNativeUsageMatrix).not.toHaveBeenCalled();
    read();
    const collection = await screen.findByRole('region', { name: 'Configured peer collection' });
    expect(api.getNativeUsageMatrix).toHaveBeenCalledExactlyOnceWith({ scope: 'fleet' }, { silent: true });
    expect(collection).toHaveTextContent('partial · 1 received / 2 requested');
    expect(collection).toHaveTextContent('Up to 8 eligible peers');
    expect(collection).toHaveTextContent('does not verify account identity or complete history');
    expect(collection).toHaveTextContent('Missing reports are not zero usage');
    expect(within(collection).getByRole('link', { name: 'Manage peers' })).toHaveAttribute('href', '/instances');
    expect(collection).toHaveTextContent('Report is stale');
    expect(collection).toHaveTextContent('Report is invalid');
    expect(collection).toHaveTextContent('Selected member is not a configured peer');
    expect(collection).toHaveTextContent('Unknown identity 5');
    expect(collection).toHaveTextContent('Stale: showing the last report collected from this peer');
    expect(within(collection).getByText(/ffffffff · Peer · Stale · Captured/)).toBeInTheDocument();
    expect(collection).toHaveTextContent('aaaaaaaa · Local instance');
    expect(collection).not.toHaveTextContent('a'.repeat(32));
    fireEvent.click(within(collection).getByText(/bbbbbbbb · Peer · Captured/));
    const peer = within(collection).getByRole('region', { name: 'Claude Code coverage for bbbbbbbb' });
    expect(peer).toHaveTextContent('partial');
    expect(peer).toHaveTextContent('4,000');
    expect(peer).toHaveTextContent('Latest observed');
    expect(peer).not.toHaveTextContent('2026-02-03T12:00:00Z');
    expect(within(collection).getByRole('region', { name: 'Grok coverage for bbbbbbbb' })).toHaveTextContent('unavailable');
    expect(metric(card('Claude Code'), 'Measured retained tokens')).toHaveTextContent('1,434');
    expect(screen.queryByText('9,999')).not.toBeInTheDocument();
    expect(card('Claude Code')).toHaveTextContent('Configured-peer collection: partial');
    expect(card('Claude Code')).toHaveTextContent('not a fleet-complete total');
    expect(screen.queryByText(/Peer reports are not collected/)).not.toBeInTheDocument();
  });

  it('clears snapshots on scope changes and browser navigation without automatic reads', async () => {
    show('/devtools/usage?nativeMonth=2026-01'); read();
    await screen.findByText('123,456');
    fireEvent.change(screen.getByLabelText('Native history scope'), { target: { value: 'fleet' } });
    expect(screen.getByLabelText('Location')).toHaveTextContent('nativeScope=fleet');
    expect(screen.getByLabelText('Location')).not.toHaveTextContent('nativeMonth');
    expect(screen.queryByText('123,456')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Not scanned yet/)).toHaveLength(4);
    expect(api.getNativeUsageMatrix).toHaveBeenCalledTimes(1);
    api.getNativeUsageMatrix.mockResolvedValueOnce(fleetSnapshot());
    read(); await screen.findByRole('region', { name: 'Configured peer collection' });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Native history scope')).toHaveValue('local');
    expect(screen.queryByRole('region', { name: 'Configured peer collection' })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Not scanned yet/)).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
    expect(screen.getByLabelText('Native history scope')).toHaveValue('fleet');
    expect(screen.getAllByText(/Not scanned yet/)).toHaveLength(4);
    expect(api.getNativeUsageMatrix).toHaveBeenCalledTimes(2);
  });

  it('sends selected fleet scope through the HTTP wrapper without treating request options as query params', async () => {
    const fetchRequest = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => fleetSnapshot() });
    api.getNativeUsageMatrix.mockImplementationOnce(requestNativeMatrix);
    show('/devtools/usage?nativeScope=fleet');
    expect(fetchRequest).not.toHaveBeenCalled();
    read(); await screen.findByRole('region', { name: 'Configured peer collection' });
    expect(fetchRequest).toHaveBeenCalledExactlyOnceWith('/api/usage/native-matrix?scope=fleet', { headers: { 'Content-Type': 'application/json' } });
  });

  it('disposes pending scope reads, including late failures, without overwriting a newer read', async () => {
    let finishLocal;
    let failFleet;
    api.getNativeUsageMatrix.mockImplementationOnce(() => new Promise(resolve => { finishLocal = resolve; }));
    show(); read();
    fireEvent.change(screen.getByLabelText('Native history scope'), { target: { value: 'fleet' } });
    expect(screen.getByRole('button', { name: 'Read native sources' })).toBeEnabled();
    api.getNativeUsageMatrix.mockImplementationOnce(() => new Promise((_, reject) => { failFleet = reject; }));
    read();
    fireEvent.change(screen.getByLabelText('Native history scope'), { target: { value: 'local' } });
    read(); await screen.findByText('123,456');
    await act(async () => {
      finishLocal(snapshot(codex(999)));
      failFleet(new Error('Synthetic delayed peer failure'));
    });
    expect(screen.queryByText('999')).not.toBeInTheDocument();
    expect(screen.getByText('123,456')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.getNativeUsageMatrix).toHaveBeenCalledTimes(3);
  });
});
