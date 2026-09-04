import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

// Regression coverage for #2519 — the page-level Force Evaluate handler must
// only toast success after the request resolves, and must toast the error
// (not a success) when it rejects.
const api = vi.hoisted(() => ({
  getCosStatus: vi.fn(),
  getCosTasks: vi.fn(),
  getCosAgents: vi.fn(),
  getCosHealth: vi.fn(),
  getProviders: vi.fn(),
  getApps: vi.fn(),
  getCosLearningSummary: vi.fn(),
  getCosActionableInsights: vi.fn(),
  getCosBudgetUsage: vi.fn(),
  getPersistentMind: vi.fn(),
  forceCosEvaluate: vi.fn(),
  updateCosTask: vi.fn(),
  pauseCos: vi.fn(),
  resumeCos: vi.fn(),
  forceHealthCheck: vi.fn(),
  updateCosConfig: vi.fn(),
  // HealthTab (rendered by the manual "Run Check" test) + its ProviderStatusCard.
  getCosTodayActivity: vi.fn(),
  getCosLearning: vi.fn(),
  getProviderStatuses: vi.fn(),
  // TasksTab + TaskAddForm, rendered by the task-event tests below.
  getCosLearningDurations: vi.fn(),
  getCosPopularTemplates: vi.fn(),
  getCodeReviewDefaults: vi.fn(),
  getRiggedAvatars: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const socketStub = vi.hoisted(() => ({ connected: false, on: vi.fn(), off: vi.fn(), emit: vi.fn() }));
const localLlm = vi.hoisted(() => ({
  getLocalLlmStatus: vi.fn(),
  getToolUseModels: vi.fn(),
}));

vi.mock('../services/api', () => api);
vi.mock('../services/apiLocalLlm', () => localLlm);
vi.mock('../components/ui/Toast', () => ({ default: toast }));
vi.mock('../services/socket', () => ({ default: socketStub }));
// TaskAddForm drags in the reviewer/model picker plumbing (local-LLM status,
// prompt templates) that the task-event tests below have no stake in.
vi.mock('../components/cos/TaskAddForm', () => ({
  default: ({ onTaskAdded }) => <button type="button" onClick={() => onTaskAdded?.({
    id: 'task-immediate', description: 'Appears without a refresh', status: 'pending', metadata: {},
  }, { position: 'bottom' })}>Add test task</button>,
}));
// ConfigTab's provider/model hook fetches over the network — stub it.
vi.mock('../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [],
    availableModels: [],
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
    selectedProviderId: '',
    selectedModel: '',
  }),
}));
// The rigged avatar stage pulls three.js through a lazy chunk — stub the
// module so this suite asserts the wiring (variant + coverage reach the
// stage), not the 3D render.
vi.mock('../components/cos/MiniCharacterCoSAvatar', () => ({
  default: ({ variant, coverage }) => (
    <div
      data-testid="rigged-avatar"
      data-variant={variant}
      data-covered={(coverage?.coveredStates || []).join(',')}
    />
  ),
}));

const { default: ChiefOfStaff, SPEAKING_MS } = await import('./ChiefOfStaff');

const config = {
  avatarStyle: 'svg',
  healthCheckIntervalMs: 900000,
  maxConcurrentAgents: 3,
  maxConcurrentAgentsPerProject: 2,
  maxProcessMemoryMb: 2048,
  autoStart: false,
  improvementEnabled: true,
  proactiveMode: true,
  idleReviewEnabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosStatus.mockResolvedValue({ running: false, config, stats: {} });
  api.getCosTasks.mockResolvedValue({ user: null, cos: null });
  api.getCosAgents.mockResolvedValue([]);
  api.getCosHealth.mockResolvedValue(null);
  api.getProviders.mockResolvedValue({ providers: [] });
  api.getApps.mockResolvedValue([]);
  api.getCosLearningSummary.mockResolvedValue(null);
  api.getCosActionableInsights.mockResolvedValue({ insights: [] });
  api.forceHealthCheck.mockResolvedValue({ metrics: { timestamp: 1 }, issues: [] });
  api.updateCosTask.mockResolvedValue({ id: 'task-updated', status: 'pending', metadata: {} });
  api.getCosTodayActivity.mockResolvedValue({ isRunning: false, stats: { completed: 0 } });
  api.getCosLearning.mockResolvedValue(null);
  api.getProviderStatuses.mockResolvedValue({ providers: {} });
  api.getCosBudgetUsage.mockResolvedValue({ usage: {} });
  api.getPersistentMind.mockResolvedValue({
    state: { enabled: false, started: false, status: 'disabled', queuedMessageCount: 0 },
    profile: { enabled: false, providerId: null, model: null },
  });
  api.pauseCos.mockResolvedValue({ success: true, pausedAt: '2026-01-01T00:00:00.000Z' });
  api.resumeCos.mockResolvedValue({ success: true });
  api.getCosLearningDurations.mockResolvedValue(null);
  api.getCosPopularTemplates.mockResolvedValue([]);
  api.getCodeReviewDefaults.mockResolvedValue({});
  api.getRiggedAvatars.mockResolvedValue({ records: [] });
  localLlm.getLocalLlmStatus.mockResolvedValue({ ollama: { models: [] }, lmstudio: { models: [] } });
  localLlm.getToolUseModels.mockResolvedValue({ models: [] });
});

