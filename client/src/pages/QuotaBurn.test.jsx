import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import QuotaBurn, { PENDING_POLL_MS, SAVE_DEBOUNCE_MS } from './QuotaBurn';

vi.mock('../services/api', () => ({
  getQuotaBurn: vi.fn(),
  getQuotaBurnCatalog: vi.fn(),
  // The SHARED scheduled-task catalogs a burn step references. Mocked here (and
  // asserted as never WRITTEN to below) because the whole point of the reference
  // model is that this page reads that catalog and never edits it.
  getCosSchedule: vi.fn(),
  getCosJobs: vi.fn(),
  updateCosTaskInterval: vi.fn(),
  updateCosJob: vi.fn(),
  deleteCosJob: vi.fn(),
  saveQuotaBurn: vi.fn(),
  runQuotaBurn: vi.fn(),
  rearmQuotaBurn: vi.fn(),
}));

const toastError = vi.fn();
vi.mock('../components/ui/Toast', () => {
  // The page calls the default export BOTH as a function (neutral messages) and
  // through `.success` / `.error`, so the mock has to be callable too.
  const toast = (...a) => toast.message(...a);
  toast.message = vi.fn();
  toast.success = vi.fn();
  toast.error = (...a) => toastError(...a);
  return { default: toast };
});

import * as api from '../services/api';
import { MAINTENANCE_TASK_ORDER } from '../lib/quotaBurnTasks';

const NO_OVERRIDES = { providerId: null, model: null, effort: null, params: {} };

// One burn step, in the shape the GET actually hands the page: a reference plus
// an overrides bag, with the server's compat mirrors alongside — the editor must
// send the bag and DROP the mirrors, which resolve by presence.
const step = (overrides = {}) => ({
  id: 'j1',
  enabled: true,
  label: 'Bible images',
  taskRef: { kind: 'builtin', taskType: 'universe-bible-images', appId: null },
  jobType: null,
  runOnce: false,
  unavailable: null,
  overrides: { ...NO_OVERRIDES },
  model: null,
  providerId: null,
  effort: null,
  params: {},
  ...overrides,
});

const config = {
  enabled: false,
  checkIntervalMinutes: 30,
  families: {
    grok: {
      enabled: true, resetWithinHours: 24, reservePercent: 10,
      maxDispatchesPerWindow: 5, priority: 0,
      jobs: [step()],
    },
    codex: { enabled: false, resetWithinHours: 24, reservePercent: 0, maxDispatchesPerWindow: 5, priority: 0, jobs: [] },
  },
};

const status = {
  enabled: false, checkIntervalMinutes: 30, running: false, lastRunAt: null,
  families: [
    { id: 'grok', label: 'Grok', willBurn: true, percentRemaining: 62, hoursUntilReset: 2.4, windowLabel: 'Weekly', dispatchesUsed: 1, skipReason: null, blockedUntil: null, blockedReason: null, jobs: [{ id: 'j1', pending: { count: 4, detail: '4 bible entries have no image' } }] },
    { id: 'codex', label: 'Codex', willBurn: false, skipReason: 'disabled', jobs: [] },
  ],
  runs: [{ at: new Date().toISOString(), trigger: 'scheduled', dispatched: false, reason: 'no burnable window' }],
};

// `GET /api/cos/schedule`, trimmed to the fields the picker reads. `ux` acts on
// one managed app, `universe-bible-images` is programmatic, `repo-sync` sweeps
// install-wide — the three target shapes the server's schema distinguishes.
const schedule = {
  tasks: {
    ux: {
      enabled: true,
      description: 'Audit the interface and file issues.',
      appOverrides: { a1: { enabled: true }, a2: { enabled: false } },
      providerId: null,
      model: null,
      taskMetadata: { useWorktree: false, openPR: false },
      fileIssuesCapable: true,
      defaultFileIssues: true,
    },
    'universe-bible-images': {
      enabled: true, programmatic: true, appOverrides: {}, taskMetadata: { scope: 'all', maxEntries: 10 },
    },
    'repo-sync': { enabled: true, installWide: true, appOverrides: {} },
    'shell-only': { enabled: true, appOverrides: {}, invocation: { userInvokable: false } },
  },
};

const cosJobs = { jobs: [{ id: 'job-a', name: 'Nightly changelog', appId: 'a1', enabled: true, type: 'agent' }] };

// What the burn's own catalog endpoint still supplies: target apps and the
// providers a per-invocation pin may name.
const catalog = {
  apps: [{ id: 'a1', name: 'App One' }, { id: 'a2', name: 'App Two' }],
  providers: [],
};

const renderPage = (path = '/devtools/quota-burn') => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/devtools/quota-burn" element={<QuotaBurn />} />
      <Route path="/devtools/quota-burn/:familyId" element={<QuotaBurn />} />
    </Routes>
  </MemoryRouter>,
);

const setupSaveUser = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
const flushSave = () => act(async () => { await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS); });

// Past the debounce/poll window rather than up to its edge, so a "did not
// happen" assertion runs AFTER the moment the thing would have happened.
const pastSaveWindow = () => act(async () => { await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 100); });
const pastPollWindow = () => act(async () => { await vi.advanceTimersByTimeAsync(PENDING_POLL_MS + 100); });

// Mirrors UNSAVED_PATCH_KEY in the page — the session-scoped stash holding a
// patch the server never accepted.
const STASH_KEY = 'quotaBurn:unsavedPatch';

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.sessionStorage.clear();
  api.getQuotaBurn.mockResolvedValue({ config, status });
  api.getQuotaBurnCatalog.mockResolvedValue(catalog);
  api.getCosSchedule.mockResolvedValue(schedule);
  api.getCosJobs.mockResolvedValue(cosJobs);
  api.saveQuotaBurn.mockResolvedValue({ config });
  api.runQuotaBurn.mockResolvedValue({ result: { dispatched: false, reason: 'nothing to burn' } });
  api.rearmQuotaBurn.mockResolvedValue({ config, status });
});

afterEach(() => vi.useRealTimers());

