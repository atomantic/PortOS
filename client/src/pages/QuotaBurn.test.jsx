import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import QuotaBurn from './QuotaBurn';
import { sleep } from '../utils/sleep';

vi.mock('../services/api', () => ({
  getQuotaBurn: vi.fn(),
  getQuotaBurnCatalog: vi.fn(),
  saveQuotaBurn: vi.fn(),
  runQuotaBurn: vi.fn(),
  rearmQuotaBurn: vi.fn(),
}));

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

beforeEach(() => {
  vi.clearAllMocks();
  api.getQuotaBurn.mockResolvedValue({ config, status });
  api.getQuotaBurnCatalog.mockResolvedValue(catalog);
  api.saveQuotaBurn.mockResolvedValue({ config });
  api.runQuotaBurn.mockResolvedValue({ result: { dispatched: false, reason: 'nothing to burn' } });
  api.rearmQuotaBurn.mockResolvedValue({ config, status });
});

describe('QuotaBurn page', () => {
  it('shows each family\'s live window or the reason it will not burn', async () => {
    renderPage();
    expect(await screen.findByText(/62% left/)).toBeInTheDocument();
    // A family that will not burn states WHY — the same predicate the runner
    // evaluates, so the page can never disagree with what actually happens.
    expect(screen.getByText('disabled')).toBeInTheDocument();
  });

  it('renders immediately while a family\'s quota is still being read, then polls it in', async () => {
    // The server does not hold the response open for a 10-20s CLI/TUI spawn on a
    // cold cache — it answers with `pending` and the page fills the number in.
    // "reading quota…" must not be confused with a verdict: a pending family
    // has no reading yet, so neither "will burn" nor a skip reason is true.
    const pendingStatus = {
      ...status,
      families: [{ ...status.families[0], willBurn: false, percentRemaining: null, skipReason: 'reading provider quota…', pending: true }, status.families[1]],
    };
    api.getQuotaBurn.mockResolvedValueOnce({ config, status: pendingStatus });
    renderPage();

    expect(await screen.findByText(/reading quota…/)).toBeInTheDocument();
    // The plan itself rendered on that same first paint — the page is usable
    // before any provider has answered.
    expect(screen.getByLabelText(/Run the quota-burn loop automatically/)).toBeInTheDocument();

    // The poll (default mock: no longer pending) replaces it with the reading.
    expect(await screen.findByText(/62% left/, undefined, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.queryByText(/reading quota…/)).not.toBeInTheDocument();
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
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    const cap = await screen.findByLabelText(/Dispatch cap per window/);
    await user.clear(cap);
    await user.type(cap, '0');
    await waitFor(() => expect(api.saveQuotaBurn).toHaveBeenCalled());
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
  });

  it('does NOT poll when nothing is pending', async () => {
    renderPage();
    await screen.findByText(/62% left/);
    // One load on mount, and no timer re-arming behind it.
    await sleep(100);
    expect(api.getQuotaBurn).toHaveBeenCalledTimes(1);
  });

  it('saves the master switch as a partial patch', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByLabelText(/Run the quota-burn loop automatically/));
    await waitFor(() => expect(api.saveQuotaBurn).toHaveBeenCalledWith({ enabled: true }, { silent: true }));
  });

  it('drives the expanded family from the URL, not local state', async () => {
    // Deep-linking rule: which plan is open must survive a reload and be shareable.
    renderPage('/devtools/quota-burn/grok');
    expect(await screen.findByLabelText(/Reserve \(%\)/)).toHaveValue(10);
    expect(screen.getByDisplayValue('Bible images')).toBeInTheDocument();
    expect(screen.getByText(/Ready — 4 bible entries have no image/)).toBeInTheDocument();
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

  it('adds a fully-configured job from a preset, inheriting the plan\'s app', async () => {
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    await user.selectOptions(await screen.findByLabelText(/Add a preset job/), 'ux-audit');
    await waitFor(() => expect(api.saveQuotaBurn).toHaveBeenCalled());
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
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    await user.click(await screen.findByLabelText('Name for step 1'));
    await user.keyboard('!');
    await waitFor(() => expect(api.saveQuotaBurn).toHaveBeenCalled());
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
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    await user.click(await screen.findByLabelText('Run once'));
    await waitFor(() => expect(api.saveQuotaBurn).toHaveBeenCalled());
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

describe('QuotaBurn save debounce', () => {
  it('folds a burst of edits into ONE PUT and blocks runs until it lands', async () => {
    // Per-keystroke saving also re-read the status, and a universe-bible-images
    // pending probe walks every bible — one full scan per character typed.
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    const nameInput = await screen.findByLabelText('Name for step 1');
    await user.click(nameInput);
    await user.keyboard('abc');

    // Mid-burst: nothing persisted yet, and every run control is disabled
    // because the server still holds the pre-edit plan.
    expect(api.saveQuotaBurn).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Evaluate now/ })).toBeDisabled();
    expect(screen.getByLabelText('Run step 1 now')).toBeDisabled();

    await waitFor(() => expect(api.saveQuotaBurn).toHaveBeenCalledTimes(1));
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
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    const nameInput = await screen.findByLabelText('Name for step 1');
    await user.clear(nameInput);
    await user.type(nameInput, 'AB');
    await waitFor(() => expect(api.saveQuotaBurn).toHaveBeenCalledTimes(1));

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
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    const nameInput = await screen.findByLabelText('Name for step 1');
    await user.type(nameInput, 'X');
    await waitFor(() => expect(api.saveQuotaBurn).toHaveBeenCalledTimes(1));
    await user.type(nameInput, 'Y');
    gate.resolve({ config });

    // Let the resolved save settle, but stay inside the second edit's debounce.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.getByRole('button', { name: /Evaluate now/ })).toBeDisabled();
  });

  it('retains the patch when the save fails so one bad field cannot eat the rest', async () => {
    // `pendingRef` was cleared before the request, so a 400 discarded every
    // edit coalesced into that body, unrecoverably.
    api.saveQuotaBurn.mockRejectedValueOnce(new Error('400'));
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    await user.type(await screen.findByLabelText('Name for step 1'), 'Z');
    await waitFor(() => expect(api.saveQuotaBurn).toHaveBeenCalledTimes(1));

    // Still unsaved, and the next flush re-sends the retained edit.
    await waitFor(() => expect(screen.getByRole('button', { name: /Evaluate now/ })).toBeDisabled());
    await user.type(screen.getByLabelText('Name for step 1'), '!');
    await waitFor(() => expect(api.saveQuotaBurn).toHaveBeenCalledTimes(2));
    expect(api.saveQuotaBurn.mock.calls[1][0].families.grok.jobs[0].label).toContain('Z!');
  });

  it('stops claiming it is saving once the retry budget is spent', async () => {
    // The header indicator is the page's only persistent statement about
    // persistence (there is no Save button). Leaving it on "Saving changes…"
    // after both attempts failed asserts progress that is not happening.
    api.saveQuotaBurn.mockRejectedValue(new Error('400'));
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    await user.type(await screen.findByLabelText('Name for step 1'), 'Z');
    await waitFor(() => expect(api.saveQuotaBurn).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Not saved — edit a field to retry')).toBeInTheDocument();

    // The next edit re-arms the debounce, so the give-up no longer applies.
    api.saveQuotaBurn.mockResolvedValue({ config });
    await user.type(screen.getByLabelText('Name for step 1'), '!');
    expect(screen.getByText('Saving changes…')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Changes save automatically')).toBeInTheDocument());
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

  it('still offers a retry when the server answers without a plan', async () => {
    // No error to name — but the page is just as stuck, so the way out has to
    // be the same one.
    api.getQuotaBurn.mockResolvedValueOnce({ config: null, status: null });
    renderPage();
    expect(await screen.findByText('The server did not return a plan.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('does not commit 0 when a number field is cleared to be retyped', async () => {
    // Number('') === 0, which is below the server minimum for the interval and
    // the dispatch cap — a 400 that also discards every co-pending edit.
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    await user.clear(await screen.findByLabelText(/Dispatch cap per window/));
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); });
    expect(api.saveQuotaBurn).not.toHaveBeenCalled();
  });
});
