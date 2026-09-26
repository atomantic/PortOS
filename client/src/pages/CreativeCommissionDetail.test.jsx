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
import { MemoryRouter, Route, Routes, Link } from 'react-router';

const socketHandlers = vi.hoisted(() => new Map());
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => { if (!socketHandlers.has(event)) socketHandlers.set(event, new Set()); socketHandlers.get(event).add(fn); },
    off: (event, fn) => socketHandlers.get(event)?.delete(fn),
    emit: vi.fn(),
  },
}));
const fireSocket = async (event, payload) => act(async () => {
  for (const fn of socketHandlers.get(event) || []) fn(payload);
});

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
// Callable: the degraded run-history warning (#7529) is a render-prop toast,
// so the double has to be a function with the named helpers hung off it.
vi.mock('../components/ui/Toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn(),
  }),
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
 * and the Run-now toast said as much. Project invalidations now refresh the
 * referenced batch while idle detail pages issue no recurring traffic.
 */
describe('CreativeCommissionDetail live render refresh (#4149)', () => {
  // Drain pending promises (and advance beyond the former polling interval) inside act.
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

    await settle(30000);
    expect(api.getCreativeDirectorProjectsByIds).toHaveBeenCalledTimes(beforePoll);
    await fireSocket('creative-director:project:changed', { id: 'unrelated' });
    expect(api.getCreativeDirectorProjectsByIds).toHaveBeenCalledTimes(beforePoll);
    const commissionCalls = api.getCommission.mock.calls.length;
    await fireSocket('creative-director:project:changed', { id: 'cd-1' });
    expect(api.getCreativeDirectorProjectsByIds).toHaveBeenCalledTimes(beforePoll + 1);
    expect(api.getCommission).toHaveBeenCalledTimes(commissionCalls);
    expect(screen.getByTestId('preview-cd-1').textContent).toBe('complete');
  });

  it('reconciles a terminal project once per tab re-show', async () => {
    vi.useFakeTimers();
    api.getCommission.mockResolvedValue(withRun(new Date().toISOString()));
    api.getCreativeDirectorProjectsByIds.mockResolvedValue([
      { id: 'cd-1', status: 'complete', finalVideoId: 'job-1' },
    ]);

    await mountLoaded();
    const settledCalls = api.getCreativeDirectorProjectsByIds.mock.calls.length;

    await settle(30000);
    expect(api.getCreativeDirectorProjectsByIds.mock.calls.length).toBe(settledCalls);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    fireEvent(document, new Event('visibilitychange'));
    await fireSocket('creative-director:project:changed', { id: 'cd-1' });
    expect(api.getCreativeDirectorProjectsByIds).toHaveBeenCalledTimes(settledCalls);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => { fireEvent(document, new Event('visibilitychange')); });
    expect(api.getCreativeDirectorProjectsByIds).toHaveBeenCalledTimes(settledCalls + 1);
    await act(async () => { fireEvent(document, new Event('visibilitychange')); });
    expect(api.getCreativeDirectorProjectsByIds).toHaveBeenCalledTimes(settledCalls + 1);
  });

  it('does not poll even when a project remains rendering', async () => {
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

  it('retries a failed project batch on reconnect without recurring reads', async () => {
    vi.useFakeTimers();
    // A FAILED fetch is not an authoritative "pruned" answer — an unresolved id
    // still means "not known yet"; reconnect must retry the read.
    api.getCommission.mockResolvedValue(withRun(new Date().toISOString()));
    api.getCreativeDirectorProjectsByIds.mockRejectedValue(new Error('offline'));

    await mountLoaded();
    const failedCalls = api.getCreativeDirectorProjectsByIds.mock.calls.length;

    await settle(30000);
    expect(api.getCreativeDirectorProjectsByIds).toHaveBeenCalledTimes(failedCalls);
    await fireSocket('connect');
    expect(api.getCreativeDirectorProjectsByIds).toHaveBeenCalledTimes(failedCalls + 1);
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

  // #7529: the started fire whose run-history write was lost. The project is
  // real and running, but nothing was persisted, so the gallery this page
  // derives from persisted run ids stays empty — promising a render 'appears
  // below' is the one thing the page must not do here.
  it('does not promise a gallery render when the run-history write was lost', async () => {
    api.getCommission.mockResolvedValue({ ...COMMISSION, runs: [] });
    api.runCommissionNow.mockResolvedValue({
      status: 'started',
      projectId: 'cd-orphan',
      run: null,
      historyWarning: {
        code: 'run-history-unavailable', outcome: 'started', trigger: 'manual',
        commissionId: 'cc-1', projectId: 'cd-orphan', detail: 'write-failed:ETIMEDOUT',
      },
      commission: { ...COMMISSION, runs: [] },
    });
    render(<MemoryRouter><CreativeCommissionDetail /></MemoryRouter>);
    await screen.findByRole('heading', { name: COMMISSION.name });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Run commission .* now/i }));
    });

    // Only the WIRING is under test here — that the page hands the server's
    // response to toastRunOutcome instead of branching on status itself.
    // runOutcomeToast.test.jsx owns what the warning toast renders.
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringContaining('appears below'));
  });
});