// Tests that drain a debounce or the avatar's speaking timer install fake timers
// (see `withFakeTimers` below); this restores real ones for everyone else.
afterEach(() => vi.useRealTimers());

// `shouldAdvanceTime` keeps the clock ticking on its own so testing-library's
// `waitFor`/`findBy*` — which poll on a (now faked) interval and do not know how
// to pump vitest's clock — still resolve, while `advanceTimersByTimeAsync` can
// still jump a timer window instantly instead of sleeping through it.
const withFakeTimers = () => vi.useFakeTimers({ shouldAdvanceTime: true });

const renderPageAt = (tab) => render(
  <MemoryRouter initialEntries={[`/cos/${tab}`]}>
    <Routes>
      <Route path="/cos/:tab" element={<ChiefOfStaff />} />
    </Routes>
  </MemoryRouter>,
);

// #5857 — the page fans out several mocked reads on mount and each resolution
// is its own macrotask, so a bare `findBy*` straight after render polls blind
// through that whole chain. Under a contended worker it ran past testing-
// library's async budget and flaked, while passing in isolation. The page
// already publishes an exact settle signal — the loading branch's busy region
// (asserted by `ChiefOfStaff loading skeleton` below) — so wait for that to
// clear and let the following query spend its budget on one render instead of
// the entire mount. Raising `asyncUtilTimeout` / lowering `maxWorkers` was
// already spent on this file twice (#3474, client/vitest.config.js); the fix
// is to settle, not to buy more budget.
//
// Every test that reaches into a tab's contents mounts through here. Only the
// loading-skeleton guards below call `renderPageAt` bare — they hold a core
// read open precisely so the busy branch is what renders, and settling would
// hang.
const renderSettledAt = async (tab) => {
  const result = renderPageAt(tab);
  await waitFor(() => expect(
    screen.queryByRole('status', { name: 'Loading Chief of Staff' }),
  ).toBeNull());
  return result;
};

const renderSettledConfigTab = () => renderSettledAt('config');

// #4144 — `/cos` is an `isFullWidth` route, so its `<main>` is a bare
// `relative overflow-hidden`. The old centered `h-64` BrailleSpinner reserved
// none of the loaded two-pane shell, and the whole page jumped into place on
// first paint. jsdom does no layout, so the guard pins the structure that
// reserves those dimensions: the busy region IS the two-pane grid.
describe('ChiefOfStaff loading skeleton', () => {
  it('reserves the two-pane shell instead of a centered spinner while loading', async () => {
    // Hold the first fetch open so the loading branch is what renders.
    api.getCosStatus.mockReturnValue(new Promise(() => {}));
    const { container } = renderPageAt('config');

    const busy = await screen.findByRole('status');
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy).toHaveAttribute('aria-label', 'Loading Chief of Staff');
    expect(busy.className).toContain('lg:grid-cols-[320px_1fr]');
    expect(busy.className).toContain('h-full');
    // The old spinner shell — a fixed 16rem box centering its child.
    expect(container.querySelector('.h-64')).toBeNull();
  });

  it('shows the queue before the slow ancillary reads settle', async () => {
    let releaseInsights;
    api.getCosTasks.mockResolvedValue({
      user: { tasks: [{ id: 'task-1', description: 'Example queued task', status: 'pending', metadata: {} }] },
      cos: { tasks: [] },
    });
    api.getCosActionableInsights.mockReturnValue(new Promise((resolve) => { releaseInsights = resolve; }));

    renderPageAt('tasks');

    expect(await screen.findByText('Example queued task')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading Chief of Staff' })).toBeNull();

    await act(async () => {
      releaseInsights({ insights: [] });
    });
  });
});

describe('ChiefOfStaff handleForceEvaluate', () => {
  it('does not toast success or advance the status message when the evaluate fails', async () => {
    api.forceCosEvaluate.mockRejectedValue(new Error('evaluate failed'));
    await renderSettledConfigTab();

    const button = await screen.findByRole('button', { name: /Force Evaluate/i });
    fireEvent.click(button);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('evaluate failed'));
    expect(toast.success).not.toHaveBeenCalled();
    // State contract: a failed evaluate must NOT switch the status bubble to the
    // "Evaluating tasks..." (thinking) message — it stays on the idle message.
    expect(screen.queryAllByText('Evaluating tasks...')).toHaveLength(0);
    expect(screen.queryAllByText('Idle - waiting for tasks...').length).toBeGreaterThan(0);
  });

  it('toasts success and advances the status message after the evaluate resolves', async () => {
    api.forceCosEvaluate.mockResolvedValue({ success: true });
    await renderSettledConfigTab();

    const button = await screen.findByRole('button', { name: /Force Evaluate/i });
    fireEvent.click(button);

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Evaluation triggered'));
    expect(toast.error).not.toHaveBeenCalled();
    // State contract: success advances the status bubble to the evaluating message.
    await waitFor(() => expect(screen.queryAllByText('Evaluating tasks...').length).toBeGreaterThan(0));
    // Must pass { silent: true } so the custom catch is the only error toast.
    expect(api.forceCosEvaluate).toHaveBeenCalledWith({ silent: true });
  });
});