describe('QuotaBurn page', () => {
  it('shows each family\'s live window or the reason it will not burn', async () => {
    renderPage();
    expect(await screen.findByText(/62% left/)).toBeInTheDocument();
    // A family that will not burn states WHY — the same predicate the runner
    // evaluates, so the page can never disagree with what actually happens.
    expect(screen.getByText('disabled')).toBeInTheDocument();
  });

  it('renders immediately while a family\'s quota is still being read, then polls it in', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const pendingStatus = {
        ...status,
        families: [{ ...status.families[0], willBurn: false, percentRemaining: null, skipReason: 'reading provider quota…', pending: true }, status.families[1]],
      };
      api.getQuotaBurn.mockResolvedValueOnce({ config, status: pendingStatus });
      renderPage();

      expect(await screen.findByText(/reading quota…/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Run the quota-burn loop automatically/)).toBeInTheDocument();

      await pastPollWindow();

      expect(await screen.findByText(/62% left/)).toBeInTheDocument();
      expect(screen.queryByText(/reading quota…/)).not.toBeInTheDocument();
      // Positive control for 'does NOT poll when nothing is pending': the poll
      // DOES fire inside this window, so that test's silence means the guard
      // held rather than that the window was too short to observe anything.
      expect(api.getQuotaBurn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('names WHICH window the reading describes', async () => {
    // A family publishes a short rolling window and a weekly one. "62% left ·
    // resets in 2.4h" is unreadable without knowing which allowance it is —
    // the ambiguity that hid the wrong window being selected server-side.
    renderPage();
    expect(await screen.findByText(/Weekly: 62% left/)).toBeInTheDocument();
  });

  it('drops the denominator when the dispatch cap is unlimited', async () => {
    // -1 is the default: the window is still CHARGED (so "1 used" stays useful)
    // but nothing is counting down to a limit, and "1/-1 used" would read as a
    // bug in the ledger.
    api.getQuotaBurn.mockResolvedValue({
      config: { ...config, families: { ...config.families, grok: { ...config.families.grok, maxDispatchesPerWindow: -1 } } },
      status,
    });
    renderPage();
    expect(await screen.findByText(/· 1 used/)).toBeInTheDocument();
    expect(screen.queryByText(/1\/-1 used/)).not.toBeInTheDocument();
  });

  it('sends the unlimited sentinel rather than a 0 the server would reject', async () => {
    // Stepping the cap below 1 is "fewer restrictions", and 0 is not a value the
    // PUT accepts — collapsing it to -1 keeps the spinner from 400ing the save.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = setupSaveUser();
    renderPage('/devtools/quota-burn/grok');
    const cap = await screen.findByLabelText(/Dispatch cap per window/);
    await user.clear(cap);
    await user.type(cap, '0');
    await flushSave();
    expect(api.saveQuotaBurn).toHaveBeenCalled();
    expect(api.saveQuotaBurn.mock.calls[0][0].families.grok.maxDispatchesPerWindow).toBe(-1);
  });

  it('shows an observed provider refusal, not just the gate that closed', async () => {
    // "The provider said no" is the actionable fact, and it is what explains a
    // family that looks healthy on paper but never burns.
    const blocked = {
      ...status,
      families: [
        { ...status.families[0], willBurn: false, skipReason: 'provider refused the last burn', blockedUntil: '2026-07-26T18:00:00.000Z', blockedReason: 'Usage limit exceeded' },
        status.families[1],
      ],
    };
    api.getQuotaBurn.mockResolvedValueOnce({ config, status: blocked });
    renderPage();
    expect(await screen.findByText(/provider refused — retrying after/)).toBeInTheDocument();
    expect(screen.getByText('Usage limit exceeded')).toBeInTheDocument();
  });

  it('does NOT poll when nothing is pending', async () => {
    // Past a full poll interval, not the 100ms of wall clock this used to
    // wait: a re-arming timer first fires at PENDING_POLL_MS, so a shorter
    // window passed whether or not `enabled: anyPending` was there at all.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPage();
    await screen.findByText(/62% left/);
    // One load on mount, and no timer re-arming behind it.
    await pastPollWindow();
    expect(api.getQuotaBurn).toHaveBeenCalledTimes(1);
  });

  it('saves the master switch as a partial patch', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = setupSaveUser();
    renderPage();
    await user.click(await screen.findByLabelText(/Run the quota-burn loop automatically/));
    await flushSave();
    expect(api.saveQuotaBurn).toHaveBeenCalledWith({ enabled: true }, { silent: true });
  });

  it('drives the expanded family from the URL, not local state', async () => {
    // Deep-linking rule: which plan is open must survive a reload and be shareable.
    renderPage('/devtools/quota-burn/grok');
    expect(await screen.findByLabelText(/Reserve \(%\)/)).toHaveValue(10);
    expect(screen.getByDisplayValue('Bible images')).toBeInTheDocument();
    expect(screen.getByText(/Ready — 4 bible entries have no image/)).toBeInTheDocument();
  });

  it('keeps step actions touch-sized and separates delete from run', async () => {
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');

    const actions = await Promise.all([
      screen.findByLabelText('Move step 1 earlier'),
      screen.findByLabelText('Move step 1 later'),
      screen.findByLabelText('Run step 1 now'),
      screen.findByLabelText('Remove step 1'),
    ]);
    actions.forEach((action) => {
      expect(action).toHaveClass('min-h-[44px]', 'min-w-[44px]');
    });

    expect(screen.getByLabelText('Remove step 1').parentElement).toHaveClass(
      'ml-2', 'border-l', 'border-port-border/50', 'pl-2',
    );

    await user.click(screen.getByLabelText('Run step 1 now'));
    const runConfirm = screen.getByRole('group', { name: 'Confirm running step 1 now' });
    Array.from(runConfirm.querySelectorAll('button')).forEach((action) => {
      expect(action).toHaveClass('min-h-[44px]', 'min-w-[44px]');
    });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByLabelText('Remove step 1'));
    const removeConfirm = screen.getByRole('group', { name: 'Confirm removing step 1' });
    Array.from(removeConfirm.querySelectorAll('button')).forEach((action) => {
      expect(action).toHaveClass('min-h-[44px]', 'min-w-[44px]');
    });
  });

  it('force-runs a single job from its row only after the arm click is confirmed', async () => {
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    // First click only arms — a stray click on this icon must not spend quota.
    await user.click(await screen.findByLabelText('Run step 1 now'));
    expect(api.runQuotaBurn).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'Run' }));
    await waitFor(() => expect(api.runQuotaBurn).toHaveBeenCalledWith(
      { familyId: 'grok', jobId: 'j1', force: true }, { silent: true },
    ));
  });

  it('keeps the family Burn now action available after its automatic window closes', async () => {
    const user = userEvent.setup();
    const gatedStatus = {
      ...status,
      families: [{ ...status.families[0], willBurn: false, skipReason: 'dispatch cap reached (5/5)' }, status.families[1]],
    };
    api.getQuotaBurn.mockResolvedValue({ config, status: gatedStatus });
    renderPage('/devtools/quota-burn/grok');

    const burnButton = await screen.findByTitle('Force-run this family\'s next available job now');
    expect(burnButton).toBeEnabled();
    await user.click(burnButton);
    await waitFor(() => expect(api.runQuotaBurn).toHaveBeenCalledWith(
      { familyId: 'grok', force: true }, { silent: true },
    ));
  });

  it('offers the SHARED scheduled-task catalog, grouped, and filters it as you type', async () => {
    // The picker is a view over the same two catalogs CoS → Schedule and System
    // Tasks render — not a second automation catalog of this page's own.
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    const picker = await screen.findByLabelText('Add a step');
    const groups = Array.from(picker.querySelectorAll('optgroup')).map((group) => group.label);
    expect(groups).toEqual(['PortOS scheduled tasks', 'App custom tasks']);
    expect(Array.from(picker.querySelectorAll('option')).map((option) => option.value))
      // `shell-only` is not user-invokable, so a burn can never run it.
      .toEqual(['', 'builtin:repo-sync', 'builtin:universe-bible-images', 'builtin:ux', 'custom:job-a']);

    await user.type(screen.getAllByLabelText('Search tasks')[0], 'changelog');
    expect(Array.from(picker.querySelectorAll('option')).map((option) => option.value))
      .toEqual(['', 'custom:job-a']);
  });

  it('adds a step that REFERENCES the picked task, targeting the app the plan already uses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = setupSaveUser();
    renderPage('/devtools/quota-burn/grok');
    await user.selectOptions(await screen.findByLabelText('Add a step'), 'builtin:ux');
    await flushSave();
    const [patch] = api.saveQuotaBurn.mock.calls.at(-1);
    const added = patch.families.grok.jobs.at(-1);
    // A reference, not a copied prompt — and no free-text work of its own.
    expect(added.taskRef).toEqual({ kind: 'builtin', taskType: 'ux', appId: 'a1' });
    expect(added).not.toHaveProperty('jobType');
    expect(added.overrides).toEqual(NO_OVERRIDES);
  });

  it('never sends an appId for a task the server would reject one on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = setupSaveUser();
    renderPage('/devtools/quota-burn/grok');
    await user.selectOptions(await screen.findByLabelText('Add a step'), 'builtin:repo-sync');
    // …and it says so on the row instead of leaving an empty target picker.
    // Asserted before the save round-trips: the mocked PUT answers with the
    // pre-existing plan, which is what the page then adopts.
    expect(await screen.findByText(/Runs install-wide/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Target app')).not.toBeInTheDocument();
    await flushSave();
    const [patch] = api.saveQuotaBurn.mock.calls.at(-1);
    expect(patch.families.grok.jobs.at(-1).taskRef).toEqual({ kind: 'builtin', taskType: 'repo-sync', appId: null });
  });

  it('offers a target only for a task that acts on one app, limited to the apps that enabled it', async () => {
    const user = userEvent.setup();
    const uxConfig = {
      ...config,
      families: { ...config.families, grok: { ...config.families.grok, jobs: [step({ taskRef: { kind: 'builtin', taskType: 'ux', appId: 'a1' } })] } },
    };
    api.getQuotaBurn.mockResolvedValue({ config: uxConfig, status });
    renderPage('/devtools/quota-burn/grok');
    await user.click(await screen.findByLabelText('Expand step 1'));
    const target = await screen.findByLabelText('Target app');
    expect(target).toHaveValue('a1');
    // App Two's override is OFF, and the server reports `wrong-scope` for it —
    // offering it would be offering a target the step can never run against.
    expect(Array.from(target.querySelectorAll('option')).map((option) => option.textContent))
      .toEqual(['Select an app…', 'App One']);
  });

  it('shows the EFFECTIVE settings and audit mode, and saves an override without touching the task', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = setupSaveUser();
    const uxConfig = {
      ...config,
      families: { ...config.families, grok: { ...config.families.grok, jobs: [step({ taskRef: { kind: 'builtin', taskType: 'ux', appId: 'a1' } })] } },
    };
    api.getQuotaBurn.mockResolvedValue({ config: uxConfig, status });
    renderPage('/devtools/quota-burn/grok');
    await user.click(await screen.findByLabelText('Expand step 1'));

    // Inherited from the task's saved settings: `defaultFileIssues: true`.
    expect(await screen.findByText(/files issues, changes no code/)).toBeInTheDocument();
    const mode = screen.getByLabelText('Audit mode');
    expect(mode).toHaveValue('');
    expect(mode.querySelector('option').textContent).toContain('Inherit (file issues only)');

    await user.selectOptions(mode, 'false');
    // The effective line follows the override immediately, before the save lands.
    expect(await screen.findByText(/does the work/)).toBeInTheDocument();
    await flushSave();
    const [patch] = api.saveQuotaBurn.mock.calls.at(-1);
    expect(patch.families.grok.jobs[0].overrides.params).toEqual({ fileIssues: false });
    // The referenced task is never written to — that is the whole reference model.
    expect(api.updateCosTaskInterval).not.toHaveBeenCalled();
    expect(api.updateCosJob).not.toHaveBeenCalled();
  });

  it('links out to view / edit / create the source scheduled task instead of editing it here', async () => {
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    // Creating new work is a link out, on the family card, next to the picker.
    expect(await screen.findByRole('link', { name: /Create an on-demand scheduled task/ }))
      .toHaveAttribute('href', '/cos/jobs');
    await user.click(screen.getByLabelText('Expand step 1'));
    expect(screen.getByRole('link', { name: /View \/ edit the task/ }))
      .toHaveAttribute('href', '/cos/schedule?task=universe-bible-images');
  });

  it('renders a stale reference with its reason and NO run affordance', async () => {
    // The server stamps availability from the live catalog on every read: a step
    // whose task was deleted keeps its place in the plan and says why it cannot
    // run — offering a ▶ that can only produce a decline toast is worse.
    const stale = {
      ...config,
      families: {
        ...config.families,
        grok: {
          ...config.families.grok,
          jobs: [step({
            taskRef: { kind: 'builtin', taskType: 'deleted-task', appId: null },
            unavailable: { code: 'unknown-task', reason: 'scheduled task "deleted-task" is not available on this install' },
          })],
        },
      },
    };
    api.getQuotaBurn.mockResolvedValue({ config: stale, status });
    renderPage('/devtools/quota-burn/grok');
    expect(await screen.findByText(/scheduled task "deleted-task" is not available on this install/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Run step 1 now')).not.toBeInTheDocument();
    // It is still editable — the picker is right there to re-point it.
    expect(screen.getByLabelText('Remove step 1')).toBeInTheDocument();
  });

  it('gates Run Now on the SAVED plan, not the form input', async () => {
    // Every run control reads server-side config, so a run fired between the
    // keystroke and the PUT would burn with the previous settings.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = setupSaveUser();
    renderPage('/devtools/quota-burn/grok');
    await user.click(await screen.findByLabelText('Name for step 1'));
    await user.keyboard('!');
    expect(screen.getByLabelText('Run step 1 now')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Evaluate now' })).toBeDisabled();
    await flushSave();
    await waitFor(() => expect(screen.getByLabelText('Run step 1 now')).toBeEnabled());
  });

  it('removes a burn step without deleting the scheduled task it referenced', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = setupSaveUser();
    renderPage('/devtools/quota-burn/grok');
    await user.click(await screen.findByLabelText('Remove step 1'));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await flushSave();
    // The ONLY call is the plan PUT with the step gone.
    const [patch] = api.saveQuotaBurn.mock.calls.at(-1);
    expect(patch.families.grok.jobs).toEqual([]);
    expect(api.deleteCosJob).not.toHaveBeenCalled();
    expect(api.updateCosJob).not.toHaveBeenCalled();
    expect(api.updateCosTaskInterval).not.toHaveBeenCalled();
  });

  it('never persists a status field, or an override mirror, alongside the step', async () => {
    // Pending counts live on the STATUS side and reach JobRow as their own prop.
    // The top-level `model`/`params` mirrors are the subtler one: the server
    // resolves them by PRESENCE, so echoing them back would let a stale mirror
    // outrank the overrides bag the editor writes.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = setupSaveUser();
    renderPage('/devtools/quota-burn/grok');
    await user.click(await screen.findByLabelText('Name for step 1'));
    await user.keyboard('!');
    await flushSave();
    expect(api.saveQuotaBurn).toHaveBeenCalled();
    const [patch] = api.saveQuotaBurn.mock.calls.at(-1);
    const saved = patch.families.grok.jobs[0];
    for (const key of ['pending', 'ranAt', 'model', 'providerId', 'effort', 'params']) {
      expect(saved).not.toHaveProperty(key);
    }
  });
});

