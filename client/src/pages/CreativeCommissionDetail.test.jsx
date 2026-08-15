/**
 * Creative Commission detail page — render-history project resolution (#4148).
 *
 * The page used to pull EVERY Creative Director project just to index the ones
 * its runs reference, so its cost scaled with the install's total project count.
 * These cases pin the batch-by-id fetch: only the referenced ids go out, the
 * whole-list route is never touched, and an id the batch can't resolve still
 * degrades to the status-only card.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', async (importOriginal) => ({
  ...(await importOriginal()),
  getCommission: vi.fn(),
  updateCommission: vi.fn(),
  deleteCommission: vi.fn(),
  submitCommissionFeedback: vi.fn(),
  runCommissionNow: vi.fn(),
  getCreativeDirectorProjectsByIds: vi.fn(() => Promise.resolve([])),
  listCreativeDirectorProjects: vi.fn(() => Promise.resolve([])),
}));
// The config form loads model catalogs on mount — out of scope here, and it
// would put real requests behind the assertions about which projects load.
vi.mock('../components/creative-commission/CommissionConfigForm.jsx', () => ({ default: () => null }));
vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
// ProjectPreview reaches into the media/job graph; the assertions here are about
// which projects resolved (and, for #4149, which snapshot of a project is on
// screen), so stub it down to an identifiable marker carrying the status.
vi.mock('../components/creative-director/ProjectPreview.jsx', () => ({
  default: ({ project }) => <div data-testid={`preview-${project.id}`}>{project.status}</div>,
}));

import * as api from '../services/api';
import toast from '../components/ui/Toast';
import CreativeCommissionDetail from './CreativeCommissionDetail';

const COMMISSION = {
  id: 'cc-1',
  name: 'Example commission',
  enabled: true,
  targetAbility: 'video',
  schedule: { kind: 'cron', cron: '0 9 * * *' },
  assignment: {},
  feedback: [],
  runs: [
    { id: 'run-1', projectId: 'cd-1', status: 'started', ranAt: '2026-05-01T10:00:00.000Z' },
    { id: 'run-2', projectId: 'cd-2', status: 'started', ranAt: '2026-05-02T10:00:00.000Z' },
    // Same project as run-1 — the batch must de-duplicate it.
    { id: 'run-3', projectId: 'cd-1', status: 'started', ranAt: '2026-05-03T10:00:00.000Z' },
    // No render at all — contributes no id.
    { id: 'run-4', projectId: null, status: 'skipped', ranAt: '2026-05-04T10:00:00.000Z' },
  ],
};

const renderPage = async () => {
  render(<MemoryRouter><CreativeCommissionDetail /></MemoryRouter>);
  await screen.findByRole('heading', { name: COMMISSION.name });
};

describe('CreativeCommissionDetail render-history project resolution (#4148)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getCommission.mockResolvedValue(COMMISSION);
    api.getCreativeDirectorProjectsByIds.mockResolvedValue([]);
  });

  it('fetches only the projects its runs reference, never the whole list', async () => {
    api.getCreativeDirectorProjectsByIds.mockResolvedValue([
      { id: 'cd-1', name: 'P1' }, { id: 'cd-2', name: 'P2' },
    ]);
    await renderPage();

    await waitFor(() => expect(api.getCreativeDirectorProjectsByIds).toHaveBeenCalled());
    const [ids] = api.getCreativeDirectorProjectsByIds.mock.calls[0];
    expect([...ids].sort()).toEqual(['cd-1', 'cd-2']);
    expect(api.listCreativeDirectorProjects).not.toHaveBeenCalled();

    await waitFor(() => expect(screen.getAllByTestId('preview-cd-1')).toHaveLength(2));
    expect(screen.getAllByTestId('preview-cd-2')).toHaveLength(1);
  });

  it('skips the request entirely when no run references a project', async () => {
    api.getCommission.mockResolvedValue({
      ...COMMISSION,
      runs: [{ id: 'run-9', projectId: null, status: 'skipped', ranAt: '2026-05-04T10:00:00.000Z' }],
    });
    await renderPage();

    await screen.findByText('no render');
    expect(api.getCreativeDirectorProjectsByIds).not.toHaveBeenCalled();
    expect(api.listCreativeDirectorProjects).not.toHaveBeenCalled();
  });

  it('degrades a run whose project the batch could not resolve to a status-only card', async () => {
    api.getCreativeDirectorProjectsByIds.mockResolvedValue([{ id: 'cd-1', name: 'P1' }]);
    await renderPage();

    await waitFor(() => expect(screen.getAllByTestId('preview-cd-1')).toHaveLength(2));
    // cd-2 was requested but is gone (pruned project) — no preview, and the
    // placeholder must read "unavailable" rather than staying on "loading…".
    expect(screen.queryByTestId('preview-cd-2')).toBeNull();
    expect(screen.getByText('render unavailable')).toBeTruthy();
  });
});

/**
 * Live render refresh (#4149).
 *
 * A commission fire creates the CD project and returns; the render lands minutes
 * later. The page used to sit on the stale "no render yet" card until a reload,
 * and the Run-now toast said as much. It now polls the referenced projects while
 * any `started` run still points at one that hasn't settled — and stops as soon
 * as they all have, so an idle detail page issues no traffic.
 */
