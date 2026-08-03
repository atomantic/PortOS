import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import QuotaBurn from './QuotaBurn';

vi.mock('../services/api', () => ({
  getQuotaBurn: vi.fn(),
  getQuotaBurnCatalog: vi.fn(),
  saveQuotaBurn: vi.fn(),
  runQuotaBurn: vi.fn(),
}));

import * as api from '../services/api';

const config = {
  enabled: false,
  checkIntervalMinutes: 30,
  families: {
    grok: {
      enabled: true, providerId: null, scope: null, resetWithinHours: 24, reservePercent: 10,
      maxDispatchesPerWindow: 5, priority: 0,
      jobs: [{ id: 'j1', enabled: true, label: 'Bible images', jobType: 'universe-bible-images', model: null, providerId: null, params: {} }],
    },
    codex: { enabled: false, providerId: null, scope: null, resetWithinHours: 24, reservePercent: 0, maxDispatchesPerWindow: 5, priority: 0, jobs: [] },
  },
};

const status = {
  enabled: false, checkIntervalMinutes: 30, running: false, lastRunAt: null,
  families: [
    { id: 'grok', label: 'Grok', willBurn: true, percentRemaining: 62, hoursUntilReset: 2.4, dispatchesUsed: 1, skipReason: null, jobs: [{ id: 'j1', pending: { count: 4, detail: '4 bible entries have no image' } }] },
    { id: 'codex', label: 'Codex', willBurn: false, skipReason: 'disabled', jobs: [] },
  ],
  runs: [{ at: new Date().toISOString(), trigger: 'scheduled', dispatched: false, reason: 'no burnable window' }],
};

const catalog = {
  families: ['grok', 'codex'],
  jobTypes: [
    { id: 'universe-bible-images', label: 'Universe bible images', description: 'Render missing bible images.', params: [{ key: 'universeId', kind: 'universe', label: 'Universe', default: 'all' }] },
    { id: 'agent-prompt', label: 'Agent prompt', description: 'Queue a CoS agent.', params: [{ key: 'appId', kind: 'app', label: 'Managed app', required: true }] },
  ],
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
});

describe('QuotaBurn page', () => {
  it('shows each family\'s live window or the reason it will not burn', async () => {
    renderPage();
    expect(await screen.findByText(/62% left/)).toBeInTheDocument();
    // A family that will not burn states WHY — the same predicate the runner
    // evaluates, so the page can never disagree with what actually happens.
    expect(screen.getByText('disabled')).toBeInTheDocument();
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

  it('force-runs a single job from its row', async () => {
    const user = userEvent.setup();
    renderPage('/devtools/quota-burn/grok');
    await user.click(await screen.findByLabelText('Run step 1 now'));
    await waitFor(() => expect(api.runQuotaBurn).toHaveBeenCalledWith(
      { familyId: 'grok', jobId: 'j1', force: true }, { silent: true },
    ));
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