/**
 * `run once` — a plan is a rotation the runner walks lap after lap, which is
 * wrong for work that only needs doing once.
 */
describe('QuotaBurn run-once steps', () => {
  const ranAt = new Date(Date.now() - 3_600_000).toISOString();
  // A spent step: `runOnce` on the config side, `ranAt` on the status side.
  const spent = {
    config: {
      ...config,
      families: { ...config.families, grok: { ...config.families.grok, jobs: [{ ...config.families.grok.jobs[0], runOnce: true }] } },
    },
    status: {
      ...status,
      families: [{ ...status.families[0], jobs: [{ id: 'j1', ranAt, pending: null }] }, status.families[1]],
    },
  };

  it('saves the run-once choice as part of the job', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = setupSaveUser();
    renderPage('/devtools/quota-burn/grok');
    await user.click(await screen.findByLabelText('Expand step 1'));
    await user.click(await screen.findByLabelText('Run once'));
    await flushSave();
    expect(api.saveQuotaBurn).toHaveBeenCalled();
    expect(api.saveQuotaBurn.mock.calls.at(-1)[0].families.grok.jobs[0].runOnce).toBe(true);
  });

  it('reports a spent step as ran rather than idle', async () => {
    // The server stops probing a spent step, so without this the row's only
    // self-description would be the absence of a pending line.
    api.getQuotaBurn.mockResolvedValue(spent);
    renderPage('/devtools/quota-burn/grok');
    expect(await screen.findByText(/Ran once/)).toBeInTheDocument();
    expect(screen.getByText(/1 ran once/)).toBeInTheDocument();
  });

  it('re-arms one step without dispatching anything', async () => {
    api.getQuotaBurn.mockResolvedValue(spent);
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    await user.click(await screen.findByRole('button', { name: /Re-arm$/ }));
    await waitFor(() => expect(api.rearmQuotaBurn).toHaveBeenCalledWith('grok', 'j1', { silent: true }));
    // Re-arming makes a step ELIGIBLE; the next cycle's gates still decide.
    expect(api.runQuotaBurn).not.toHaveBeenCalled();
  });

  it('re-arms a whole one-shot series in one click', async () => {
    // The case this exists for: a plan configured as a series the user wants to
    // run again as a series.
    api.getQuotaBurn.mockResolvedValue(spent);
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    await user.click(await screen.findByRole('button', { name: /Re-arm all/ }));
    await waitFor(() => expect(api.rearmQuotaBurn).toHaveBeenCalledWith('grok', null, { silent: true }));
  });

  it('offers no re-arm control while nothing has run', async () => {
    renderPage('/devtools/quota-burn/grok');
    await screen.findByText(/Ready — 4 bible entries/);
    expect(screen.queryByRole('button', { name: /Re-arm/ })).not.toBeInTheDocument();
  });
});