describe('CreativeCommissionDetail live render refresh (#4149)', () => {
  // Drain pending promises (and optionally advance the poll clock) inside act.
  const settle = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  const mountLoaded = async () => {
    render(<MemoryRouter><CreativeCommissionDetail /></MemoryRouter>);
    // Commission fetch → id-set effect → project batch fetch: two awaits deep.
    await settle();
    await settle();
  };
  const withRun = (ranAt) => ({
    ...COMMISSION,
    runs: [{ id: 'run-1', projectId: 'cd-1', status: 'started', trigger: 'manual', ranAt }],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    api.getCommission.mockResolvedValue(COMMISSION);
    api.getCreativeDirectorProjectsByIds.mockResolvedValue([]);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('swaps a still-generating run to its finished render without a reload', async () => {
    vi.useFakeTimers();
    api.getCommission.mockResolvedValue(withRun(new Date().toISOString()));
    api.getCreativeDirectorProjectsByIds
      .mockResolvedValueOnce([{ id: 'cd-1', status: 'rendering' }])
      .mockResolvedValue([{ id: 'cd-1', status: 'complete', finalVideoId: 'job-1' }]);

    await mountLoaded();
    expect(screen.getByTestId('preview-cd-1').textContent).toBe('rendering');
    const beforePoll = api.getCreativeDirectorProjectsByIds.mock.calls.length;

    await settle(5000);
    expect(api.getCreativeDirectorProjectsByIds.mock.calls.length).toBeGreaterThan(beforePoll);
    expect(screen.getByTestId('preview-cd-1').textContent).toBe('complete');
  });

  it('stops polling once every referenced project has settled', async () => {
    vi.useFakeTimers();
    api.getCommission.mockResolvedValue(withRun(new Date().toISOString()));
    api.getCreativeDirectorProjectsByIds.mockResolvedValue([
      { id: 'cd-1', status: 'complete', finalVideoId: 'job-1' },
    ]);

    await mountLoaded();
    const settledCalls = api.getCreativeDirectorProjectsByIds.mock.calls.length;

    await settle(30000);
    expect(api.getCreativeDirectorProjectsByIds.mock.calls.length).toBe(settledCalls);
  });

  it('never polls for a started run past the in-flight age ceiling', async () => {
    vi.useFakeTimers();
    // A run whose project stalled mid-render hours ago: polling it forever would
    // burn a request every 5s on any tab left open, and no poll can rescue it.
    const stale = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    api.getCommission.mockResolvedValue(withRun(stale));
    api.getCreativeDirectorProjectsByIds.mockResolvedValue([{ id: 'cd-1', status: 'rendering' }]);

    await mountLoaded();
    const initialCalls = api.getCreativeDirectorProjectsByIds.mock.calls.length;

    await settle(30000);
    expect(api.getCreativeDirectorProjectsByIds.mock.calls.length).toBe(initialCalls);
  });

  it('treats a project the batch resolved as pruned as settled, not in flight', async () => {
    vi.useFakeTimers();
    // The batch answered for this exact id set and omitted cd-1 — the project is
    // gone. Polling can never resurrect it, so the page must not keep asking.
    api.getCommission.mockResolvedValue(withRun(new Date().toISOString()));
    api.getCreativeDirectorProjectsByIds.mockResolvedValue([]);

    await mountLoaded();
    expect(screen.getByText('render unavailable')).toBeTruthy();
    const prunedCalls = api.getCreativeDirectorProjectsByIds.mock.calls.length;

    await settle(30000);
    expect(api.getCreativeDirectorProjectsByIds.mock.calls.length).toBe(prunedCalls);
  });

  it('keeps retrying while the project batch request is failing', async () => {
    vi.useFakeTimers();
    // A FAILED fetch is not an authoritative "pruned" answer — an unresolved id
    // still means "not known yet", so the poll has to stay armed.
    api.getCommission.mockResolvedValue(withRun(new Date().toISOString()));
    api.getCreativeDirectorProjectsByIds.mockRejectedValue(new Error('offline'));

    await mountLoaded();
    const failedCalls = api.getCreativeDirectorProjectsByIds.mock.calls.length;

    await settle(5000);
    expect(api.getCreativeDirectorProjectsByIds.mock.calls.length).toBeGreaterThan(failedCalls);
  });

  it('refetches the render batch for a new run and drops the reload advice', async () => {
    const started = {
      id: 'run-new', projectId: 'cd-new', status: 'started', trigger: 'manual',
      ranAt: new Date().toISOString(),
    };
    api.getCommission.mockResolvedValue({ ...COMMISSION, runs: [] });
    api.runCommissionNow.mockResolvedValue({
      status: 'started', commission: { ...COMMISSION, runs: [started] },
    });
    render(<MemoryRouter><CreativeCommissionDetail /></MemoryRouter>);
    await screen.findByRole('heading', { name: COMMISSION.name });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Run commission .* now/i }));
    });

    await waitFor(() => expect(api.getCreativeDirectorProjectsByIds)
      .toHaveBeenCalledWith(['cd-new'], { silent: true }));
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('appears below'));
    expect(toast.success).toHaveBeenCalledWith(expect.not.stringContaining('reload'));
  });
});
