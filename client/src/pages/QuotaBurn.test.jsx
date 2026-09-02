import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import QuotaBurn, { SAVE_DEBOUNCE_MS } from './QuotaBurn';
import { sleep } from '../utils/sleep';

vi.mock('../services/api', () => ({
  getQuotaBurn: vi.fn(),
  getQuotaBurnCatalog: vi.fn(),
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

const config = {
  enabled: false,
  checkIntervalMinutes: 30,
  families: {
    grok: {
      enabled: true, resetWithinHours: 24, reservePercent: 10,
      maxDispatchesPerWindow: 5, priority: 0,
      jobs: [{ id: 'j1', enabled: true, label: 'Bible images', jobType: 'universe-bible-images', model: null, providerId: null, params: {} }],
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

const catalog = {
  families: ['grok', 'codex'],
  jobTypes: [
    { id: 'universe-bible-images', label: 'Universe bible images', description: 'Render missing bible images.', params: [{ key: 'universeId', kind: 'universe', label: 'Universe', default: 'all' }] },
    {
      id: 'agent-prompt',
      label: 'Agent prompt',
      description: 'Queue a CoS agent.',
      params: [
        { key: 'appId', kind: 'app', label: 'Managed app', required: true },
        { key: 'prompt', kind: 'text', label: 'Work prompt', required: true },
        { key: 'openPR', kind: 'boolean', label: 'Open a PR', default: true },
      ],
    },
  ],
  presets: [{
    id: 'ux-audit',
    label: 'UX issues',
    summary: 'Audit the UI and file issues.',
    jobType: 'agent-prompt',
    // Mirrors the real audit posture in server/lib/quotaBurnPresets.js: no
    // worktree (it writes nothing), no code output, nothing to ship.
    params: { prompt: 'Audit the UI. File issues. Change no code.', useWorktree: false, noCodeOutput: true, openPR: false, simplify: false },
  }],
  apps: [{ id: 'a1', name: 'App One' }],
  universes: [{ id: 'u1', name: 'Example Universe' }],
  imageModes: ['codex', 'grok'],
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

// Mirrors UNSAVED_PATCH_KEY in the page — the session-scoped stash holding a
// patch the server never accepted.
const STASH_KEY = 'quotaBurn:unsavedPatch';

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.sessionStorage.clear();
  api.getQuotaBurn.mockResolvedValue({ config, status });
  api.getQuotaBurnCatalog.mockResolvedValue(catalog);
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

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });

      expect(await screen.findByText(/62% left/)).toBeInTheDocument();
      expect(screen.queryByText(/reading quota…/)).not.toBeInTheDocument();
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
    renderPage();
    await screen.findByText(/62% left/);
    // One load on mount, and no timer re-arming behind it.
    await sleep(100);
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

  it('adds a fully-configured job from a preset, inheriting the plan\'s app', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = setupSaveUser();
    renderPage('/devtools/quota-burn/grok');
    await user.selectOptions(await screen.findByLabelText(/Add a preset job/), 'ux-audit');
    await flushSave();
    expect(api.saveQuotaBurn).toHaveBeenCalled();
    const [patch] = api.saveQuotaBurn.mock.calls.at(-1);
    const added = patch.families.grok.jobs.at(-1);
    expect(added.jobType).toBe('agent-prompt');
    expect(added.label).toBe('UX issues');
    expect(added.params.prompt).toContain('File issues');
    // Read-only audit work: it reads the app's checkout in place (no worktree —
    // worktree + no PR is the auto-merge posture), delivers by filing issues,
    // and has no diff to open a PR for or run /simplify against.
    expect(added.params.useWorktree).toBe(false);
    expect(added.params.noCodeOutput).toBe(true);
    expect(added.params.openPR).toBe(false);
  });

  it('asks before a preset overwrites a work prompt the user already wrote', async () => {
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    await user.click(await screen.findByLabelText('Expand step 1'));
    await user.selectOptions(await screen.findByLabelText('Job type'), 'agent-prompt');
    const promptBox = screen.getByLabelText('Work prompt');
    await user.type(promptBox, 'my own prompt');
    await user.selectOptions(screen.getByLabelText(/Start from a preset/), 'ux-audit');

    // Held, not applied — the typed prompt is still on screen behind a confirm.
    expect(promptBox).toHaveValue('my own prompt');
    await user.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(promptBox).toHaveValue('my own prompt');

    await user.selectOptions(screen.getByLabelText(/Start from a preset/), 'ux-audit');
    await user.click(screen.getByRole('button', { name: 'Replace' }));
    expect(promptBox).toHaveValue('Audit the UI. File issues. Change no code.');
  });

  it('shows which preset a step currently matches, and drops it once the prompt is edited', async () => {
    // The picker used to snap straight back to "Choose a preset…", so applying
    // one looked like a no-op — its only visible effect was a textarea further
    // down the row. The selection is DERIVED from the prompt text (nothing on
    // disk records a preset id), so it stays honest across an edit.
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    await user.click(await screen.findByLabelText('Expand step 1'));
    await user.selectOptions(await screen.findByLabelText('Job type'), 'agent-prompt');
    const picker = screen.getByLabelText(/Start from a preset/);
    expect(picker).toHaveValue('');

    await user.selectOptions(picker, 'ux-audit');
    expect(screen.getByLabelText('Work prompt')).toHaveValue('Audit the UI. File issues. Change no code.');
    expect(picker).toHaveValue('ux-audit');

    // Edited away from the preset ⇒ the row no longer IS that preset, and the
    // control must stop claiming it is.
    await user.type(screen.getByLabelText('Work prompt'), ' plus my own note');
    expect(picker).toHaveValue('');
  });

  it('keeps the work prompt when the job type picker is clicked through', async () => {
    // Params are carried across a type switch: resetting them destroyed a long
    // hand-written prompt with no confirmation and no undo.
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    await user.click(await screen.findByLabelText('Expand step 1'));
    await user.selectOptions(await screen.findByLabelText('Job type'), 'agent-prompt');
    await user.type(screen.getByLabelText('Work prompt'), 'keep me');
    await user.selectOptions(screen.getByLabelText('Job type'), 'universe-bible-images');
    await user.selectOptions(screen.getByLabelText('Job type'), 'agent-prompt');
    expect(screen.getByLabelText('Work prompt')).toHaveValue('keep me');
  });

  it('never persists a status field alongside the job config', async () => {
    // Pending counts live on the STATUS side and reach JobRow as their own prop.
    // If they were merged into the job objects they would have to be stripped
    // back off before every save — the PUT schema is strict and would 400.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = setupSaveUser();
    renderPage('/devtools/quota-burn/grok');
    await user.click(await screen.findByLabelText('Name for step 1'));
    await user.keyboard('!');
    await flushSave();
    expect(api.saveQuotaBurn).toHaveBeenCalled();
    const [patch] = api.saveQuotaBurn.mock.calls.at(-1);
    expect(patch.families.grok.jobs[0]).not.toHaveProperty('pending');
    expect(patch.families.grok.jobs[0]).not.toHaveProperty('ranAt');
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
 * The catalog is the page's second read, and it fails independently of the
 * plan: the plan renders perfectly while every choice the form offers is empty.
 * Swallowing that failure left the preset picker gone, "Add job" disabled, and
 * every dropdown blank with nothing saying why — and editing a step against an
 * empty job-type list saves `jobType: ""`, which the strict PUT rejects.
 */
describe('QuotaBurn catalog failure', () => {
  it('names a failed catalog read instead of silently emptying the form', async () => {
    api.getQuotaBurnCatalog.mockRejectedValueOnce(new Error('Catalog request failed'));
    renderPage('/devtools/quota-burn/grok');

    expect(await screen.findByText('Job choices could not be loaded')).toBeInTheDocument();
    expect(screen.getByText(/Catalog request failed/)).toBeInTheDocument();
    // The controls the catalog feeds are gone or inert — the banner is the only
    // thing on screen that explains either.
    expect(screen.queryByLabelText(/Add a preset job/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add job/ })).toBeDisabled();
    // The plan itself still rendered: a catalog failure is not a page failure.
    expect(screen.getByText(/62% left/)).toBeInTheDocument();
  });

  it('re-fetches the catalog from the banner without a page reload', async () => {
    const user = userEvent.setup();
    api.getQuotaBurnCatalog.mockRejectedValueOnce(new Error('Catalog request failed'));
    renderPage('/devtools/quota-burn/grok');

    await user.click(await screen.findByRole('button', { name: 'Retry catalog load' }));
    await waitFor(() => expect(api.getQuotaBurnCatalog).toHaveBeenCalledTimes(2));
    // The success clears the banner AND restores the controls it was standing in for.
    await waitFor(() => expect(screen.queryByText('Job choices could not be loaded')).not.toBeInTheDocument());
    expect(screen.getByLabelText(/Add a preset job/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add job/ })).toBeEnabled();
  });

  it('treats a catalog that answered with no job types as its own failure', async () => {
    // Same symptom as a thrown read — every dropdown empty — but a different
    // cause, so it must not be reported as a successful load.
    api.getQuotaBurnCatalog.mockResolvedValueOnce({ ...catalog, jobTypes: [] });
    renderPage('/devtools/quota-burn/grok');
    expect(await screen.findByText(/The server returned no job types\./)).toBeInTheDocument();
  });

  it('survives a partial catalog payload whose lists are null', async () => {
    // A spread over the empty default lets an explicit `null` through, and every
    // consumer reads `.length` on these lists — so an older peer or a partial
    // response would take the whole page down with a TypeError instead of
    // reporting an unusable catalog.
    api.getQuotaBurnCatalog.mockResolvedValueOnce({ jobTypes: null, apps: null, universes: null, imageModes: null });
    renderPage('/devtools/quota-burn/grok');
    expect(await screen.findByText(/The server returned no job types\./)).toBeInTheDocument();
    expect(screen.getByText(/62% left/)).toBeInTheDocument();
  });

  it('announces the banner to assistive tech rather than only drawing it', async () => {
    // It appears after the card is already on screen — the read resolves late,
    // and a retry can put it back — so nothing announces it without a live region.
    api.getQuotaBurnCatalog.mockRejectedValueOnce(new Error('Catalog request failed'));
    renderPage('/devtools/quota-burn/grok');
    // Scope to the banner's own text: the first-paint PageSkeleton is also a
    // `status` region, so a bare role query would race it.
    const banner = (await screen.findByText('Job choices could not be loaded')).closest('[role="status"]');
    expect(banner).toHaveAttribute('aria-live', 'polite');
    expect(banner).toHaveTextContent('Job choices could not be loaded');
  });

  it('says nothing about the catalog when it loaded', async () => {
    renderPage('/devtools/quota-burn/grok');
    await screen.findByLabelText(/Add a preset job/);
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
    globalThis.sessionStorage.setItem(STASH_KEY, '"not-a-patch"');
    renderPage();

    expect(await screen.findByText(/62% left/)).toBeInTheDocument();
    await sleep(100);
    expect(api.saveQuotaBurn).not.toHaveBeenCalled();
  });

  it('ignores an empty stash rather than announcing a restore of nothing', async () => {
    globalThis.sessionStorage.setItem(STASH_KEY, '{}');
    renderPage();

    expect(await screen.findByText(/62% left/)).toBeInTheDocument();
    await sleep(100);
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

describe('QuotaBurn collapsible jobs', () => {
  it('renders configured jobs in a collapsed state by default with summary details', async () => {
    renderPage('/devtools/quota-burn/grok');
    expect(await screen.findByDisplayValue('Bible images')).toBeInTheDocument();
    // Compact summary badge shows job type
    expect(screen.getByText(/Universe bible images/)).toBeInTheDocument();
    // Inner fields are collapsed
    expect(screen.queryByLabelText('Job type')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Expand step 1')).toBeInTheDocument();
  });

  it('expands and collapses a single job using its chevron toggle', async () => {
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    const toggle = await screen.findByLabelText('Expand step 1');
    await user.click(toggle);

    // Now expanded: shows inner fields
    expect(await screen.findByLabelText('Job type')).toBeInTheDocument();
    expect(screen.getByLabelText('Collapse step 1')).toBeInTheDocument();

    // Click again to collapse
    await user.click(screen.getByLabelText('Collapse step 1'));
    expect(screen.queryByLabelText('Job type')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Expand step 1')).toBeInTheDocument();
  });

  it('expands all and collapses all jobs via header control', async () => {
    const twoJobConfig = {
      ...config,
      families: {
        ...config.families,
        grok: {
          ...config.families.grok,
          jobs: [
            { id: 'j1', enabled: true, label: 'Job 1', jobType: 'universe-bible-images', params: {} },
            { id: 'j2', enabled: true, label: 'Job 2', jobType: 'agent-prompt', params: {} },
          ],
        },
      },
    };
    api.getQuotaBurn.mockResolvedValue({ config: twoJobConfig, status });
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');

    expect(await screen.findByRole('button', { name: /Expand all/i })).toBeInTheDocument();
    expect(screen.queryByLabelText('Collapse step 1')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Collapse step 2')).not.toBeInTheDocument();

    // Expand all
    await user.click(screen.getByRole('button', { name: /Expand all/i }));
    expect(screen.getByLabelText('Collapse step 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Collapse step 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Collapse all/i })).toBeInTheDocument();

    // Collapse all
    await user.click(screen.getByRole('button', { name: /Collapse all/i }));
    expect(screen.queryByLabelText('Collapse step 1')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Collapse step 2')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Expand all/i })).toBeInTheDocument();
  });

  it('automatically expands newly added jobs for editing', async () => {
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    await user.click(await screen.findByRole('button', { name: /Add job/i }));
    expect(await screen.findByLabelText('Collapse step 2')).toBeInTheDocument();
  });
});

describe('QuotaBurn preset addition filtering', () => {
  const multiPresetCatalog = {
    ...catalog,
    presets: [
      { id: 'ux-audit', label: 'UX issues', summary: 'Audit UI.', jobType: 'agent-prompt', params: { prompt: 'Prompt 1' } },
      { id: 'a11y-audit', label: 'A11y issues', summary: 'Audit A11y.', jobType: 'agent-prompt', params: { prompt: 'Prompt 2' } },
    ],
  };

  it('filters preset addition dropdown to only presets not already in the family', async () => {
    const grokWithUx = {
      ...config,
      families: {
        ...config.families,
        grok: {
          ...config.families.grok,
          jobs: [
            { id: 'j1', enabled: true, label: 'UX issues', jobType: 'agent-prompt', params: { prompt: 'Prompt 1' } },
          ],
        },
      },
    };
    api.getQuotaBurn.mockResolvedValue({ config: grokWithUx, status });
    api.getQuotaBurnCatalog.mockResolvedValue(multiPresetCatalog);

    renderPage('/devtools/quota-burn/grok');
    const select = await screen.findByLabelText(/Add a preset job/);
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.value);

    // 'ux-audit' is already in the list, so only '' (placeholder) and 'a11y-audit' should be available
    expect(options).toEqual(['', 'a11y-audit']);
  });

  it('hides preset addition picker when all catalog presets are in the jobs list', async () => {
    const grokWithAll = {
      ...config,
      families: {
        ...config.families,
        grok: {
          ...config.families.grok,
          jobs: [
            { id: 'j1', enabled: true, label: 'UX issues', jobType: 'agent-prompt', params: { prompt: 'Prompt 1' } },
            { id: 'j2', enabled: true, label: 'A11y issues', jobType: 'agent-prompt', params: { prompt: 'Prompt 2' } },
          ],
        },
      },
    };
    api.getQuotaBurn.mockResolvedValue({ config: grokWithAll, status });
    api.getQuotaBurnCatalog.mockResolvedValue(multiPresetCatalog);

    renderPage('/devtools/quota-burn/grok');
    expect(await screen.findByDisplayValue('UX issues')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Add a preset job/)).not.toBeInTheDocument();
  });

  it('renders standard model select and effort picker for effort-capable providers', async () => {
    const claudeProviderCatalog = {
      ...catalog,
      providers: [
        {
          id: 'claude-code',
          name: 'Claude Code',
          type: 'tui',
          command: 'claude',
          models: [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4' }, { id: 'claude-opus-4', name: 'Claude Opus 4' }],
        },
      ],
    };
    const claudeConfig = {
      ...config,
      families: {
        ...config.families,
        claude: {
          enabled: true,
          resetWithinHours: 24,
          reservePercent: 0,
          maxDispatchesPerWindow: 5,
          priority: 0,
          jobs: [
            { id: 'j1', enabled: true, label: 'Audit UI', jobType: 'agent-prompt', model: 'claude-sonnet-4', effort: 'high', params: { appId: 'a1', prompt: 'audit' } },
          ],
        },
      },
    };
    api.getQuotaBurn.mockResolvedValue({ config: claudeConfig, status });
    api.getQuotaBurnCatalog.mockResolvedValue(claudeProviderCatalog);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = setupSaveUser();

    renderPage('/devtools/quota-burn/claude');
    await user.click(await screen.findByLabelText('Expand step 1'));

    const modelSelect = await screen.findByLabelText('Model (optional)');
    expect(modelSelect).toBeInTheDocument();
    expect(modelSelect.tagName).toBe('SELECT');
    expect(modelSelect).toHaveValue('claude-sonnet-4');

    const effortSelect = screen.getByLabelText('Thinking effort');
    expect(effortSelect).toBeInTheDocument();
    expect(effortSelect.tagName).toBe('SELECT');
    expect(effortSelect).toHaveValue('high');

    // Change effort to medium and verify auto-save
    await user.selectOptions(effortSelect, 'medium');
    await flushSave();
    expect(api.saveQuotaBurn).toHaveBeenCalledWith(
      expect.objectContaining({
        families: expect.objectContaining({
          claude: expect.objectContaining({
            jobs: [
              expect.objectContaining({
                id: 'j1',
                model: 'claude-sonnet-4',
                effort: 'medium',
              }),
            ],
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it('displays model and effort in collapsed step summary badge', async () => {
    const claudeConfig = {
      ...config,
      families: {
        ...config.families,
        claude: {
          enabled: true,
          resetWithinHours: 24,
          reservePercent: 0,
          maxDispatchesPerWindow: 5,
          priority: 0,
          jobs: [
            { id: 'j1', enabled: true, label: '', jobType: 'agent-prompt', model: 'claude-sonnet-4', effort: 'high', params: { appId: 'a1', prompt: 'audit' } },
          ],
        },
      },
    };
    api.getQuotaBurn.mockResolvedValue({ config: claudeConfig, status });
    api.getQuotaBurnCatalog.mockResolvedValue(catalog);

    renderPage('/devtools/quota-burn/claude');
    expect(await screen.findByText(/Agent prompt · claude-sonnet-4 · high/)).toBeInTheDocument();
  });
});