/**
 * The catalog reads fail independently of the plan: the plan renders perfectly
 * while every choice the pickers offer is empty. Swallowing that left the task
 * picker with nothing in it and nothing on screen saying why — and a step saved
 * against an empty catalog references nothing, which the strict PUT rejects.
 */
describe('QuotaBurn catalog failure', () => {
  it('names a failed catalog read instead of silently emptying the form', async () => {
    api.getCosSchedule.mockRejectedValueOnce(new Error('Schedule request failed'));
    api.getCosJobs.mockRejectedValueOnce(new Error('Jobs request failed'));
    renderPage('/devtools/quota-burn/grok');

    expect(await screen.findByText('Job choices could not be loaded')).toBeInTheDocument();
    expect(screen.getByText(/Schedule request failed/)).toBeInTheDocument();
    // The picker is inert rather than silently empty.
    expect(screen.getByLabelText('Add a step')).toBeDisabled();
    // The plan itself still rendered: a catalog failure is not a page failure.
    expect(screen.getByText(/62% left/)).toBeInTheDocument();
  });

  it('re-fetches the catalog from the banner without a page reload', async () => {
    const user = userEvent.setup();
    api.getCosSchedule.mockRejectedValueOnce(new Error('Schedule request failed'));
    renderPage('/devtools/quota-burn/grok');

    await user.click(await screen.findByRole('button', { name: 'Retry catalog load' }));
    await waitFor(() => expect(api.getCosSchedule).toHaveBeenCalledTimes(2));
    // The success clears the banner AND restores the controls it was standing in for.
    await waitFor(() => expect(screen.queryByText('Job choices could not be loaded')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Add a step')).toBeEnabled();
  });

  it('treats a catalog with no burn-invokable task as its own failure', async () => {
    // Same symptom as a thrown read — an empty picker — but a different cause,
    // so it must not be reported as a successful load. Every task here is
    // ineligible or a shell job.
    api.getCosSchedule.mockResolvedValueOnce({ tasks: { hidden: { enabled: true, invocation: { userInvokable: false } } } });
    api.getCosJobs.mockResolvedValueOnce({ jobs: [{ id: 'sh', name: 'Sweep', type: 'shell', enabled: true }] });
    renderPage('/devtools/quota-burn/grok');
    expect(await screen.findByText(/The server returned no scheduled tasks a burn can run\./)).toBeInTheDocument();
  });

  it('survives a partial catalog payload whose lists are null', async () => {
    // A spread over the empty default lets an explicit `null` through, and every
    // consumer reads `.length` on these lists — so an older peer or a partial
    // response would take the whole page down with a TypeError instead of
    // reporting an unusable catalog.
    api.getQuotaBurnCatalog.mockResolvedValueOnce({ apps: null, providers: null });
    api.getCosSchedule.mockResolvedValueOnce({ tasks: null });
    api.getCosJobs.mockResolvedValueOnce({ jobs: null });
    renderPage('/devtools/quota-burn/grok');
    expect(await screen.findByText(/The server returned no scheduled tasks a burn can run\./)).toBeInTheDocument();
    expect(screen.getByText(/62% left/)).toBeInTheDocument();
  });

  it('announces the banner to assistive tech rather than only drawing it', async () => {
    // It appears after the card is already on screen — the read resolves late,
    // and a retry can put it back — so nothing announces it without a live region.
    api.getCosSchedule.mockRejectedValueOnce(new Error('Schedule request failed'));
    renderPage('/devtools/quota-burn/grok');
    // Scope to the banner's own text: the first-paint PageSkeleton is also a
    // `status` region, so a bare role query would race it.
    const banner = (await screen.findByText('Job choices could not be loaded')).closest('[role="status"]');
    expect(banner).toHaveAttribute('aria-live', 'polite');
    expect(banner).toHaveTextContent('Job choices could not be loaded');
  });

  it('says nothing about the catalog when it loaded', async () => {
    renderPage('/devtools/quota-burn/grok');
    await screen.findByLabelText('Add a step');
    expect(screen.queryByText('Job choices could not be loaded')).not.toBeInTheDocument();
  });
});

describe('QuotaBurn save debounce', () => {
  it('folds a burst of edits into ONE PUT and blocks runs until it lands', async () => {
    // Per-keystroke saving also re-read the status, and a universe-bible-images
    // pending probe walks every bible — one full scan per character typed.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = setupSaveUser();
    renderPage('/devtools/quota-burn/grok');
    const nameInput = await screen.findByLabelText('Name for step 1');
    await user.click(nameInput);
    await user.keyboard('abc');

    // Mid-burst: nothing persisted yet, and every run control is disabled
    // because the server still holds the pre-edit plan.
    expect(api.saveQuotaBurn).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Evaluate now/ })).toBeDisabled();
    expect(screen.getByLabelText('Run step 1 now')).toBeDisabled();

    await flushSave();
    expect(api.saveQuotaBurn).toHaveBeenCalledTimes(1);
    expect(api.saveQuotaBurn.mock.calls[0][0].families.grok.jobs[0].label).toBe('Bible imagesabc');
    await waitFor(() => expect(screen.getByRole('button', { name: /Evaluate now/ })).not.toBeDisabled());
  });
});