describe('ChiefOfStaff daemon pause controls', () => {
  it('pauses new CoS scheduling through the persistent pause API', async () => {
    api.getCosStatus.mockResolvedValue({ running: true, paused: false, config, stats: {} });
    await renderSettledConfigTab();

    fireEvent.click((await screen.findAllByRole('button', { name: /pause chief of staff scheduling/i }))[0]);

    await waitFor(() => expect(api.pauseCos).toHaveBeenCalledWith(
      'Paused from Chief of Staff controls',
      { silent: true },
    ));
    expect(toast.success).toHaveBeenCalledWith('Chief of Staff paused');
  });

  it('resumes task dispatch only from an explicit Resume action', async () => {
    api.getCosStatus.mockResolvedValue({
      running: true,
      paused: true,
      pauseReason: 'Supervised maintenance',
      config,
      stats: {},
    });
    await renderSettledConfigTab();

    expect((await screen.findAllByText('Paused')).length).toBeGreaterThan(0);

    fireEvent.click((await screen.findAllByRole('button', { name: /resume chief of staff scheduling/i }))[0]);

    await waitFor(() => expect(api.resumeCos).toHaveBeenCalledWith({ silent: true }));
    expect(toast.success).toHaveBeenCalledWith('Chief of Staff resumed');
  });
});

// The Learning stat card's skipped-count label used to sit in a `flex` row
// beside the success-rate value. Flex items default to min-width:auto, so on a
// narrow (mobile) card the label could not shrink below its min-content width
// and rendered outside the card's border (measured: 26px past it at 390px).
//
// jsdom does no layout, so these guards pin the *structure* that keeps it in.
// All three legs are load-bearing — drop any one and the label spills again:
//   1. the label is its own block under the value, not a flex-row sibling;
//   2. the label truncates (its width is unbounded);
//   3. the text column keeps `min-w-0` — truncate implies white-space:nowrap,
//      which makes the label's min-content its FULL width, so a column at
//      min-width:auto still can't shrink below it.
// Plus two value-side branches that are easy to break while "tidying": the
// value must NOT truncate (it would clip "No data"), and must use `!= null`
// (truthiness would render a real 0% as the empty state).
describe('ChiefOfStaff Learning card skipped label', () => {
  const summaryWithSkipped = {
    overallSuccessRate: 84,
    skipped: 3,
    status: 'warning',
    totalCompleted: 20,
  };

  // The page renders more than one Learning card (the compact card in the CoS
  // panel, plus the `mini` card in the ascii-mode stats bar — Tailwind-`hidden`,
  // but jsdom applies no CSS so it is still queryable). Never index into a
  // document-order match list: on the pre-fix markup the compact card read
  // "(3 skipped)", so an exact-text lookup silently drifted to the mini card and
  // asserted against the wrong element. Scope to each card and hold every
  // variant to the contract instead.
  const learningCards = async () => {
    const cards = await screen.findAllByRole('button', { name: /Learning/ });
    expect(cards.length).toBeGreaterThan(0);
    return cards;
  };

  it('stacks the skipped label under the value instead of in a flex row', async () => {
    api.getCosLearningSummary.mockResolvedValue(summaryWithSkipped);
    await renderSettledAt('config');

    for (const card of await learningCards()) {
      const value = within(card).getByText('84%');
      const label = within(card).getByText(/skipped/);
      // The value element holds the rate and nothing else — a parenthetical
      // tucked beside it inside one flex row is what overflowed.
      expect(value.textContent).toBe('84%');
      // Stacked in the card's text column: same parent, which must not lay its
      // children out as a row. Exact token match — the column legitimately
      // carries `flex-1` (a flex-child property, not `display:flex`), which
      // must not trip this guard.
      expect(label.parentElement).toBe(value.parentElement);
      expect(value.parentElement.classList.contains('flex')).toBe(false);
    }
  });

  it('truncates the skipped label so it clips inside the card', async () => {
    api.getCosLearningSummary.mockResolvedValue(summaryWithSkipped);
    await renderSettledAt('config');

    for (const card of await learningCards()) {
      expect(within(card).getByText(/skipped/).classList.contains('truncate')).toBe(true);
    }
  });

  it('keeps the compact card\'s text column shrinkable so the truncate can bite', async () => {
    // Third leg of the containment contract: `truncate` sets white-space:nowrap,
    // which makes the label's min-content its FULL width. In the compact card
    // that column is a flex item of the button's `flex items-center gap-2`, so
    // without `min-w-0` it can't shrink below that min-content and the whole
    // column spills past the border again — the exact reported bug, with the
    // truncate still present and every other assertion here still green.
    api.getCosLearningSummary.mockResolvedValue(summaryWithSkipped);
    await renderSettledAt('config');

    // Scope to the compact cards: the ascii `mini` card's label parent is the
    // <button> itself (not a flex-item column), so this leg doesn't apply there.
    const columns = (await learningCards())
      .map(c => within(c).getByText(/skipped/).parentElement)
      .filter(col => col.classList.contains('flex-1'));
    expect(columns.length).toBeGreaterThan(0);
    for (const col of columns) {
      expect(col.classList.contains('min-w-0')).toBe(true);
    }
  });

  it('renders a legitimate 0% rate as "0%", not the empty state', async () => {
    // `overallSuccessRate != null` (not truthiness) is what keeps a total-failure
    // 0% from disguising itself as "No data" — the highest-signal state reading
    // as the empty one. Pins the branch against a future truthiness collapse.
    api.getCosLearningSummary.mockResolvedValue({ overallSuccessRate: 0, skipped: 0, status: 'critical', totalCompleted: 12 });
    await renderSettledAt('config');

    for (const card of await learningCards()) {
      expect(within(card).getByText('0%')).toBeInTheDocument();
      expect(within(card).queryByText('No data')).not.toBeInTheDocument();
      expect(within(card).queryByText('—')).not.toBeInTheDocument();
    }
  });

  it('leaves the value wrappable so "No data" is not clipped', async () => {
    // `truncate` implies white-space:nowrap. The label needs it (it can be
    // arbitrarily wide); the value must NOT have it — the widest value,
    // "No data", is wider than the compact card's ~45px text column and would
    // render clipped as "No dat…" instead of wrapping.
    api.getCosLearningSummary.mockResolvedValue({ overallSuccessRate: null, skipped: 0, status: 'unknown', totalCompleted: 0 });
    await renderSettledAt('config');

    // Only the compact card spells the empty state "No data" — the ascii `mini`
    // card renders an em dash — so scope to the card that actually shows it.
    const cards = await learningCards();
    const values = cards.map(c => within(c).queryByText('No data')).filter(Boolean);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value.classList.contains('truncate')).toBe(false);
    }
  });

  it('paints a skipped tile as critical even if the server status disagrees', async () => {
    // The tile derives `critical` from `skipped > 0` itself instead of trusting
    // the server's status chain to keep classifying it that way — this fixture
    // is deliberately the mismatched combination (skipped 3 / status 'warning').
    api.getCosLearningSummary.mockResolvedValue(summaryWithSkipped);
    await renderSettledAt('config');

    for (const card of await learningCards()) {
      expect(within(card).getByText(/skipped/).className).toContain('text-port-error');
      expect(card.className).toContain('border-port-error');
    }
  });

  it('omits the skipped label entirely when nothing was skipped', async () => {
    api.getCosLearningSummary.mockResolvedValue({ ...summaryWithSkipped, skipped: 0, status: 'good' });
    await renderSettledAt('config');

    expect(await screen.findAllByText('84%')).not.toHaveLength(0);
    expect(screen.queryByText(/skipped/)).not.toBeInTheDocument();
  });
});