describe('CreativeCommissionDetail stop controls', () => {
  // These assert the id the page sends, so mount it behind its real route rather
  // than the bare-element helper above (which leaves useParams() empty).
  const renderRouted = async () => {
    render(
      <MemoryRouter initialEntries={['/creative-commission/cc-1']}>
        <Routes>
          <Route path="/creative-commission/:id" element={<CreativeCommissionDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: COMMISSION.name });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.getCommission.mockResolvedValue(COMMISSION);
    api.getCreativeDirectorProjectsByIds.mockResolvedValue([]);
    api.updateCommission.mockResolvedValue({ ...COMMISSION, enabled: false });
    api.deleteCommission.mockResolvedValue({ ok: true });
  });

  it('tells the user that pausing also stops generation already in flight', async () => {
    await renderRouted();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Pause commission/i }));
    });

    expect(api.updateCommission).toHaveBeenCalledWith('cc-1', { enabled: false }, { silent: true });
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('still in flight'));
  });

  it('says nothing about in-flight work when RESUMING the schedule', async () => {
    api.getCommission.mockResolvedValue({ ...COMMISSION, enabled: false });
    await renderRouted();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Resume commission/i }));
    });

    expect(toast.success).toHaveBeenCalledWith('Schedule resumed');
  });

  it('reports the stop when the commission is deleted', async () => {
    await renderRouted();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Delete commission/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    });

    expect(api.deleteCommission).toHaveBeenCalledWith('cc-1', { silent: true });
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('still in flight'));
  });
});

it('reconciles commission events and rejects project batches from a prior route', async () => {
  let resolveOld;
  const other = { ...COMMISSION, id: 'cc-other', name: 'Other commission', runs: [{ id: 'other-run', projectId: 'cd-other', status: 'started' }] };
  api.getCommission.mockImplementation(id => Promise.resolve(id === 'cc-other' ? other : COMMISSION));
  api.getCreativeDirectorProjectsByIds.mockImplementation(ids => ids.includes('cd-other')
    ? Promise.resolve([{ id: 'cd-other', status: 'complete' }])
    : new Promise(resolve => { resolveOld = resolve; }));
  render(<MemoryRouter initialEntries={['/creative-commission/cc-1']}>
    <Link to="/creative-commission/cc-other">Other</Link>
    <Routes><Route path="/creative-commission/:id" element={<CreativeCommissionDetail />} /></Routes>
  </MemoryRouter>);
  await screen.findByRole('heading', { name: COMMISSION.name });
  await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
  await act(async () => screen.getByRole('link', { name: 'Other' }).click());
  await screen.findByTestId('preview-cd-other');
  await act(async () => resolveOld([{ id: 'cd-1', status: 'rendering' }]));
  expect(screen.queryByTestId('preview-cd-1')).not.toBeInTheDocument();
  expect(screen.getByTestId('preview-cd-other')).toHaveTextContent('complete');
  const calls = api.getCommission.mock.calls.length;
  await fireSocket('commission:changed', { id: 'cc-1' });
  expect(api.getCommission).toHaveBeenCalledTimes(calls);
  api.getCommission.mockResolvedValue({ ...other, name: 'Renamed commission' });
  await fireSocket('commission:changed', { id: 'cc-other' });
  expect(screen.getByRole('heading', { name: 'Renamed commission' })).toBeInTheDocument();
});