describe('QuotaBurn save races', () => {
  const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

  it('does not let a slow response revert a keystroke typed while it was in flight', async () => {
    // The status read walks every universe bible, so the round-trip is long.
    // Without a sequence guard, `setConfig(result.config)` rewinds the
    // controlled input mid-typing and the character is silently lost.
    const gate = deferred();
    api.saveQuotaBurn.mockReturnValueOnce(gate.promise);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = setupSaveUser();
    renderPage('/devtools/quota-burn/grok');
    const nameInput = await screen.findByLabelText('Name for step 1');
    await user.clear(nameInput);
    await user.type(nameInput, 'AB');
    await flushSave();
    expect(api.saveQuotaBurn).toHaveBeenCalledTimes(1);

    // Type again while the first PUT is still open, then let it land carrying
    // the OLD value the server normalized.
    await user.type(nameInput, 'C');
    gate.resolve({ config });
    await waitFor(() => expect(nameInput).toHaveValue('ABC'));
  });

  it('keeps the run gate closed when a newer edit is still pending', async () => {
    // Clearing `unsaved` unconditionally re-opened "Burn now" against config
    // the server does not have — dispatching a real quota-spending task with
    // the previous model.
    const gate = deferred();
    api.saveQuotaBurn.mockReturnValueOnce(gate.promise);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = setupSaveUser();
    renderPage('/devtools/quota-burn/grok');
    const nameInput = await screen.findByLabelText('Name for step 1');
    await user.type(nameInput, 'X');
    await flushSave();
    expect(api.saveQuotaBurn).toHaveBeenCalledTimes(1);
    await user.type(nameInput, 'Y');
    gate.resolve({ config });

    // Let the resolved save settle, but stay inside the second edit's debounce.
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(screen.getByRole('button', { name: /Evaluate now/ })).toBeDisabled();
  });

  it('retains the patch when the save fails so one bad field cannot eat the rest', async () => {
    // `pendingRef` was cleared before the request, so a 400 discarded every
    // edit coalesced into that body, unrecoverably.
    api.saveQuotaBurn.mockRejectedValueOnce(new Error('400'));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = setupSaveUser();
    renderPage('/devtools/quota-burn/grok');
    await user.type(await screen.findByLabelText('Name for step 1'), 'Z');
    await flushSave();
    expect(api.saveQuotaBurn).toHaveBeenCalledTimes(1);

    // Still unsaved, and the next flush re-sends the retained edit.
    await waitFor(() => expect(screen.getByRole('button', { name: /Evaluate now/ })).toBeDisabled());
    await user.type(screen.getByLabelText('Name for step 1'), '!');
    await flushSave();
    expect(api.saveQuotaBurn).toHaveBeenCalledTimes(2);
    expect(api.saveQuotaBurn.mock.calls[1][0].families.grok.jobs[0].label).toContain('Z!');
  });

  it('stops claiming it is saving once the retry budget is spent', async () => {
    // The header indicator is the page's only persistent statement about
    // persistence (there is no Save button). Leaving it on "Saving changes…"
    // after both attempts failed asserts progress that is not happening.
    api.saveQuotaBurn.mockRejectedValue(new Error('400'));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = setupSaveUser();
    renderPage('/devtools/quota-burn/grok');
    await user.type(await screen.findByLabelText('Name for step 1'), 'Z');
    await flushSave();
    await flushSave();
    expect(api.saveQuotaBurn).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Not saved — edit a field to retry')).toBeInTheDocument();

    // The next edit re-arms the debounce, so the give-up no longer applies.
    api.saveQuotaBurn.mockResolvedValue({ config });
    await user.type(screen.getByLabelText('Name for step 1'), '!');
    expect(screen.getByText('Saving changes…')).toBeInTheDocument();
    await flushSave();
    expect(screen.getByText('Changes save automatically')).toBeInTheDocument();
  });

  it('flushes a pending edit on unmount instead of dropping it', async () => {
    // cancel() alone discards everything typed in the last debounce window —
    // navigating away 200ms after pasting a prompt lost it with no indicator.
    const user = userEvent.setup();
    const { unmount } = renderPage('/devtools/quota-burn/grok');
    await user.type(await screen.findByLabelText('Name for step 1'), 'Q');
    unmount();
    await waitFor(() => expect(api.saveQuotaBurn).toHaveBeenCalledTimes(1));
    expect(api.saveQuotaBurn.mock.calls[0][0].families.grok.jobs[0].label).toContain('Q');
  });

  it('reports a failed unmount flush and stashes the patch for the next visit', async () => {
    // The page is gone, so no header indicator is left to say the save failed:
    // swallowing it turned "Saving changes…" into permanently lost edits.
    api.saveQuotaBurn.mockRejectedValue(new Error('Network request failed'));
    const user = userEvent.setup();
    const { unmount } = renderPage('/devtools/quota-burn/grok');
    await user.type(await screen.findByLabelText('Name for step 1'), 'Q');
    unmount();

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/could not be saved/i)));
    const stashed = JSON.parse(globalThis.sessionStorage.getItem(STASH_KEY));
    expect(stashed.families.grok.jobs[0].label).toContain('Q');
  });

  it('restores a stashed patch on the next visit and re-saves it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    globalThis.sessionStorage.setItem(STASH_KEY, JSON.stringify({ checkIntervalMinutes: 45 }));
    renderPage();

    // Back on screen AND re-armed for a PUT — a restore that only re-rendered
    // the value would leave the server holding the pre-edit plan until the
    // user retyped the field.
    expect(await screen.findByDisplayValue('45')).toBeInTheDocument();
    await flushSave();
    expect(api.saveQuotaBurn).toHaveBeenCalledTimes(1);
    expect(api.saveQuotaBurn.mock.calls[0][0].checkIntervalMinutes).toBe(45);
    expect(globalThis.sessionStorage.getItem(STASH_KEY)).toBeNull();
  });

  it('keeps a stashed patch when the visit could not read a plan', async () => {
    // Replaying the patch onto a page with no config would render a plan with
    // no families; the recovery belongs on the next visit that gets one.
    api.getQuotaBurn.mockRejectedValue(new Error('Network request failed'));
    globalThis.sessionStorage.setItem(STASH_KEY, JSON.stringify({ checkIntervalMinutes: 45 }));
    renderPage();

    expect(await screen.findByText('Quota burn is unavailable')).toBeInTheDocument();
    expect(globalThis.sessionStorage.getItem(STASH_KEY)).not.toBeNull();
    expect(api.saveQuotaBurn).not.toHaveBeenCalled();
  });

  it('ignores a stash that is not a patch object', async () => {
    // A hand-edited or older-build entry must not be replayed — the PUT body is
    // an object, and anything else 400s the save the restore should rescue.
    // Past the save debounce: a replayed stash PUTs at SAVE_DEBOUNCE_MS, so
    // the 100ms of wall clock this used to wait passed with the shape guard
    // deleted. 'restores a stashed patch on the next visit' is the positive
    // control that a well-formed stash DOES save inside this same window.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    globalThis.sessionStorage.setItem(STASH_KEY, '"not-a-patch"');
    renderPage();

    expect(await screen.findByText(/62% left/)).toBeInTheDocument();
    await pastSaveWindow();
    expect(api.saveQuotaBurn).not.toHaveBeenCalled();
  });

  it('ignores an empty stash rather than announcing a restore of nothing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    globalThis.sessionStorage.setItem(STASH_KEY, '{}');
    renderPage();

    expect(await screen.findByText(/62% left/)).toBeInTheDocument();
    await pastSaveWindow();
    expect(api.saveQuotaBurn).not.toHaveBeenCalled();
  });

  it('names why the first load failed and recovers from the Retry button', async () => {
    // A failed first read used to leave a bare "the server did not return a
    // plan" with the header — and its Refresh — unrendered, so the only way
    // out was reloading the browser tab.
    const user = userEvent.setup();
    api.getQuotaBurn.mockRejectedValueOnce(new Error('Network request failed'));
    renderPage();

    expect(await screen.findByText('Quota burn is unavailable')).toBeInTheDocument();
    expect(screen.getByText('Network request failed')).toBeInTheDocument();

    // Retry re-reads, and the success clears both the banner and the error.
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/62% left/)).toBeInTheDocument();
    expect(screen.queryByText('Quota burn is unavailable')).not.toBeInTheDocument();
    expect(screen.queryByText('Network request failed')).not.toBeInTheDocument();
  });

  it('keeps the plan on screen while Refresh quota re-reads, and names a refresh that failed', async () => {
    // The refresh used to run through the same `loading` flag as the first read,
    // so a 10-20s PTY quota scrape replaced every card and control with a
    // full-page spinner — and a scrape that then FAILED put the stale numbers
    // back with nothing saying they were stale.
    const user = userEvent.setup();
    let rejectRefresh;
    api.getQuotaBurn.mockImplementationOnce(() => Promise.resolve({ config, status }));
    api.getQuotaBurn.mockImplementationOnce(() => new Promise((_, reject) => { rejectRefresh = reject; }));
    renderPage();

    expect(await screen.findByText(/62% left/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Refresh quota/ }));

    // Mid-refresh: the button reports it, the page still shows the plan.
    expect(await screen.findByRole('button', { name: /Refreshing…/ })).toBeDisabled();
    expect(screen.getByText(/62% left/)).toBeInTheDocument();
    expect(screen.queryByText(/Loading burn plan/)).not.toBeInTheDocument();

    rejectRefresh(new Error('Quota scrape timed out'));
    // The banner names the cause — and it is the ONLY surface that reports it,
    // so the same failure is never announced twice.
    expect(await screen.findByText(/Quota scrape timed out/)).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
    // The failure does not tear the page down, and the button is usable again.
    expect(screen.getByText(/62% left/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Refresh quota/ })).toBeEnabled();
  });

  it('clears the failed-refresh banner on the next successful read', async () => {
    const user = userEvent.setup();
    api.getQuotaBurn.mockResolvedValueOnce({ config, status });
    api.getQuotaBurn.mockRejectedValueOnce(new Error('Quota scrape timed out'));
    renderPage();

    expect(await screen.findByText(/62% left/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Refresh quota/ }));
    expect(await screen.findByText(/Quota scrape timed out/)).toBeInTheDocument();

    // The banner's own Retry re-reads; the success takes the banner away and
    // leaves the plan exactly where it was.
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/Quota scrape timed out/)).not.toBeInTheDocument());
    expect(screen.getByText(/62% left/)).toBeInTheDocument();
  });

  it('surfaces a background poll that failed, and clears it on the next poll that lands', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const pendingStatus = {
        ...status,
        families: [{ ...status.families[0], pending: true }, status.families[1]],
      };
      api.getQuotaBurn.mockResolvedValueOnce({ config, status: pendingStatus });
      api.getQuotaBurn.mockRejectedValueOnce(new Error('Provider CLI is not responding'));
      renderPage();

      expect(await screen.findByText(/reading quota…/)).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
      expect(await screen.findByText(/Provider CLI is not responding/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Run the quota-burn loop automatically/)).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
      expect(await screen.findByText(/62% left/)).toBeInTheDocument();
      expect(screen.queryByText(/Provider CLI is not responding/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not also toast when the failure is already named by the banner', async () => {
    // With no plan on screen the banner owns the error surface — a toast on top
    // of it would report the same failure twice.
    const user = userEvent.setup();
    api.getQuotaBurn.mockRejectedValueOnce(new Error('Network request failed'));
    api.getQuotaBurn.mockRejectedValueOnce(new Error('Network request failed'));
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.getQuotaBurn).toHaveBeenCalledTimes(2));
    expect(toastError).not.toHaveBeenCalled();
  });

  it('still offers a retry when the server answers without a plan', async () => {
    // No error to name — but the page is just as stuck, so the way out has to
    // be the same one.
    api.getQuotaBurn.mockResolvedValueOnce({ config: null, status: null });
    renderPage();
    expect(await screen.findByText('The server did not return a plan.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('stops blaming the network once the read succeeds with nothing', async () => {
    // Both a thrown read and an empty one are falsy, so an early return keyed
    // on falsiness would leave the first attempt's network error on screen
    // describing what is now a server that simply answered with no plan.
    const user = userEvent.setup();
    api.getQuotaBurn.mockRejectedValueOnce(new Error('Network request failed'));
    api.getQuotaBurn.mockResolvedValueOnce(null);
    renderPage();

    expect(await screen.findByText('Network request failed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('The server did not return a plan.')).toBeInTheDocument();
    expect(screen.queryByText('Network request failed')).not.toBeInTheDocument();
  });

  it('does not commit 0 when a number field is cleared to be retyped', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderPage('/devtools/quota-burn/grok');
      await user.clear(await screen.findByLabelText(/Dispatch cap per window/));
      await act(async () => { await vi.advanceTimersByTimeAsync(700); });
      expect(api.saveQuotaBurn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('QuotaBurn collapsible steps', () => {
  it('renders configured steps collapsed, summarising the task they reference', async () => {
    renderPage('/devtools/quota-burn/grok');
    expect(await screen.findByDisplayValue('Bible images')).toBeInTheDocument();
    // The picker's own <option> carries the same text, so pick the summary span.
    expect(screen.getAllByText('universe-bible-images').find((node) => node.tagName === 'SPAN')).toBeTruthy();
    // Inner fields are collapsed
    expect(screen.queryByLabelText('Scheduled task')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Expand step 1')).toBeInTheDocument();
  });

  it('expands and collapses a single step using its chevron toggle', async () => {
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    await user.click(await screen.findByLabelText('Expand step 1'));

    expect(await screen.findByLabelText('Scheduled task')).toBeInTheDocument();
    expect(screen.getByLabelText('Collapse step 1')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Collapse step 1'));
    expect(screen.queryByLabelText('Scheduled task')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Expand step 1')).toBeInTheDocument();
  });

  it('expands all and collapses all steps via the header control', async () => {
    const twoStepConfig = {
      ...config,
      families: {
        ...config.families,
        grok: {
          ...config.families.grok,
          jobs: [step(), step({ id: 'j2', label: 'UX audit', taskRef: { kind: 'builtin', taskType: 'ux', appId: 'a1' } })],
        },
      },
    };
    api.getQuotaBurn.mockResolvedValue({ config: twoStepConfig, status });
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');

    expect(await screen.findByRole('button', { name: /Expand all/i })).toBeInTheDocument();
    expect(screen.queryByLabelText('Collapse step 1')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Expand all/i }));
    expect(screen.getByLabelText('Collapse step 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Collapse step 2')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Collapse all/i }));
    expect(screen.queryByLabelText('Collapse step 1')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Collapse step 2')).not.toBeInTheDocument();
  });

  it('automatically expands a newly added step for editing', async () => {
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    await user.selectOptions(await screen.findByLabelText('Add a step'), 'builtin:ux');
    expect(await screen.findByLabelText('Collapse step 2')).toBeInTheDocument();
  });
});

describe('QuotaBurn per-invocation overrides', () => {
  const claudeProviders = {
    ...catalog,
    providers: [{
      id: 'claude-code',
      name: 'Claude Code',
      type: 'tui',
      command: 'claude',
      models: [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4' }, { id: 'claude-opus-4', name: 'Claude Opus 4' }],
    }],
  };
  const claudeConfig = (overrides) => ({
    ...config,
    families: {
      ...config.families,
      claude: {
        enabled: true, resetWithinHours: 24, reservePercent: 0, maxDispatchesPerWindow: 5, priority: 0,
        jobs: [step({ id: 'j1', label: 'Audit UI', taskRef: { kind: 'builtin', taskType: 'ux', appId: 'a1' }, overrides })],
      },
    },
  });

  it('pins model and effort into the overrides bag, never the top-level mirrors', async () => {
    api.getQuotaBurn.mockResolvedValue({ config: claudeConfig({ ...NO_OVERRIDES, model: 'claude-sonnet-4', effort: 'high' }), status });
    api.getQuotaBurnCatalog.mockResolvedValue(claudeProviders);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = setupSaveUser();

    renderPage('/devtools/quota-burn/claude');
    await user.click(await screen.findByLabelText('Expand step 1'));

    expect(await screen.findByLabelText('Model')).toHaveValue('claude-sonnet-4');
    const effortSelect = screen.getByLabelText('Thinking effort');
    expect(effortSelect).toHaveValue('high');

    await user.selectOptions(effortSelect, 'medium');
    await flushSave();
    const [patch] = api.saveQuotaBurn.mock.calls.at(-1);
    const saved = patch.families.claude.jobs[0];
    expect(saved.overrides).toMatchObject({ model: 'claude-sonnet-4', effort: 'medium' });
    expect(saved).not.toHaveProperty('effort');
  });

  it('names what an unset override inherits rather than showing an empty box', async () => {
    // Presence, not truthiness: an unset override INHERITS the task's saved
    // setting, and the control has to say which value that is.
    api.getQuotaBurn.mockResolvedValue({ config: claudeConfig(NO_OVERRIDES), status });
    api.getQuotaBurnCatalog.mockResolvedValue({
      ...claudeProviders,
    });
    api.getCosSchedule.mockResolvedValue({
      tasks: { ...schedule.tasks, ux: { ...schedule.tasks.ux, providerId: 'claude-code', model: 'claude-opus-4' } },
    });
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/claude');
    await user.click(await screen.findByLabelText('Expand step 1'));

    const model = await screen.findByLabelText('Model');
    expect(model).toHaveValue('');
    expect(model.querySelector('option').textContent).toBe('Inherit (claude-opus-4)');
    expect(screen.getByText(/claude-code · claude-opus-4/)).toBeInTheDocument();
  });

  it('shows a programmatic task\'s run parameters read-only, with no agent options', async () => {
    // PortOS executes these itself against its own records — there is no agent,
    // so worktree/PR/simplify are meaningless, and the parameters are per-type
    // and live on the task.
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    await user.click(await screen.findByLabelText('Expand step 1'));
    expect(await screen.findByText(/Run parameters come from the scheduled task: scope=all · maxEntries=10/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Open PR')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Audit mode')).not.toBeInTheDocument();
  });

  it('displays the referenced task and its pins in the collapsed summary', async () => {
    api.getQuotaBurn.mockResolvedValue({ config: claudeConfig({ ...NO_OVERRIDES, model: 'claude-sonnet-4', effort: 'high' }), status });
    renderPage('/devtools/quota-burn/claude');
    expect(await screen.findByText(/ux · App One · claude-sonnet-4 · high/)).toBeInTheDocument();
  });
});

it('saves and enables the maintenance sequence before starting, and never runs after a failed save', async () => {
  const tasks = Object.fromEntries([...MAINTENANCE_TASK_ORDER, 'claim-issue'].map(type => [type, {
    enabled: true, perpetual: type === 'claim-issue', appOverrides: { a1: { enabled: true } },
  }]));
  api.getCosSchedule.mockResolvedValue({ tasks });
  const empty = { ...config, families: { ...config.families, grok: { ...config.families.grok, jobs: [] } } };
  api.getQuotaBurn.mockResolvedValue({ config: empty, status });
  renderPage('/devtools/quota-burn/grok');
  const user = userEvent.setup();
  await screen.findByLabelText('Maintenance sequence app');
  await user.selectOptions(screen.getByLabelText('Maintenance sequence app'), 'a1');
  api.saveQuotaBurn.mockRejectedValueOnce(new Error('save unavailable'));
  await user.click(screen.getByRole('button', { name: 'Populate and start sequence' }));
  await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not save sequence: save unavailable'));
  expect(api.runQuotaBurn).not.toHaveBeenCalled();
  api.saveQuotaBurn.mockResolvedValueOnce({ config: empty });
  await user.click(screen.getByRole('button', { name: 'Populate and start sequence' }));
  await waitFor(() => expect(api.runQuotaBurn).toHaveBeenCalledWith({ familyId: 'grok' }, { silent: true }));
  const patch = api.saveQuotaBurn.mock.calls.at(-1)[0];
  expect(patch.enabled).toBe(true);
  expect(patch.families.grok).toMatchObject({ enabled: true, sequence: true });
  expect(patch.families.grok.jobs).toHaveLength(13);
});