// #2654: the banner is now prop-driven, refreshed only through fetchData. There
// is deliberately no on-demand insights refresh: /cos/actionable-insights runs a
// health check that AUTO-RESTARTS errored processes and re-emits cos:health:check,
// so an on-demand refresh would either loop (from the socket handler) or fire a
// second process-restart (from the manual "Run Check" button). These guards pin
// that neither the socket handler nor the manual button re-fetches insights, plus
// the lastCheck guard that stops a stale fetchData read clobbering fresher health.
describe('ChiefOfStaff insight freshness (#2654)', () => {
  const getSocketHandler = (event) => {
    const entry = socketStub.on.mock.calls.find(([evt]) => evt === event);
    return entry?.[1];
  };

  it('does NOT re-fetch insights on a socket health-check (no feedback loop)', async () => {
    await renderSettledConfigTab();
    // The initial fetchData pulls insights once; wait for it before firing.
    await waitFor(() => expect(api.getCosActionableInsights).toHaveBeenCalled());
    const before = api.getCosActionableInsights.mock.calls.length;

    const handleHealthCheck = getSocketHandler('cos:health:check');
    expect(handleHealthCheck).toBeTypeOf('function');
    // Empty issues avoids the >0 branch's setTimeout(setSpeaking) so no state
    // update escapes act.
    await act(async () => {
      handleHealthCheck({ metrics: { timestamp: 1 }, issues: [] });
    });
    // Give any (buggy) async refresh a tick to fire before asserting it didn't.
    await act(async () => { await Promise.resolve(); });

    // A socket-driven re-fetch here would loop against the health-checking
    // endpoint — the count must stay put; the poll refreshes the banner instead.
    expect(api.getCosActionableInsights.mock.calls.length).toBe(before);
  });

  it('does NOT re-fetch insights on the manual "Run Check" button (no second process-restart)', async () => {
    await renderSettledAt('health');
    await waitFor(() => expect(api.getCosActionableInsights).toHaveBeenCalled());
    const before = api.getCosActionableInsights.mock.calls.length;

    const button = await screen.findByRole('button', { name: /Run Check/i });
    fireEvent.click(button);

    // The button runs its own health check via forceHealthCheck and shows the
    // result — but must NOT also hit the insights endpoint, which would run a
    // second process-restarting health check ~1s later. Banner refreshes on poll.
    await waitFor(() => expect(api.forceHealthCheck).toHaveBeenCalledWith({ silent: true }));
    await act(async () => { await Promise.resolve(); });
    expect(api.getCosActionableInsights.mock.calls.length).toBe(before);
  });

  it('keeps the Health tab pending until its own read settles', async () => {
    let releaseHealth;
    api.getCosHealth.mockReturnValue(new Promise((resolve) => { releaseHealth = resolve; }));
    await renderSettledAt('health');

    expect(await screen.findByText('Loading health...')).toBeInTheDocument();
    expect(screen.queryByText('All Systems Healthy')).not.toBeInTheDocument();

    await act(async () => {
      releaseHealth({ lastCheck: '2026-01-01T00:00:01Z', issues: [] });
    });
    expect(await screen.findByText('All Systems Healthy')).toBeInTheDocument();
  });

  it('does not let a stale fetchData health read clobber a fresher one', async () => {
    // The insights call inside fetchData triggers a fresh server health check
    // whose socket emit can update `health` before fetchData's own getCosHealth
    // read (which sees the pre-check state) resolves. fetchData must keep the
    // newer health by lastCheck instead of overwriting it with the stale read.
    api.getCosHealth.mockResolvedValue({
      lastCheck: '2026-01-01T00:00:02Z',
      issues: [{ type: 'error', category: 'memory', message: 'FRESH_ISSUE' }],
    });
    await renderSettledAt('health');
    // Initial fetchData paints the fresh issue.
    expect(await screen.findByText('FRESH_ISSUE')).toBeInTheDocument();

    // Next fetchData (apps:changed) reads a STALE, older, issue-free health.
    api.getCosHealth.mockResolvedValue({ lastCheck: '2026-01-01T00:00:01Z', issues: [] });
    const handleAppsChanged = getSocketHandler('apps:changed');
    expect(handleAppsChanged).toBeTypeOf('function');
    await act(async () => {
      handleAppsChanged();
      await Promise.resolve();
    });

    // The guard keeps the fresher health — the issue must NOT disappear.
    await waitFor(() => expect(api.getApps.mock.calls.length).toBeGreaterThan(1));
    expect(screen.getByText('FRESH_ISSUE')).toBeInTheDocument();
    expect(screen.queryByText('All Systems Healthy')).not.toBeInTheDocument();
  });

  it('does not let a timestamp-less health read clobber a fresher timestamped one', async () => {
    api.getCosHealth.mockResolvedValue({
      lastCheck: '2026-01-01T00:00:02Z',
      issues: [{ type: 'error', category: 'memory', message: 'FRESH_ISSUE' }],
    });
    await renderSettledAt('health');
    expect(await screen.findByText('FRESH_ISSUE')).toBeInTheDocument();

    // A read with no (parseable) lastCheck must not overwrite the timestamped,
    // fresher health — Date.parse('') is NaN, which must NOT win the guard.
    api.getCosHealth.mockResolvedValue({ issues: [] });
    const handleAppsChanged = getSocketHandler('apps:changed');
    await act(async () => {
      handleAppsChanged();
      await Promise.resolve();
    });

    await waitFor(() => expect(api.getApps.mock.calls.length).toBeGreaterThan(1));
    expect(screen.getByText('FRESH_ISSUE')).toBeInTheDocument();
    expect(screen.queryByText('All Systems Healthy')).not.toBeInTheDocument();
  });

  it('preserves last-good health when a fetchData health read fails (null)', async () => {
    api.getCosHealth.mockResolvedValue({
      lastCheck: '2026-01-01T00:00:02Z',
      issues: [{ type: 'error', category: 'memory', message: 'FRESH_ISSUE' }],
    });
    await renderSettledAt('health');
    expect(await screen.findByText('FRESH_ISSUE')).toBeInTheDocument();

    // A failed health read (rejects → .catch → null) must not blank the banner.
    api.getCosHealth.mockRejectedValue(new Error('boom'));
    const handleAppsChanged = getSocketHandler('apps:changed');
    await act(async () => {
      handleAppsChanged();
      await Promise.resolve();
    });

    await waitFor(() => expect(api.getApps.mock.calls.length).toBeGreaterThan(1));
    expect(screen.getByText('FRESH_ISSUE')).toBeInTheDocument();
    expect(screen.queryByText('All Systems Healthy')).not.toBeInTheDocument();
  });
});

