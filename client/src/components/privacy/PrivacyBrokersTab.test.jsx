import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Deferred promise helper for asserting in-flight (disable-while-running) gating.
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

const api = vi.hoisted(() => ({
  scanStatus: {
    enabledBrokers: 2,
    caseCounts: { found: 1, confirmed_removed: 1, human_task_queued: 1 },
    dueForRecheck: 1,
  },
  cases: [
    { id: 'c1', brokerId: 'spokeo', brokerName: 'Spokeo', brokerTier: 1, state: 'found', evidence: { listing_urls: ['http://x/1'] }, nextRecheckAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' },
    { id: 'c2', brokerId: 'wp', brokerName: 'WhitePages', state: 'confirmed_removed', evidence: {}, updatedAt: '2026-07-02T00:00:00.000Z' },
  ],
  brokers: [{ id: 'spokeo', name: 'Spokeo', tier: 1, source: 'curated', confidence: 'documented', enabled: true, clusterParent: null, optout: {} }],
  digest: { total: 1, humanTasks: 1, blocked: 0, items: [{ caseId: 'h1', brokerId: 'bv', brokerName: 'BeenVerified', state: 'human_task_queued', reason: 'human_only_channel' }] },
  schedule: { enabled: false, cronExpression: '0 4 * * 0', autoApproveOptOutEmails: false, autoSubmitWebForms: false, nextRun: null },
  runScanDeferred: null,
}));

vi.mock('../../services/api', () => ({
  getPrivacyScanStatus: vi.fn(async () => api.scanStatus),
  getPrivacyBrokerCases: vi.fn(async () => api.cases),
  getPrivacyBrokers: vi.fn(async () => api.brokers),
  getPrivacyOptOutDigest: vi.fn(async () => api.digest),
  getPrivacyOptOutSchedule: vi.fn(async () => api.schedule),
  updatePrivacyOptOutSchedule: vi.fn(async (patch) => ({ ...api.schedule, ...patch })),
  runPrivacyScan: vi.fn(() => (api.runScanDeferred ? api.runScanDeferred.promise : Promise.resolve({ scanned: 1, verdicts: { found: 1 }, skipped: 0 }))),
  runPrivacyOptOut: vi.fn(async () => ({ submitted: [], skipped: 0 })),
  refreshPrivacyBrokers: vi.fn(async () => ({ added: 0, fetched: 0 })),
  recheckPrivacyCase: vi.fn(async () => ({ id: 'c1' })),
  transitionPrivacyCase: vi.fn(async (id, toState) => ({ id, state: toState })),
  setPrivacyBrokerEnabled: vi.fn(async (id, enabled) => ({ id, name: 'Spokeo', enabled, tier: 1, source: 'curated', confidence: 'documented', clusterParent: null })),
}));

vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

import PrivacyBrokersTab from './PrivacyBrokersTab.jsx';
import * as apiMod from '../../services/api';

const renderTab = () => render(<MemoryRouter initialEntries={['/privacy/brokers']}><PrivacyBrokersTab /></MemoryRouter>);

describe('PrivacyBrokersTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.runScanDeferred = null;
  });

  it('renders the case board and filters by state', async () => {
    renderTab();
    // Both cases visible initially.
    expect(await screen.findByText('Spokeo')).toBeTruthy();
    expect(screen.getByText('WhitePages')).toBeTruthy();

    // Filter to confirmed_removed — Spokeo (found) drops out.
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'confirmed_removed' } });
    await waitFor(() => expect(screen.queryByText('Spokeo')).toBeNull());
    expect(screen.getByText('WhitePages')).toBeTruthy();
  });

  it('actions a human-task digest item (done → submitted)', async () => {
    renderTab();
    await screen.findByText('BeenVerified');
    fireEvent.click(screen.getByLabelText('Mark done'));
    await waitFor(() => expect(apiMod.transitionPrivacyCase).toHaveBeenCalledWith('h1', 'submitted', undefined, expect.anything()));
  });

  it('disables both run buttons while a pass is in flight', async () => {
    api.runScanDeferred = deferred();
    renderTab();
    const scanBtn = await screen.findByRole('button', { name: /scan now/i });
    const optOutBtn = screen.getByRole('button', { name: /run opt-out pass/i });
    fireEvent.click(scanBtn);
    await waitFor(() => expect(optOutBtn.disabled).toBe(true));
    expect(scanBtn.disabled).toBe(true);
    // Resolve the pass — buttons re-enable.
    api.runScanDeferred.resolve({ scanned: 1, verdicts: { found: 1 }, skipped: 0 });
    await waitFor(() => expect(optOutBtn.disabled).toBe(false));
  });

  it('enables the recheck schedule via the toggle', async () => {
    renderTab();
    const checkbox = await screen.findByLabelText(/Automatic recheck schedule/i);
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    await waitFor(() => expect(apiMod.updatePrivacyOptOutSchedule).toHaveBeenCalledWith({ enabled: true }, expect.anything()));
  });

  it('toggles a broker enabled flag from the database list', async () => {
    renderTab();
    // Expand the collapsed broker database section.
    fireEvent.click(await screen.findByText(/Broker database/i));
    const brokerToggle = await screen.findByLabelText('Enable Spokeo');
    fireEvent.click(brokerToggle);
    await waitFor(() => expect(apiMod.setPrivacyBrokerEnabled).toHaveBeenCalledWith('spokeo', false, expect.anything()));
  });
});
