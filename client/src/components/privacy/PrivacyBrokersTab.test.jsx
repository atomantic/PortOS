import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

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
    { id: 'c1', brokerId: 'spokeo', brokerName: 'Spokeo', brokerTier: 1, state: 'found', evidence: { match_basis: 'name+location' }, identityEvidence: { sealed: true, listingCount: 1 }, nextRecheckAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' },
    { id: 'c2', brokerId: 'wp', brokerName: 'WhitePages', state: 'confirmed_removed', evidence: {}, updatedAt: '2026-07-02T00:00:00.000Z' },
  ],
  brokers: [{ id: 'spokeo', name: 'Spokeo', tier: 1, source: 'curated', confidence: 'documented', enabled: true, clusterParent: null, optout: {} }],
  digest: {
    total: 2,
    humanTasks: 1,
    blocked: 1,
    items: [
      { caseId: 'h1', brokerId: 'bv', brokerName: 'BeenVerified', state: 'human_task_queued', allowedTransitions: ['submitted', 'not_found', 'human_task_queued'], reason: 'human_only_channel' },
      { caseId: 'b1', brokerId: 'rad', brokerName: 'Radaris', state: 'blocked', allowedTransitions: ['found', 'not_found', 'human_task_queued'], reason: 'antibot_wall', searchUrl: 'https://rad/p/Jane/Doe/' },
    ],
  },
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
  getPrivacyCaseEvidence: vi.fn(async (id) => ({ caseId: id, sealed: true, evidence: { listing_urls: ['https://spokeo.example/p/example'] } })),
  erasePrivacyCaseEvidence: vi.fn(async (id) => ({ id, state: 'found', identityEvidence: null })),
  setPrivacyBrokerEnabled: vi.fn(async (id, enabled) => ({ id, name: 'Spokeo', enabled, tier: 1, source: 'curated', confidence: 'documented', clusterParent: null })),
}));

vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

import PrivacyBrokersTab from './PrivacyBrokersTab.jsx';
import * as apiMod from '../../services/api';

const renderTab = (props = {}) => render(<MemoryRouter initialEntries={['/privacy/brokers']}><PrivacyBrokersTab {...props} /></MemoryRouter>);

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

  it('reveals the open case\'s sealed evidence in the drawer and erases it (#8333)', async () => {
    render(<MemoryRouter initialEntries={['/privacy/brokers?case=c1']}><PrivacyBrokersTab /></MemoryRouter>);
    // The list shows only the non-identifying listing count; the drawer
    // decrypts the links for the one open case.
    const link = await screen.findByRole('link', { name: /spokeo\.example\/p\/example/ });
    expect(link.getAttribute('href')).toBe('https://spokeo.example/p/example');
    expect(apiMod.getPrivacyCaseEvidence).toHaveBeenCalledWith('c1');
    fireEvent.click(screen.getByRole('button', { name: /erase identity evidence/i }));
    fireEvent.click(screen.getByRole('button', { name: /^erase$/i }));
    await waitFor(() => expect(apiMod.erasePrivacyCaseEvidence).toHaveBeenCalledWith('c1', expect.anything()));
    await waitFor(() => expect(screen.queryByRole('link', { name: /spokeo\.example\/p\/example/ })).toBeNull());
  });

  it('actions a human-task digest item (done → submitted)', async () => {
    renderTab();
    await screen.findByText('BeenVerified');
    fireEvent.click(screen.getByLabelText('Mark done'));
    await waitFor(() => expect(apiMod.transitionPrivacyCase).toHaveBeenCalledWith('h1', 'submitted', undefined, expect.anything()));
  });

  it('a blocked digest item offers a manual-check link and transitions to found (not submitted)', async () => {
    renderTab();
    await screen.findByText('Radaris');
    // Manual browser check opens the filled search URL.
    const manualLink = screen.getByLabelText('Check manually in your browser');
    expect(manualLink.getAttribute('href')).toBe('https://rad/p/Jane/Doe/');
    // blocked → submitted is not a legal transition; the positive action is found.
    fireEvent.click(screen.getByLabelText("I'm listed"));
    await waitFor(() => expect(apiMod.transitionPrivacyCase).toHaveBeenCalledWith('b1', 'found', undefined, expect.anything()));
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

  // ── Purpose-scoped broker consent (#8332) ──
  it('warns which broker purposes are not granted and links to Household', async () => {
    const onManageConsent = vi.fn();
    renderTab({ consentScopes: ['broker_scan', 'pii_vault'], onManageConsent });
    const banner = await screen.findByText(/No active consent for broker opt-out requests for this person/);
    expect(banner.textContent).not.toMatch(/exposure scan/);
    fireEvent.click(screen.getByRole('button', { name: 'Manage consent' }));
    expect(onManageConsent).toHaveBeenCalled();
  });

  it('shows no consent warning until the grants are known', async () => {
    renderTab();
    await screen.findByText('Spokeo');
    expect(screen.queryByText(/No active consent/)).toBeNull();
  });

  it('restates a refused opt-out pass as the missing purpose grant', async () => {
    const toast = (await import('../ui/Toast')).default;
    apiMod.runPrivacyOptOut.mockRejectedValueOnce(Object.assign(new Error('raw 403'), { code: 'SUBJECT_CONSENT_REQUIRED', status: 403 }));
    renderTab();
    await screen.findByText('Spokeo');
    fireEvent.click(screen.getByRole('button', { name: /Run opt-out pass/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/^No active consent for broker opt-out requests/)));
  });
});