// A scheduled CoS run is an INTERNAL task, and the page used to subscribe only
// to `cos:tasks:user:changed` — so a freshly queued scheduled task didn't appear
// until the 30s poll, and the pending→in_progress flip that ends a task's
// "queued" life was equally invisible. Since the server registers an agent as
// running BEFORE flipping its task off `pending`, the fetch fired by
// `cos:agent:spawned` always reads the task as still-queued, which is what left
// the row showing as pending AND active for up to a poll interval.
describe('ChiefOfStaff task-change subscriptions', () => {
  const getSocketHandler = (event) => socketStub.on.mock.calls.find(([evt]) => evt === event)?.[1];

  const renderSettledTasksTab = () => renderSettledAt('tasks');

  it('renders a newly queued system task straight off the watcher event', async () => {
    await renderSettledTasksTab();
    await waitFor(() => expect(api.getCosTasks).toHaveBeenCalled());
    const before = api.getCosTasks.mock.calls.length;

    const handleCosTasksChanged = getSocketHandler('cos:tasks:cos:changed');
    expect(handleCosTasksChanged).toBeTypeOf('function');
    await act(async () => {
      handleCosTasksChanged({
        exists: true,
        tasks: [{ id: 'cos-task-1', description: 'Example scheduled task', status: 'pending', metadata: {} }],
      });
    });

    expect(await screen.findByText('Example scheduled task')).toBeInTheDocument();
    // The event carries the whole list, so it must not cost a round trip.
    expect(api.getCosTasks.mock.calls.length).toBe(before);
  });

  it('renders a submitted user task before the follow-up refresh resolves', async () => {
    await renderSettledTasksTab();
    await screen.findByRole('button', { name: 'Add test task' });
    api.getCosTasks.mockReturnValue(new Promise(() => {}));

    fireEvent.click(screen.getByRole('button', { name: 'Add test task' }));

    expect(await screen.findByText('Appears without a refresh')).toBeInTheDocument();
  });

  it('coalesces a burst of task-store changes into a single refetch', async () => {
    withFakeTimers();
    await renderSettledTasksTab();
    await waitFor(() => expect(api.getCosTasks).toHaveBeenCalled());
    const before = api.getCosTasks.mock.calls.length;

    const handleTasksChanged = getSocketHandler('cos:tasks:changed');
    expect(handleTasksChanged).toBeTypeOf('function');
    await act(async () => {
      handleTasksChanged({ type: 'internal', action: 'added' });
      handleTasksChanged({ type: 'internal', action: 'updated' });
      handleTasksChanged({ type: 'user', action: 'updated' });
    });

    await waitFor(() => expect(api.getCosTasks.mock.calls.length).toBe(before + 1), { timeout: 2000 });
    // `tasks:changed` also fires for writes with nothing to show here (every
    // running task's federation lease heartbeat), so the burst must settle into
    // one refresh rather than one per event. Any extra flush would land inside
    // the 400ms window the first one already closed.
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(api.getCosTasks.mock.calls.length).toBe(before + 1);
  });

  it('refreshes the queue without re-running the health-checking insights read', async () => {
    await renderSettledTasksTab();
    await waitFor(() => expect(api.getCosActionableInsights).toHaveBeenCalled());
    const insightsBefore = api.getCosActionableInsights.mock.calls.length;

    await act(async () => { getSocketHandler('cos:tasks:changed')({ type: 'internal', action: 'updated' }); });
    await waitFor(() => expect(api.getCosAgents.mock.calls.length).toBeGreaterThan(1), { timeout: 2000 });

    // /cos/actionable-insights runs a health check that AUTO-RESTARTS errored PM2
    // processes. Every task add, status flip, delete and lease heartbeat emits
    // `tasks:changed`, so this handler must never reach that endpoint.
    expect(api.getCosActionableInsights.mock.calls.length).toBe(insightsBefore);
  });
});

