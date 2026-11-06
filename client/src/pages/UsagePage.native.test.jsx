import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
vi.mock('../services/socket', async () => {
  const { EventEmitter } = await import('events');
  return { default: new EventEmitter() };
});
const api = vi.hoisted(() => ({
  getNativeUsageCoverage: vi.fn(), getUsage: vi.fn(), getProviderUsage: vi.fn(),
  getUsageBackfillStatus: vi.fn(), getUsageRollingCost: vi.fn(), getClaudeCodeModelUsage: vi.fn(),
}));
vi.mock('../services/api', () => api);
import UsagePage from './UsagePage';
const codex = (tokens = 123456, extra = {}) => ({ family: 'codex', label: 'Codex', native: {
  status: 'available', summary: { lifetimeTokens: tokens }, fetchedAt: '2026-02-04T12:00:00Z', latestReportedDay: '2026-02-03',
  dailyUsageBuckets: [{ startDate: '2026-01-31', tokens: 10 }, { startDate: '2026-02-01', tokens: 20 }, { startDate: '2026-02-03', tokens: 30 }], ...extra,
}, legacy: { tokens: 17, provenance: ['mixed'] } });
const snapshot = (...providers) => ({ providers });
function Location() { return <output aria-label="Location">{useLocation().search}</output>; }
const show = () => render(<MemoryRouter initialEntries={['/devtools/usage']}><UsagePage /><Location /></MemoryRouter>);
beforeEach(() => {
  vi.clearAllMocks();
  api.getNativeUsageCoverage.mockResolvedValue(snapshot(codex()));
  api.getProviderUsage.mockResolvedValue({ providers: [] });
  api.getUsage.mockResolvedValue({ totalTokens: {}, last7Days: [], hourlyActivity: [], topProviders: [], topModels: [], report: { providers: [], totals: { estimatedCost: 0 } } });
  api.getUsageBackfillStatus.mockResolvedValue({ status: 'idle' });
  api.getUsageRollingCost.mockResolvedValue({ windowDays: 30, series: [], points: [] });
  api.getClaudeCodeModelUsage.mockResolvedValue({ filesScanned: 0, models: [], totals: {} });
});
describe('native usage default view', () => {
  it('reads only native Codex on mount and keeps legacy accounting behind a URL-backed view', async () => {
    show();
    expect(await screen.findByText('123,456')).toBeInTheDocument();
    expect(api.getNativeUsageCoverage).toHaveBeenCalledExactlyOnceWith({ family: 'codex' }, { silent: true });
    expect(api.getUsage).not.toHaveBeenCalled();
    expect(api.getProviderUsage).not.toHaveBeenCalled();
    expect(api.getClaudeCodeModelUsage).not.toHaveBeenCalled();
    expect(screen.getByText('Account total is shown once, never summed across instances.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Legacy analytics' }));
    await waitFor(() => expect(api.getUsage).toHaveBeenCalled());
    expect(screen.getByLabelText('Location')).toHaveTextContent('view=legacy');
    fireEvent.click(screen.getByRole('tab', { name: 'Native history' }));
    expect(await screen.findByText('123,456')).toBeInTheDocument();
    expect(screen.getByLabelText('Location')).not.toHaveTextContent('view=legacy');
  });
  it('shows native calendar buckets without inventing gaps and shares month selection in the URL', async () => {
    show();
    await screen.findByText('123,456');
    fireEvent.click(screen.getByText('Daily native token history'));
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    fireEvent.change(screen.getByLabelText('Reported month'), { target: { value: '2026-01' } });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(screen.getByLabelText('Location')).toHaveTextContent('nativeMonth=2026-01');
    expect(api.getNativeUsageCoverage).toHaveBeenCalledTimes(1);
  });
  it('does not confuse unknown history with zero and retains a clearly stale snapshot after transport failure', async () => {
    api.getNativeUsageCoverage.mockResolvedValueOnce(snapshot(codex(null, { dailyUsageBuckets: null, latestReportedDay: null })));
    show();
    const card = screen.getByRole('region', { name: 'Codex native history' });
    await waitFor(() => expect(within(card).getAllByText('Unknown').length).toBeGreaterThan(0));
    api.getNativeUsageCoverage.mockResolvedValueOnce(snapshot(codex(0, { dailyUsageBuckets: [] })));
    fireEvent.click(within(card).getByRole('button', { name: 'Refresh Codex' }));
    expect(await within(card).findByText('0')).toBeInTheDocument();
    api.getNativeUsageCoverage.mockRejectedValueOnce(new Error('synthetic network failure'));
    fireEvent.click(within(card).getByRole('button', { name: 'Refresh Codex' }));
    expect(await within(card).findByRole('alert')).toHaveTextContent('previous snapshot remains');
    expect(within(card).getByText('0')).toBeInTheDocument();
  });
  it('reads a selected local source once, preserves Codex, and never presents partial records as an account total', async () => {
    show();
    await screen.findByText('123,456');
    let finish;
    api.getNativeUsageCoverage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const button = screen.getByRole('button', { name: 'Read Antigravity history' });
    fireEvent.click(button); fireEvent.click(button);
    expect(api.getNativeUsageCoverage).toHaveBeenCalledTimes(2);
    await act(async () => { finish(snapshot({ family: 'agy', label: 'Antigravity', native: {
      status: 'partial', summary: { totalTokens: null }, fetchedAt: '2026-02-04T12:00:00Z', reason: 'Token overlap is not validated.',
      coverage: { files: 2, measuredRecords: 3, missingUsageRecords: 1, conflictingRecords: 0, capped: false },
    } })); });
    const agy = screen.getByRole('region', { name: 'Antigravity native history' });
    expect(within(agy).getByText('Unknown')).toBeInTheDocument();
    expect(within(agy).getByText('Partial source coverage. This is not a complete usage total.')).toBeInTheDocument();
    expect(screen.getByText('123,456')).toBeInTheDocument();
    expect(api.getUsage).not.toHaveBeenCalled();
  });
  it('shows diagnostics when a scan stops before any usable records', async () => {
    show();
    await screen.findByText('123,456');
    api.getNativeUsageCoverage.mockResolvedValueOnce(snapshot({ family: 'claude', label: 'Claude Code', native: {
      status: 'unavailable', reason: 'No usable native records were read.',
      coverage: { files: 0, measuredRecords: 0, missingUsageRecords: 0, conflictingRecords: 0, unreadableFiles: 2, invalidLines: 0, capped: true },
    } }));
    fireEvent.click(screen.getByRole('button', { name: 'Read Claude Code history' }));
    const card = screen.getByRole('region', { name: 'Claude Code native history' });
    expect(await within(card).findByText('History unavailable. Check the source and retry the read.')).toBeInTheDocument();
    expect(within(card).getByText(/2 unreadable files/)).toHaveTextContent('scan limit reached');
  });
  it('does not let a response from a departed view replace a newer native snapshot', async () => {
    let finishOld;
    api.getNativeUsageCoverage.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    show();
    fireEvent.click(screen.getByRole('tab', { name: 'Legacy analytics' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Native history' }));
    expect(await screen.findByText('123,456')).toBeInTheDocument();
    await act(async () => { finishOld(snapshot(codex(999))); });
    expect(screen.queryByText('999')).not.toBeInTheDocument();
    expect(screen.getByText('123,456')).toBeInTheDocument();
  });
});