describe('ChiefOfStaff task unblock freshness', () => {
  const blockedTask = {
    id: 'sys-blocked-immediate',
    description: 'Blocked task updates immediately',
    status: 'blocked',
    metadata: { blockedReason: 'Waiting for an operator' },
  };

  const blockedInsight = {
    type: 'blocked',
    priority: 'high',
    icon: 'XCircle',
    title: '1 blocked task',
    description: 'Waiting for an operator',
    action: { label: 'Unblock', route: '/cos/tasks' },
    count: 1,
    tasks: [{
      id: blockedTask.id,
      description: blockedTask.description,
      blocker: 'Waiting for an operator',
      taskType: 'internal',
    }],
  };

  const renderBlockedTask = (insights = []) => {
    api.getCosTasks.mockResolvedValue({ user: { tasks: [] }, cos: { tasks: [blockedTask] } });
    api.getCosActionableInsights.mockResolvedValue({ insights });
    return renderSettledAt('tasks');
  };

  it('moves a banner-unblocked task and removes its insight before refresh settles', async () => {
    await renderBlockedTask([blockedInsight]);
    expect(await screen.findByText('1 blocked task')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View Tasks' }));
    const banner = screen.getByText('1 blocked task').closest('.border');
    // Keep the post-mutation reads pending so this assertion only passes when
    // the successful banner action updates both parent-owned surfaces directly.
    api.getCosTasks.mockReturnValue(new Promise(() => {}));
    api.getCosActionableInsights.mockReturnValue(new Promise(() => {}));
    fireEvent.click(within(banner).getByRole('button', { name: 'Unblock' }));

    await waitFor(() => expect(api.updateCosTask).toHaveBeenCalledWith(
      blockedTask.id,
      { status: 'pending', type: 'internal' },
      { silent: true },
    ));
    expect(await screen.findByText('Pending (1)')).toBeInTheDocument();
    expect(screen.queryByText('Blocked (1)')).not.toBeInTheDocument();
    expect(screen.queryByText('1 blocked task')).not.toBeInTheDocument();
  });

  it('moves a card-unblocked task before its follow-up refresh settles', async () => {
    await renderBlockedTask();
    expect(await screen.findByText('Blocked (1)')).toBeInTheDocument();
    // Keep the post-mutation read pending so this assertion only passes when the
    // card uses the shared optimistic update rather than waiting for onRefresh.
    api.getCosTasks.mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: `Unblock task ${blockedTask.id} and move it to pending` }));

    await waitFor(() => expect(api.updateCosTask).toHaveBeenCalledWith(
      blockedTask.id,
      { status: 'pending', type: 'internal' },
      { silent: true },
    ));
    expect(await screen.findByText('Pending (1)')).toBeInTheDocument();
    expect(screen.queryByText('Blocked (1)')).not.toBeInTheDocument();
  });
});

// fetchData reads 8 endpoints, one of which runs a server-side health check, so a
// queue refresh started LATER routinely resolves FIRST. Without a guard, the slow
// batch's pre-flip task payload lands last and restores the pending-AND-active
// render — the exact symptom the queue refresh exists to clear.
describe('ChiefOfStaff stale queue-read guard', () => {
  const getSocketHandler = (event) => socketStub.on.mock.calls.find(([evt]) => evt === event)?.[1];

  it('does not let a slow full fetch overwrite a fresher queue refresh', async () => {
    const stale = { user: { tasks: [{ id: 'task-1', description: 'STALE pending copy', status: 'pending', metadata: {} }] }, cos: { tasks: [] } };
    const fresh = { user: { tasks: [{ id: 'task-1', description: 'FRESH in-progress copy', status: 'in_progress', metadata: {} }] }, cos: { tasks: [] } };

    // Initial paint.
    api.getCosTasks.mockResolvedValue(stale);
    await renderSettledAt('tasks');
    expect(await screen.findByText('STALE pending copy')).toBeInTheDocument();

    // A spawn kicks off the slow full fetch, whose insights read we hold open so
    // the whole batch resolves only after the queue refresh below has landed.
    let releaseInsights;
    api.getCosActionableInsights.mockReturnValue(new Promise((resolve) => { releaseInsights = resolve; }));
    await act(async () => { getSocketHandler('cos:agent:spawned')({ agentId: 'agent-1', metadata: {} }); });

    // The store event's queue refresh resolves first, with the post-flip truth.
    api.getCosTasks.mockResolvedValue(fresh);
    await act(async () => { getSocketHandler('cos:tasks:changed')({ type: 'user', action: 'updated' }); });
    expect(await screen.findByText('FRESH in-progress copy')).toBeInTheDocument();

    // Now the slow batch finally returns — carrying the stale pre-flip snapshot.
    api.getCosTasks.mockResolvedValue(stale);
    await act(async () => {
      releaseInsights({ insights: [] });
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    expect(screen.queryByText('STALE pending copy')).not.toBeInTheDocument();
    expect(screen.getByText('FRESH in-progress copy')).toBeInTheDocument();
  });
});

// A single warning-level health issue parked the avatar on "Investigating
// issue..." with Active 0. Nothing on screen said what was being investigated,
// and the Issues tile was an inert <div> holding the number 1, so the detail was
// reachable only by guessing at the Health tab.
describe('ChiefOfStaff Issues card', () => {
  const memoryWarning = {
    type: 'warning',
    category: 'memory',
    message: 'High memory usage in: example-app (900MB)',
  };

  const renderWithIssues = (issues) => {
    api.getCosStatus.mockResolvedValue({ running: true, config, stats: {} });
    api.getCosHealth.mockResolvedValue({ lastCheck: '2026-01-01T00:00:00.000Z', issues });
    return renderSettledConfigTab();
  };

  // Same "never index a match list" rule as the Learning card above: the page
  // paints the Issues tile in up to four places (desktop sidebar, mobile grid,
  // the compressed header, and the Tailwind-`hidden` ascii `mini` bar, all still
  // in the jsdom tree). Hold every variant to the contract.
  const issueCards = async () => {
    const cards = await screen.findAllByRole('button', { name: /^Issues:/ });
    expect(cards.length).toBeGreaterThan(0);
    return cards;
  };

  it('names the health issue in the status bubble instead of the generic investigating line', async () => {
    await renderWithIssues([memoryWarning]);

    expect(await screen.findByText(memoryWarning.message)).toBeInTheDocument();
    expect(screen.queryByText('Investigating issue...')).not.toBeInTheDocument();
  });

  it('summarizes the count when more than one issue is open', async () => {
    await renderWithIssues([memoryWarning, { type: 'error', category: 'processes', message: 'example-app failed to auto-restart' }]);

    expect(await screen.findByText(/^2 health issues: /)).toBeInTheDocument();
  });

  it('makes every Issues tile a button that carries the issue summary', async () => {
    await renderWithIssues([memoryWarning]);

    for (const card of await issueCards()) {
      expect(card).toHaveAttribute('title', memoryWarning.message);
      expect(within(card).getByText('1')).toBeInTheDocument();
    }
  });

  it('opens the Health tab when the tile is clicked', async () => {
    await renderWithIssues([memoryWarning]);
    const cards = await issueCards();

    // Clicking the first is enough: the assertion above pins every variant to
    // the same props object, and the click swaps the route out from under the
    // rest of the list.
    fireEvent.click(cards[0]);

    const panel = await screen.findByRole('tabpanel');
    expect(panel).toHaveAttribute('id', 'tabpanel-health');
    expect(within(panel).getByText(memoryWarning.message)).toBeInTheDocument();
  });

  // The live path: a health check finishing while the page is open pushes the
  // issue over the socket rather than through fetchData.
  it('names the issue arriving on a live health-check socket event', async () => {
    withFakeTimers();
    await renderWithIssues([]);
    // Wait for the clean first paint so the socket handler is registered.
    for (const card of await issueCards()) expect(within(card).getByText('0')).toBeInTheDocument();

    const handleHealthCheck = socketStub.on.mock.calls.find(([evt]) => evt === 'cos:health:check')?.[1];
    expect(handleHealthCheck).toBeTypeOf('function');
    await act(async () => {
      handleHealthCheck({ metrics: { timestamp: '2026-01-02T00:00:00.000Z' }, issues: [memoryWarning] });
    });

    expect(await screen.findByText(memoryWarning.message)).toBeInTheDocument();
    for (const card of await issueCards()) {
      expect(card).toHaveAttribute('title', memoryWarning.message);
      expect(within(card).getByText('1')).toBeInTheDocument();
    }
    // Drain the >0 branch's speaking timer so no state update escapes act.
    await act(async () => { await vi.advanceTimersByTimeAsync(SPEAKING_MS + 100); });
  });

  // Without these, deleting the `tone` prop would leave every tile neutral gray
  // while the helper's own unit tests stayed green.
  it('colors the tile amber for a warning-only check', async () => {
    await renderWithIssues([memoryWarning]);

    for (const card of await issueCards()) {
      expect(card.className).toContain('border-port-warning');
      expect(card.className).not.toContain('border-port-error');
    }
  });

  it('escalates the tile to red when an issue is error-level', async () => {
    await renderWithIssues([memoryWarning, { type: 'error', category: 'processes', message: 'example-app failed to auto-restart' }]);

    for (const card of await issueCards()) {
      expect(card.className).toContain('border-port-error');
    }
  });

  it('stays a click-through to Health when there are no issues at all', async () => {
    await renderWithIssues([]);

    for (const card of await issueCards()) {
      expect(card).toHaveAttribute('title', 'No issues detected — view system health');
      expect(within(card).getByText('0')).toBeInTheDocument();
      expect(card.className).not.toContain('border-port-warning');
      expect(card.className).not.toContain('border-port-error');
    }
  });

  // fetchData's health read is the SLOW one — it resolves after the socket event
  // for the check that same batch triggered. Everything the page derives from
  // health (tile, avatar state, status bubble) must come from the merged
  // snapshot, or the bubble names an older issue than the tile is counting.
  it('does not let a slow health read clobber a fresher socket-delivered check', async () => {
    withFakeTimers();
    const staleWarning = { type: 'warning', category: 'memory', message: 'Stale issue from the older read' };
    api.getCosStatus.mockResolvedValue({ running: true, config, stats: {} });
    // The slow read carries the OLDER timestamp; the socket event below is newer.
    api.getCosHealth.mockResolvedValue({ lastCheck: '2026-01-01T00:00:00.000Z', issues: [staleWarning] });
    await renderSettledConfigTab();
    expect(await screen.findByText(staleWarning.message)).toBeInTheDocument();

    const handleHealthCheck = socketStub.on.mock.calls.find(([evt]) => evt === 'cos:health:check')?.[1];
    await act(async () => {
      handleHealthCheck({ metrics: { timestamp: '2026-01-02T00:00:00.000Z' }, issues: [memoryWarning] });
    });
    // Drain the >0 branch's speaking timer so no state update escapes act.
    await act(async () => { await vi.advanceTimersByTimeAsync(SPEAKING_MS + 100); });

    // Now force the slow batch to run again with its stale payload — the merge
    // must keep the socket's newer check, for the tile AND the bubble.
    await act(async () => {
      socketStub.on.mock.calls.find(([evt]) => evt === 'apps:changed')?.[1]?.();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(screen.getByText(memoryWarning.message)).toBeInTheDocument();
    expect(screen.queryByText(staleWarning.message)).not.toBeInTheDocument();
    for (const card of await issueCards()) {
      expect(card).toHaveAttribute('title', memoryWarning.message);
    }
  });
});

describe('Rigged avatar style', () => {
  it('renders a rigged record on the mini-character stage with its coverage', async () => {
    api.getCosStatus.mockResolvedValue({
      running: true,
      config: { ...config, avatarStyle: 'rigged-image3d-1' },
      stats: {},
    });
    api.getRiggedAvatars.mockResolvedValue({
      records: [{
        id: 'image3d-1',
        name: 'Example Dancer',
        variant: 'rigged-image3d-1',
        clip: 'Dance',
        coverage: { coveredStates: ['ideating'], missingStates: ['coding'], complete: false },
      }],
    });
    await renderSettledAt('tasks');

    const avatar = await screen.findByTestId('rigged-avatar');
    expect(avatar).toHaveAttribute('data-variant', 'rigged-image3d-1');
    expect(avatar).toHaveAttribute('data-covered', 'ideating');
  });

  it('still renders the stage when the rigged record is gone', async () => {
    api.getCosStatus.mockResolvedValue({
      running: true,
      config: { ...config, avatarStyle: 'rigged-image3d-gone' },
      stats: {},
    });
    api.getRiggedAvatars.mockResolvedValue({ records: [] });
    await renderSettledAt('tasks');

    // No coverage to hand over (null), but the variant URL still probes —
    // a deleted record shows the stage's missing-model hint, not a crash.
    const avatar = await screen.findByTestId('rigged-avatar');
    expect(avatar).toHaveAttribute('data-variant', 'rigged-image3d-gone');
    expect(avatar).toHaveAttribute('data-covered', '');
  });
});
