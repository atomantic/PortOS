import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { MockEventSource, lastEventSource } from '../test/mockEventSource';

const STEPS = [
  { id: 'idea', label: 'Idea', description: 'Capture a starter idea.' },
  { id: 'universeAesthetic', label: 'Universe Aesthetic', description: 'Lock the look.' },
  { id: 'plotArc', label: 'Plot Arc', description: 'Expand the arc.' },
  { id: 'readerMap', label: 'Reader Map', description: 'Plan the reader experience.' },
  { id: 'characters', label: 'Characters', description: 'Lock the cast.' },
  { id: 'issues', label: 'Issues', description: 'Complete issues.' },
  { id: 'production', label: 'Production', description: 'Render.' },
];

const mkSteps = (overrides = {}) => Object.fromEntries(STEPS.map((s) => [
  s.id, overrides[s.id] || { status: 'pending', locked: false, lockedAt: null, upstreamHash: null },
]));

const api = vi.hoisted(() => ({
  getStoryBuilderSteps: vi.fn(),
  listStorySessions: vi.fn(),
  getStorySession: vi.fn(),
  createStorySession: vi.fn(),
  updateStorySession: vi.fn(),
  setStoryCurrentStep: vi.fn(),
  lockStoryStep: vi.fn(),
  unlockStoryStep: vi.fn(),
  generateStoryStep: vi.fn(),
  refineStoryStep: vi.fn(),
  setStorySessionSync: vi.fn(),
  reconcileStorySession: vi.fn(),
  storyStepProgressSseUrl: vi.fn((id, stepId) => `/api/story-builder/${id}/steps/${stepId}/progress`),
  setStoryIssueLock: vi.fn(),
  getUniverse: vi.fn(),
  getPipelineSeries: vi.fn(),
  listPipelineIssues: vi.fn(),
  analyzeImport: vi.fn(),
  commitImport: vi.fn(),
  retryImporterIssues: vi.fn(),
  IMPORTER_CONTENT_TYPES: ['short-story', 'novel', 'screenplay', 'comic-script'],
  getProviders: vi.fn(),
  getSettings: vi.fn(),
  generateImage: vi.fn(),
  updateUniverse: vi.fn(),
  updatePipelineSeries: vi.fn(),
  listCatalogIngredientsByIds: vi.fn(),
}));
vi.mock('../services/api', () => api);

// Some descendants import Socket.IO directly rather than via the shared
// service. Keep the test boundary closed for either form of that dependency.
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({ on: vi.fn(), off: vi.fn(), connected: false })),
}));

// StoryBuilder imports render-thumbnail controls which subscribe through the
// application socket client. Keep this route suite at its API boundary: the
// real client eagerly opens a Socket.IO connection at module load, which turns
// a passing route test into a localhost request outside its fixtures.
vi.mock('../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn() },
}));

const mediaJobs = vi.hoisted(() => ({ getMediaJob: vi.fn() }));
vi.mock('../services/apiMediaJobs', () => mediaJobs);

const unexpectedRequests = [];

const rejectUnexpectedRequest = (input, init = {}) => {
  const request = input instanceof Request ? input : null;
  const method = init.method || request?.method || 'GET';
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url || String(input);
  const origin = new Error('Unexpected network request origin').stack;
  const error = new Error(`Unexpected network request: ${method} ${url}\nOrigin stack:\n${origin}`);
  unexpectedRequests.push(error);
  return Promise.reject(error);
};

// useCatalogTypes fetches the merged registry; mock it to "no user types" so the
// hook resolves deterministically to the built-in six (its static fallback).
vi.mock('../services/apiCatalogTypes', () => ({
  listCatalogTypes: vi.fn().mockResolvedValue({ types: [] }),
}));

// Spy on toast so the rejection tests can prove the catch-path notice fired —
// the success path never toasts, so a specific toast.error message uniquely
// pins the rejection branch (a bare reload-count check can't, since onSuccess
// already reloads before the pointer move).
const toastMock = vi.hoisted(() => {
  const fn = vi.fn();
  fn.success = vi.fn(); fn.error = vi.fn(); fn.loading = vi.fn(); fn.warning = vi.fn(); fn.dismiss = vi.fn();
  return fn;
});
vi.mock('../components/ui/Toast', () => ({ default: toastMock, toast: toastMock, Toaster: () => null }));

// Stand-in for the committer ArcContent hands up through ArcCanvas when its
// logline / summary / protagonist-arc editor is open with unsaved text.
const arcDraftFlush = vi.hoisted(() => vi.fn(async () => true));

// The plotArc step embeds the full ArcCanvas roadmap editor; mock it to an
// inert sentinel so these tests assert the EMBEDDING (and its props) without
// pulling ArcCanvas's heavy import graph or its own API calls into scope.
vi.mock('../components/pipeline/ArcCanvas', () => ({
  default: ({ series, onRegisterDraftFlush }) => {
    onRegisterDraftFlush?.(arcDraftFlush);
    return <div data-testid="arc-canvas">ArcCanvas[{series?.id}]</div>;
  },
}));

import StoryBuilder, { composeSeedFromIngredients } from './StoryBuilder';

const renderAt = (entry) => render(
  <MemoryRouter initialEntries={[entry]}>
    <Routes>
      <Route path="/story-builder" element={<StoryBuilder />} />
      <Route path="/story-builder/:storyId/:step" element={<StoryBuilder />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  unexpectedRequests.length = 0;
  vi.stubGlobal('fetch', vi.fn(rejectUnexpectedRequest));
  api.getStoryBuilderSteps.mockResolvedValue({ steps: STEPS });
  api.listStorySessions.mockResolvedValue([]);
  api.getProviders.mockResolvedValue({ providers: [{ id: 'p1', name: 'Claude', enabled: true, models: ['opus', 'sonnet'] }] });
  api.updateStorySession.mockResolvedValue({});
  api.getSettings.mockResolvedValue({});
  api.generateImage.mockResolvedValue({ jobId: 'job-1' });
  api.updateUniverse.mockResolvedValue({});
  // Benign default so a post-import navigation that mounts the detail view
  // (which calls getStorySession) doesn't reject; the detail tests override it.
  api.getStorySession.mockResolvedValue({
    id: 'stb-x', title: 'X', currentStep: 'idea', steps: mkSteps(), staleSteps: [], universeId: null, seriesId: null,
  });
  api.setStoryCurrentStep.mockResolvedValue({});
  api.lockStoryStep.mockResolvedValue({});
  api.unlockStoryStep.mockResolvedValue({});
  api.generateStoryStep.mockResolvedValue({ result: {} });
  api.refineStoryStep.mockResolvedValue({ result: {}, changes: [] });
  api.setStoryIssueLock.mockResolvedValue({});
  // The sync/reconcile routes return the recomputed view (staleSteps + syncDrift),
  // not just the record — toggling sync or reconciling can shift staleness.
  api.setStorySessionSync.mockImplementation(async (_id, sync) => ({ id: 'stb-1', sync, staleSteps: [], syncDrift: false }));
  api.reconcileStorySession.mockResolvedValue({ id: 'stb-1', sync: true, staleSteps: [], syncDrift: false });
  api.getUniverse.mockResolvedValue({ id: 'u1', logline: 'L', premise: 'P', styleNotes: 'S', influences: { embrace: [], avoid: [] }, characters: [] });
  api.getPipelineSeries.mockResolvedValue({ id: 's1', arc: { logline: 'AL', summary: 'AS', readerMap: { hooks: [{ id: 'rm-1', label: 'Why?' }] } } });
  api.listPipelineIssues.mockResolvedValue([]);
  api.listCatalogIngredientsByIds.mockResolvedValue([]);
  mediaJobs.getMediaJob.mockResolvedValue({ status: 'queued' });
});

afterEach(() => {
  // A caught request is still an isolation failure, so assert the guard here
  // rather than relying on an incidental ECONNREFUSED warning in test output.
  try {
    expect(unexpectedRequests).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});

describe('composeSeedFromIngredients', () => {
  it('returns an empty string for no ingredients', () => {
    expect(composeSeedFromIngredients([])).toBe('');
    expect(composeSeedFromIngredients(null)).toBe('');
  });

  it('groups by type with a header line and a bullet (name: summary) per ingredient', () => {
    const out = composeSeedFromIngredients([
      { id: 'c1', name: 'Echo Saint', type: 'character', payload: { description: 'A wiry figure in a long coat.' } },
      { id: 'c2', name: 'Mara', type: 'character', payload: { summary: 'Loyal to a fault.' } },
      { id: 'p1', name: 'Old Harbor', type: 'place', payload: { description: 'Brine and rust.' } },
    ]);
    expect(out).toContain('Characters:');
    expect(out).toContain('- Echo Saint: A wiry figure in a long coat.');
    expect(out).toContain('- Mara: Loyal to a fault.');
    expect(out).toContain('Places:');
    expect(out).toContain('- Old Harbor: Brine and rust.');
  });

  it('uses a character\'s physicalDescription (its primary content key), not just description', () => {
    // A normal Catalog character stores its body prose under physicalDescription;
    // payloadSnippet follows the type's snippetFallbackKeys so it is included.
    const out = composeSeedFromIngredients([
      { id: 'c1', name: 'Vance', type: 'character', payload: { physicalDescription: 'Scarred, silver-eyed, never still.' } },
    ]);
    expect(out).toContain('- Vance: Scarred, silver-eyed, never still.');
  });

  it('honors a user-defined type resolver (custom label + snippetFallbackKeys)', () => {
    // A user-defined `faction` type whose body field is `creed` — the resolver
    // (useCatalogTypes().getType) carries its snippetFallbackKeys + label.
    const resolve = (id) => (id === 'faction'
      ? { id: 'faction', label: 'Faction', snippetFallbackKeys: ['creed', 'description'] }
      : undefined);
    const out = composeSeedFromIngredients(
      [{ id: 'f1', name: 'The Tide', type: 'faction', payload: { creed: 'The sea remembers.' } }],
      resolve,
    );
    expect(out).toContain('Factions:');
    expect(out).toContain('- The Tide: The sea remembers.');
  });

  it('truncates each summary to ~120 chars and the whole text to 4000', () => {
    const long = 'x'.repeat(500);
    const out = composeSeedFromIngredients([{ id: 'c1', name: 'Big', type: 'idea', payload: { description: long } }]);
    // payloadSnippet caps at 120 with an ellipsis (117 chars + '…').
    expect(out).toContain(`- Big: ${'x'.repeat(117)}…`);
    expect(out).not.toContain('x'.repeat(118));
    expect(out.length).toBeLessThanOrEqual(4000);
  });

  it('falls back to just the name when no summary field is present', () => {
    const out = composeSeedFromIngredients([{ id: 'o1', name: 'Relic', type: 'object', payload: {} }]);
    expect(out).toContain('Objects:');
    expect(out).toContain('- Relic');
    expect(out).not.toContain('- Relic:');
  });
});

describe('StoryBuilder — index', () => {
  it('renders the seed create form by default', async () => {
    renderAt('/story-builder');
    expect(await screen.findByLabelText('Universe / story name')).toBeTruthy();
    expect(screen.getByText('Start from an idea')).toBeTruthy();
    expect(screen.getByText('Import a finished work')).toBeTruthy();
  });

  it('session list: shows a loading skeleton until the fetch resolves, then the sessions (#3906)', async () => {
    let resolveList;
    api.listStorySessions.mockReturnValue(new Promise((res) => { resolveList = res; }));

    renderAt('/story-builder');

    expect(await screen.findByLabelText('Loading your stories')).toBeTruthy();
    await act(async () => { resolveList([{ id: 'stb-1', title: 'Example Story', currentStep: 'idea' }]); });

    await waitFor(() => expect(screen.queryByLabelText('Loading your stories')).toBeNull());
    expect(screen.getByText('Example Story')).toBeTruthy();
  });

  it('session list: a failed fetch shows an error banner with Retry, and Retry restores the list (#3906)', async () => {
    const { fireEvent } = await import('@testing-library/react');
    api.listStorySessions.mockRejectedValueOnce(new Error('Network is down'));

    renderAt('/story-builder');

    // The section stays visible with the failure named — not silently blank.
    expect(await screen.findByText('Couldn’t load your saved stories')).toBeTruthy();
    expect(screen.getByText('Network is down')).toBeTruthy();
    expect(screen.getByText('Continue a story')).toBeTruthy();

    api.listStorySessions.mockResolvedValue([{ id: 'stb-2', title: 'Recovered Story', currentStep: 'plotArc' }]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Retry/i })); });

    await waitFor(() => expect(screen.getByText('Recovered Story')).toBeTruthy());
    expect(screen.queryByText('Couldn’t load your saved stories')).toBeNull();
    expect(api.listStorySessions).toHaveBeenCalledTimes(2);
  });

  it('session list: a successful but empty list hides the section entirely (#3906)', async () => {
    api.listStorySessions.mockResolvedValue([]);
    renderAt('/story-builder');
    await screen.findByLabelText('Universe / story name');
    await waitFor(() => expect(screen.queryByLabelText('Loading your stories')).toBeNull());
    expect(screen.queryByText('Continue a story')).toBeNull();
  });

  it('remix handoff: hydrates selected ingredients into chips + a prefilled seed, and forwards the ids on create', async () => {
    const { fireEvent } = await import('@testing-library/react');
    api.listCatalogIngredientsByIds.mockResolvedValue([
      { id: 'i-1', name: 'Echo Saint', type: 'character', payload: { description: 'A wiry figure in a long coat.' } },
      { id: 'i-2', name: 'Old Harbor', type: 'place', payload: { summary: 'Brine and rust.' } },
    ]);
    api.createStorySession.mockResolvedValue({ id: 'stb-remix', currentStep: 'idea' });

    renderAt({ pathname: '/story-builder', state: { remix: { ingredientIds: ['i-1', 'i-2'] } } });

    // The batch endpoint is hit with the handed-off ids.
    await waitFor(() => expect(api.listCatalogIngredientsByIds).toHaveBeenCalledWith(['i-1', 'i-2'], expect.objectContaining({ silent: true })));
    // Chip list + count.
    expect(await screen.findByText('Seeding from 2 ingredients')).toBeTruthy();
    // The seed textarea is prefilled from the composed summary.
    const seed = screen.getByLabelText('Starter idea');
    await waitFor(() => expect(seed.value).toContain('Echo Saint'));
    expect(seed.value).toContain('Characters:');

    fireEvent.change(screen.getByLabelText('Universe / story name'), { target: { value: 'Salt Run' } });
    fireEvent.click(screen.getByRole('button', { name: /Create & begin/i }));
    await waitFor(() => expect(api.createStorySession).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Salt Run', catalogIngredientIds: ['i-1', 'i-2'] }),
      expect.objectContaining({ silent: true }),
    ));
  });

  it('import tab: analyze → preview → import & build creates an import-mode session', async () => {
    const { fireEvent } = await import('@testing-library/react');
    api.analyzeImport.mockResolvedValue({
      universe: { id: 'u9', name: 'Giant' },
      series: { id: 's9' },
      canonPreview: { characters: [{ name: 'Kessa' }], places: [], objects: [] },
      arcPreview: { logline: 'A giant wakes.', summary: 'spine' },
      seasonsPreview: [{ number: 1, title: 'Vol 1' }],
      issueProposals: [{ title: 'Issue 1' }],
      issueSplitFailed: false,
    });
    api.commitImport.mockResolvedValue({ universe: { id: 'u9' }, series: { id: 's9' }, createdIssueIds: ['iss-1'] });
    api.createStorySession.mockResolvedValue({ id: 'stb-import', currentStep: 'idea' });

    renderAt('/story-builder');
    fireEvent.click(await screen.findByText('Import a finished work'));
    fireEvent.change(await screen.findByLabelText('Universe name'), { target: { value: 'Giant' } });
    fireEvent.change(screen.getByLabelText('Series name'), { target: { value: 'Giant' } });
    fireEvent.change(screen.getByLabelText(/Source text/), { target: { value: 'PAGE ONE...' } });
    fireEvent.click(screen.getByRole('button', { name: /^Analyze$/ }));

    await waitFor(() => expect(screen.getByText(/Extracted/)).toBeTruthy());
    expect(api.analyzeImport).toHaveBeenCalledWith(
      expect.objectContaining({ universeName: 'Giant', contentType: 'comic-script', source: 'PAGE ONE...' }),
      expect.objectContaining({ silent: true }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Import & start building/ }));
    await waitFor(() => expect(api.createStorySession).toHaveBeenCalledWith(
      expect.objectContaining({ intakeMode: 'import', universeId: 'u9', seriesId: 's9', title: 'Giant' }),
      expect.objectContaining({ silent: true }),
    ));
    // commit included all extracted canon + the arc + seasons + issues
    expect(api.commitImport).toHaveBeenCalledWith(
      expect.objectContaining({
        universeId: 'u9', seriesId: 's9', contentType: 'comic-script',
        issues: [{ title: 'Issue 1' }],
      }),
      expect.objectContaining({ silent: true }),
    );
  });

  it('import tab: threads the picked provider into analyze and the created session', async () => {
    const { fireEvent } = await import('@testing-library/react');
    api.analyzeImport.mockResolvedValue({
      universe: { id: 'u9', name: 'Giant' }, series: { id: 's9' },
      canonPreview: { characters: [], places: [], objects: [] },
      arcPreview: { logline: 'x', summary: 's' }, seasonsPreview: [],
      issueProposals: [{ title: 'I1' }], issueSplitFailed: false,
    });
    api.commitImport.mockResolvedValue({});
    api.createStorySession.mockResolvedValue({ id: 'stb-imp', currentStep: 'idea' });

    renderAt('/story-builder');
    fireEvent.click(await screen.findByText('Import a finished work'));
    fireEvent.change(await screen.findByLabelText('AI'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('Universe name'), { target: { value: 'Giant' } });
    fireEvent.change(screen.getByLabelText('Series name'), { target: { value: 'Giant' } });
    fireEvent.change(screen.getByLabelText(/Source text/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /^Analyze$/ }));
    await waitFor(() => expect(api.analyzeImport).toHaveBeenCalledWith(
      expect.objectContaining({ providerOverride: 'p1' }), expect.anything(),
    ));
    fireEvent.click(await screen.findByRole('button', { name: /Import & start building/ }));
    await waitFor(() => expect(api.createStorySession).toHaveBeenCalledWith(
      expect.objectContaining({ llm: { provider: 'p1', model: null } }), expect.anything(),
    ));
  });

  it('import tab: a partial commit (issues rolled back) retries issues-only without re-sending arc/canon', async () => {
    const { fireEvent } = await import('@testing-library/react');
    api.analyzeImport.mockResolvedValue({
      universe: { id: 'u9', name: 'Giant' }, series: { id: 's9' },
      canonPreview: { characters: [{ name: 'Kessa' }], places: [], objects: [] },
      arcPreview: { logline: 'A giant wakes.', summary: 'spine' },
      seasonsPreview: [{ number: 1, title: 'Vol 1' }],
      issueProposals: [{ title: 'Issue 1' }], issueSplitFailed: false,
    });
    // First commit fails after persisting universe/series/arc/canon; the server
    // rolled the issues back and signals arcAlreadyPersisted.
    const partial = Object.assign(new Error('issues rolled back'), {
      code: 'IMPORTER_PARTIAL_COMMIT_ISSUES', context: { arcAlreadyPersisted: true },
    });
    api.commitImport.mockRejectedValueOnce(partial);
    api.commitImport.mockResolvedValueOnce({ universe: { id: 'u9' }, series: { id: 's9' }, createdIssueIds: ['iss-1'] });
    api.createStorySession.mockResolvedValue({ id: 'stb-import', currentStep: 'idea' });

    renderAt('/story-builder');
    fireEvent.click(await screen.findByText('Import a finished work'));
    fireEvent.change(await screen.findByLabelText('Universe name'), { target: { value: 'Giant' } });
    fireEvent.change(screen.getByLabelText('Series name'), { target: { value: 'Giant' } });
    fireEvent.change(screen.getByLabelText(/Source text/), { target: { value: 'PAGE ONE...' } });
    fireEvent.click(screen.getByRole('button', { name: /^Analyze$/ }));
    await waitFor(() => expect(screen.getByText(/Extracted/)).toBeTruthy());

    // First click → partial-commit warning, button flips to the issues-only retry label.
    fireEvent.click(screen.getByRole('button', { name: /Import & start building/ }));
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: /Retry issues & start building/ })).toBeTruthy());
    // No session created from the failed commit.
    expect(api.createStorySession).not.toHaveBeenCalled();

    // Second click → retry drops arc + seasons + canon, re-sends issues only.
    fireEvent.click(screen.getByRole('button', { name: /Retry issues & start building/ }));
    await waitFor(() => expect(api.createStorySession).toHaveBeenCalled());
    expect(api.commitImport).toHaveBeenCalledTimes(2);
    expect(api.commitImport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        universeId: 'u9', seriesId: 's9', issues: [{ title: 'Issue 1' }],
        arc: null, seasons: [], canonSelections: { characters: [], places: [], objects: [] },
      }),
      expect.objectContaining({ silent: true }),
    );
  });

  it('import tab: a committed import whose session-create fails retries the session only, never re-committing', async () => {
    const { fireEvent } = await import('@testing-library/react');
    api.analyzeImport.mockResolvedValue({
      universe: { id: 'u9', name: 'Giant' }, series: { id: 's9' },
      canonPreview: { characters: [{ name: 'Kessa' }], places: [], objects: [] },
      arcPreview: { logline: 'A giant wakes.', summary: 'spine' },
      seasonsPreview: [{ number: 1, title: 'Vol 1' }],
      issueProposals: [{ title: 'Issue 1' }], issueSplitFailed: false,
    });
    // Commit succeeds on the first click; createStorySession then fails, leaving
    // the import committed but no session created.
    api.commitImport.mockResolvedValue({ universe: { id: 'u9' }, series: { id: 's9' }, createdIssueIds: ['iss-1'] });
    api.createStorySession.mockRejectedValueOnce(new Error('session create failed'));
    api.createStorySession.mockResolvedValueOnce({ id: 'stb-import', currentStep: 'idea' });

    renderAt('/story-builder');
    fireEvent.click(await screen.findByText('Import a finished work'));
    fireEvent.change(await screen.findByLabelText('Universe name'), { target: { value: 'Giant' } });
    fireEvent.change(screen.getByLabelText('Series name'), { target: { value: 'Giant' } });
    fireEvent.change(screen.getByLabelText(/Source text/), { target: { value: 'PAGE ONE...' } });
    fireEvent.click(screen.getByRole('button', { name: /^Analyze$/ }));
    await waitFor(() => expect(screen.getByText(/Extracted/)).toBeTruthy());

    // First click → commit succeeds, session fails, button flips to the
    // session-only retry label.
    fireEvent.click(screen.getByRole('button', { name: /Import & start building/ }));
    await waitFor(() => expect(api.createStorySession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /Retry starting the builder/ })).toBeTruthy());
    expect(api.commitImport).toHaveBeenCalledTimes(1);

    // Second click → commitImport is NOT re-run; only createStorySession retries.
    fireEvent.click(screen.getByRole('button', { name: /Retry starting the builder/ }));
    await waitFor(() => expect(api.createStorySession).toHaveBeenCalledTimes(2));
    expect(api.commitImport).toHaveBeenCalledTimes(1);
    // …and the retry's success is consumed: onCreated navigates to the new
    // session's detail view, which loads it (proving the result wasn't dropped).
    await waitFor(() => expect(api.getStorySession).toHaveBeenCalledWith('stb-import', expect.anything()));
  });

  it('import tab: blocks "Import & build" when no issues were extracted, offers retry', async () => {
    const { fireEvent } = await import('@testing-library/react');
    api.analyzeImport.mockResolvedValue({
      universe: { id: 'u9', name: 'Giant' }, series: { id: 's9' },
      canonPreview: { characters: [], places: [], objects: [] },
      arcPreview: { logline: 'x' }, seasonsPreview: [],
      issueProposals: [], issueSplitFailed: true,
    });
    renderAt('/story-builder');
    fireEvent.click(await screen.findByText('Import a finished work'));
    fireEvent.change(await screen.findByLabelText('Universe name'), { target: { value: 'Giant' } });
    fireEvent.change(screen.getByLabelText('Series name'), { target: { value: 'Giant' } });
    fireEvent.change(screen.getByLabelText(/Source text/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /^Analyze$/ }));
    await waitFor(() => expect(screen.getByText(/Retry issue split/)).toBeTruthy());
    expect(screen.getByRole('button', { name: /Import & start building/ }).disabled).toBe(true);
  });

  it('import tab: a round trip through the seed tab keeps the typed intake and the analysis preview (#3904)', async () => {
    const { fireEvent } = await import('@testing-library/react');
    api.analyzeImport.mockResolvedValue({
      universe: { id: 'u1', name: 'Example Universe' }, series: { id: 's1' },
      canonPreview: { characters: [{ name: 'A' }], places: [], objects: [] },
      arcPreview: { logline: 'A courier outruns the tide.', summary: 'S' }, seasonsPreview: [],
      issueProposals: [{ number: 1, title: 'One' }],
    });
    renderAt('/story-builder');

    fireEvent.click(await screen.findByText('Import a finished work'));
    fireEvent.change(await screen.findByLabelText('Universe name'), { target: { value: 'Example Universe' } });
    fireEvent.change(screen.getByLabelText('Series name'), { target: { value: 'Example Series' } });
    fireEvent.change(screen.getByLabelText(/Source text/), { target: { value: 'PAGE ONE. A long manuscript.' } });
    fireEvent.click(screen.getByRole('button', { name: /^Analyze$/ }));

    // The minute-long analysis landed.
    expect(await screen.findByText(/Extracted “Example Universe”/)).toBeTruthy();
    expect(api.analyzeImport).toHaveBeenCalledTimes(1);

    // Flip to the seed tab and back — this used to unmount <ImportPanel> and
    // destroy the manuscript, the form fields, and the preview with it.
    fireEvent.click(screen.getByText('Start from an idea'));
    expect(await screen.findByLabelText('Universe / story name')).toBeTruthy();
    fireEvent.click(screen.getByText('Import a finished work'));

    // Everything survived, and no second analyze was needed to get it back.
    expect(await screen.findByText(/Extracted “Example Universe”/)).toBeTruthy();
    expect(screen.getByLabelText('Universe name').value).toBe('Example Universe');
    expect(screen.getByLabelText('Series name').value).toBe('Example Series');
    expect(screen.getByLabelText(/Source text/).value).toBe('PAGE ONE. A long manuscript.');
    expect(api.analyzeImport).toHaveBeenCalledTimes(1);
  });

  it('intake tab: ?intake=import deep-links straight to the import form (#3904)', async () => {
    renderAt('/story-builder?intake=import');
    expect(await screen.findByLabelText('Universe name')).toBeTruthy();
    // The seed form is the one that was replaced, not merely hidden alongside it.
    expect(screen.queryByLabelText('Universe / story name')).toBeNull();
  });

  it('intake tab: an unknown ?intake= value degrades to the seed tab, not a blank panel (#3904)', async () => {
    renderAt('/story-builder?intake=bogus');
    expect(await screen.findByLabelText('Universe / story name')).toBeTruthy();
    expect(screen.queryByLabelText('Universe name')).toBeNull();
  });
});

describe('StoryBuilder — detail stepper', () => {
  it('gates the Next button until the active step is locked', async () => {
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'Salt Run', currentStep: 'idea', seedIdea: 'seed',
      universeId: 'u1', seriesId: 's1', steps: mkSteps(), staleSteps: [],
    });
    renderAt('/story-builder/stb-1/idea');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Idea' })).toBeTruthy());
    // Idea not locked → primary action is "Lock & continue" and Next is blocked.
    expect(screen.getByText('Lock & continue')).toBeTruthy();
    const next = screen.getByRole('button', { name: /Next/i });
    expect(next.getAttribute('aria-disabled')).toBe('true');
  });

  it('explains WHY Next is blocked via title + an aria-describedby hint, and ignores clicks while blocked', async () => {
    // The step rail is un-gated, so a silently-dead "Next" reads as a bug. The
    // reason must reach mouse (title), keyboard and screen-reader users (#3908).
    const { fireEvent } = await import('@testing-library/react');
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'Salt Run', currentStep: 'idea', seedIdea: 'seed',
      universeId: 'u1', seriesId: 's1', steps: mkSteps(), staleSteps: [],
    });
    renderAt('/story-builder/stb-1/idea');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Idea' })).toBeTruthy());

    const next = screen.getByRole('button', { name: /Next/i });
    const reason = 'Lock this step to advance to the next step.';
    expect(next.getAttribute('title')).toBe(reason);
    const hint = document.getElementById(next.getAttribute('aria-describedby'));
    expect(hint.textContent).toBe(reason);
    // The accessible NAME is still "Next" — the reason is supplementary.
    expect(next.textContent).toContain('Next');

    // aria-disabled keeps it focusable, so the click handler must be inert.
    fireEvent.click(next);
    expect(api.setStoryCurrentStep).not.toHaveBeenCalled();
  });

  it('names staleness (not the lock) as the Next blocker when the locked step went stale', async () => {
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'Salt Run', currentStep: 'idea', seedIdea: 'seed',
      universeId: 'u1', seriesId: 's1', steps: mkSteps({ idea: { locked: true } }), staleSteps: ['idea'],
    });
    renderAt('/story-builder/stb-1/idea');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Idea' })).toBeTruthy());

    const next = screen.getByRole('button', { name: /Next/i });
    expect(next.getAttribute('aria-disabled')).toBe('true');
    expect(next.getAttribute('title')).toContain('re-lock this step');
    expect(document.getElementById(next.getAttribute('aria-describedby')).textContent)
      .toContain('re-lock this step');
  });

  it('drops the blocked state (and advances) once the step is locked and fresh', async () => {
    const { fireEvent } = await import('@testing-library/react');
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'Salt Run', currentStep: 'idea', seedIdea: 'seed',
      universeId: 'u1', seriesId: 's1', steps: mkSteps({ idea: { locked: true } }), staleSteps: [],
    });
    renderAt('/story-builder/stb-1/idea');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Idea' })).toBeTruthy());

    const next = screen.getByRole('button', { name: /Next/i });
    expect(next.getAttribute('aria-disabled')).toBeNull();
    expect(next.getAttribute('title')).toBe('Go to the next step.');

    await act(async () => { fireEvent.click(next); });
    await waitFor(() => expect(api.setStoryCurrentStep).toHaveBeenCalledWith('stb-1', 'universeAesthetic', expect.anything()));
  });

  it('shows "Generate reader map" when empty and "Re-generate" once content exists', async () => {
    // Empty reader map → first-run label.
    api.getPipelineSeries.mockResolvedValueOnce({ id: 's1', arc: { logline: 'AL', summary: 'AS', readerMap: null } });
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'X', currentStep: 'readerMap', universeId: 'u1', seriesId: 's1',
      steps: mkSteps({ idea: { locked: true }, universeAesthetic: { locked: true }, plotArc: { locked: true } }),
      staleSteps: [], llm: { provider: '', model: '' },
    });
    const { unmount } = renderAt('/story-builder/stb-1/readerMap');
    await waitFor(() => expect(screen.getByText('Generate reader map')).toBeTruthy());
    unmount();

    // Populated reader map → button flips to "Re-generate".
    api.getPipelineSeries.mockResolvedValue({ id: 's1', arc: { logline: 'AL', summary: 'AS', readerMap: { hooks: [{ id: 'rm-1', label: 'h' }] } } });
    renderAt('/story-builder/stb-1/readerMap');
    await waitFor(() => expect(screen.getByText('Re-generate')).toBeTruthy());
    expect(screen.queryByText('Generate reader map')).toBeNull();
  });

  it('plotArc step embeds the ArcCanvas once an arc exists, and shows the field summary before that', async () => {
    // No arc yet → read-only field summary, no embedded canvas.
    api.getPipelineSeries.mockResolvedValueOnce({ id: 's1', arc: { logline: '', summary: '' } });
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'X', currentStep: 'plotArc', universeId: 'u1', seriesId: 's1',
      steps: mkSteps({ idea: { locked: true }, universeAesthetic: { locked: true } }),
      staleSteps: [], llm: { provider: '', model: '' },
    });
    const { unmount } = renderAt('/story-builder/stb-1/plotArc');
    await waitFor(() => expect(screen.getByText('Generate plot arc')).toBeTruthy());
    expect(screen.queryByTestId('arc-canvas')).toBeNull();
    unmount();

    // Arc present + step unlocked → the ArcCanvas is embedded inline.
    api.getPipelineSeries.mockResolvedValue({ id: 's1', arc: { logline: 'AL', summary: 'AS' } });
    renderAt('/story-builder/stb-1/plotArc');
    await waitFor(() => expect(screen.getByTestId('arc-canvas')).toBeTruthy());
    expect(screen.getByTestId('arc-canvas').textContent).toContain('s1');
  });

  it('plotArc step does NOT embed the editable ArcCanvas when the step is locked', async () => {
    // ArcCanvas has no read-only mode and could edit (or internally unlock) a
    // locked arc, bypassing the "Unlock to revise" workflow — so a locked
    // plotArc must fall back to the read-only field summary, not the editor.
    api.getPipelineSeries.mockResolvedValue({ id: 's1', arc: { logline: 'AL', summary: 'AS' } });
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'X', currentStep: 'plotArc', universeId: 'u1', seriesId: 's1',
      steps: mkSteps({ idea: { locked: true }, universeAesthetic: { locked: true }, plotArc: { status: 'locked', locked: true } }),
      staleSteps: [], llm: { provider: '', model: '' },
    });
    renderAt('/story-builder/stb-1/plotArc');
    await waitFor(() => expect(screen.getByText('Arc logline')).toBeTruthy());
    expect(screen.queryByTestId('arc-canvas')).toBeNull();
  });

  it('readerMap step renders the beat timeline when the map has beats', async () => {
    api.getPipelineSeries.mockResolvedValue({
      id: 's1',
      arc: { logline: 'AL', summary: 'AS', readerMap: { beats: [{ id: 'rm-b1', kind: 'hook', atArcPosition: 0, intensity: 0.4 }, { id: 'rm-b2', kind: 'payoff', atArcPosition: 100, intensity: 0.9 }] } },
    });
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'X', currentStep: 'readerMap', universeId: 'u1', seriesId: 's1',
      steps: mkSteps({ idea: { locked: true }, universeAesthetic: { locked: true }, plotArc: { locked: true } }),
      staleSteps: [], llm: { provider: '', model: '' },
    });
    renderAt('/story-builder/stb-1/readerMap');
    await waitFor(() => expect(screen.getByText('Beat timeline')).toBeTruthy());
    expect(screen.getByLabelText(/beat timeline — 2 beats/i)).toBeTruthy();
  });

  it('"Lock & continue" locks the step AND auto-advances to the next', async () => {
    const { fireEvent } = await import('@testing-library/react');
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'Salt Run', currentStep: 'idea', seedIdea: 'seed',
      universeId: 'u1', seriesId: 's1', steps: mkSteps(), staleSteps: [], llm: { provider: '', model: '' },
    });
    renderAt('/story-builder/stb-1/idea');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Idea' })).toBeTruthy());
    fireEvent.click(screen.getByText('Lock & continue'));
    await waitFor(() => expect(api.lockStoryStep).toHaveBeenCalledWith('stb-1', 'idea', expect.anything()));
    // …then advances the current-step pointer to the next step (universeAesthetic).
    await waitFor(() => expect(api.setStoryCurrentStep).toHaveBeenCalledWith('stb-1', 'universeAesthetic', expect.anything()));
  });

  it('"Lock & continue" flushes the open Arc Canvas draft BEFORE locking the step', async () => {
    const { fireEvent } = await import('@testing-library/react');
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'Salt Run', currentStep: 'plotArc', seedIdea: 'seed',
      universeId: 'u1', seriesId: 's1',
      steps: mkSteps({ idea: { locked: true }, universeAesthetic: { locked: true } }),
      staleSteps: [], llm: { provider: '', model: '' },
    });
    renderAt('/story-builder/stb-1/plotArc');
    await waitFor(() => expect(screen.getByTestId('arc-canvas')).toBeTruthy());

    fireEvent.click(screen.getByText('Lock & continue'));
    await waitFor(() => expect(api.lockStoryStep).toHaveBeenCalledWith('stb-1', 'plotArc', expect.anything()));
    // Locking makes the step read-only (and unmounts the canvas), so the
    // pending draft has to land first or the edit is silently lost.
    expect(arcDraftFlush).toHaveBeenCalled();
    expect(arcDraftFlush.mock.invocationCallOrder[0])
      .toBeLessThan(api.lockStoryStep.mock.invocationCallOrder[0]);
  });

  it('"Unlock to revise" does NOT flush — unlocking re-opens the step, nothing to preserve', async () => {
    const { fireEvent } = await import('@testing-library/react');
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'Salt Run', currentStep: 'plotArc', seedIdea: 'seed',
      universeId: 'u1', seriesId: 's1',
      steps: mkSteps({ idea: { locked: true }, universeAesthetic: { locked: true }, plotArc: { locked: true } }),
      staleSteps: [], llm: { provider: '', model: '' },
    });
    renderAt('/story-builder/stb-1/plotArc');
    await waitFor(() => expect(screen.getByText('Unlock to revise')).toBeTruthy());

    fireEvent.click(screen.getByText('Unlock to revise'));
    await waitFor(() => expect(api.unlockStoryStep).toHaveBeenCalledWith('stb-1', 'plotArc', expect.anything()));
    expect(arcDraftFlush).not.toHaveBeenCalled();
  });

  it('manual step click: a rejected pointer move stays put and resyncs (no navigation)', async () => {
    const { fireEvent } = await import('@testing-library/react');
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'Salt Run', currentStep: 'idea', seedIdea: 'seed',
      universeId: 'u1', seriesId: 's1', steps: mkSteps(), staleSteps: [], llm: { provider: '', model: '' },
    });
    // Server re-gate rejects the pointer move (e.g. session deleted out-of-band).
    api.setStoryCurrentStep.mockRejectedValue(new Error('gate rejected'));
    renderAt('/story-builder/stb-1/idea');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Idea' })).toBeTruthy());
    const callsBefore = api.getStorySession.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: /Plot Arc/i }));
    await waitFor(() => expect(api.setStoryCurrentStep).toHaveBeenCalledWith('stb-1', 'plotArc', expect.anything()));
    // Rejection → the catch path toasts + resyncs (reload refetches the session),
    // and the URL never advances, so the heading stays on Idea instead of
    // stranding ahead of currentStep. The specific toast pins the rejection branch.
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Could not switch step'));
    expect(api.getStorySession.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(screen.getByRole('heading', { name: 'Idea' })).toBeTruthy();
  });

  it('"Lock & continue": a rejected pointer move keeps the lock but does not advance', async () => {
    const { fireEvent } = await import('@testing-library/react');
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'Salt Run', currentStep: 'idea', seedIdea: 'seed',
      universeId: 'u1', seriesId: 's1', steps: mkSteps(), staleSteps: [], llm: { provider: '', model: '' },
    });
    api.setStoryCurrentStep.mockRejectedValue(new Error('gate rejected'));
    renderAt('/story-builder/stb-1/idea');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Idea' })).toBeTruthy());
    fireEvent.click(screen.getByText('Lock & continue'));
    await waitFor(() => expect(api.lockStoryStep).toHaveBeenCalledWith('stb-1', 'idea', expect.anything()));
    // The auto-advance attempt fires…
    await waitFor(() => expect(api.setStoryCurrentStep).toHaveBeenCalledWith('stb-1', 'universeAesthetic', expect.anything()));
    // …but is rejected, so the catch path toasts (this specific message only
    // fires on the rejected pointer move, not the success path) and the URL
    // stays on Idea — navigation is gated on .then().
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Locked, but could not advance'));
    expect(screen.getByRole('heading', { name: 'Idea' })).toBeTruthy();
  });

  it('characters step: renders a per-character preview slot and generates a styled preview image', async () => {
    const { fireEvent } = await import('@testing-library/react');
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'X', currentStep: 'characters', universeId: 'u1', seriesId: 's1',
      steps: mkSteps({ idea: { locked: true }, universeAesthetic: { locked: true }, plotArc: { locked: true }, readerMap: { locked: true } }),
      staleSteps: [], llm: { provider: '', model: '' },
    });
    api.getUniverse.mockResolvedValue({
      id: 'u1', name: 'Giant', influences: { embrace: ['noir'], avoid: [] }, styleNotes: 'inky',
      characters: [{ id: 'ch1', name: 'Kessa', physicalDescription: 'tall, scarred', imageRefs: [] }],
    });
    renderAt('/story-builder/stb-1/characters');
    await waitFor(() => expect(screen.getByText('Kessa')).toBeTruthy());
    fireEvent.click(screen.getByTitle('Render image for this item'));
    await waitFor(() => expect(api.generateImage).toHaveBeenCalled());
    // The prompt fuses the character descriptor with the universe style.
    const arg = api.generateImage.mock.calls[0][0];
    expect(arg.prompt).toContain('Kessa');
    expect(arg.prompt.toLowerCase()).toContain('noir');
    // #1362: the render carries the durable universeRun.entryRef tag so the
    // server-side appendEntryImageRef hook files it — no client follow-up PATCH.
    expect(arg.universeRun).toEqual({
      universeId: 'u1',
      universeName: 'Giant',
      entryRef: { kind: 'canon', kindKey: 'characters', id: 'ch1' },
      label: 'Kessa',
      category: 'characters',
    });
    expect(api.updateUniverse).not.toHaveBeenCalled();
  });

  it('persists the provider/model picker choice to session.llm', async () => {
    const { fireEvent } = await import('@testing-library/react');
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'Salt Run', currentStep: 'idea', seedIdea: 'seed',
      universeId: 'u1', seriesId: 's1', steps: mkSteps(), staleSteps: [], llm: { provider: '', model: '' },
    });
    renderAt('/story-builder/stb-1/idea');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Idea' })).toBeTruthy());
    // The provider options load async (getProviders) — wait for the "Claude"
    // option to render before selecting it, or the <select> has no matching
    // option and resets the value to "".
    await waitFor(() => expect(screen.getByRole('option', { name: 'Claude' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('AI'), { target: { value: 'p1' } });
    await waitFor(() => expect(api.updateStorySession).toHaveBeenCalledWith(
      'stb-1', { llm: { provider: 'p1', model: null } }, expect.anything(),
    ));
  });

  it('shows the stale warning + "Unlock to revise" when an upstream step changed', async () => {
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'Salt Run', currentStep: 'readerMap', seedIdea: 'seed',
      universeId: 'u1', seriesId: 's1',
      steps: mkSteps({
        idea: { status: 'locked', locked: true },
        universeAesthetic: { status: 'locked', locked: true },
        plotArc: { status: 'locked', locked: true },
        readerMap: { status: 'locked', locked: true, upstreamHash: 'old' },
      }),
      staleSteps: ['readerMap'],
    });
    renderAt('/story-builder/stb-1/readerMap');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Reader Map' })).toBeTruthy());
    expect(screen.getByText(/re-review and re-lock/i)).toBeTruthy();
    // Locked step → the action flips to "Unlock to revise".
    expect(screen.getByText('Unlock to revise')).toBeTruthy();
  });

  it('cross-machine resume: toggles sync on and reveals the reconcile control (#730)', async () => {
    const { fireEvent } = await import('@testing-library/react');
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'Salt Run', currentStep: 'idea', seedIdea: 'seed',
      universeId: 'u1', seriesId: 's1', steps: mkSteps(), staleSteps: [], sync: false, syncDrift: false, llm: { provider: '', model: '' },
    });
    renderAt('/story-builder/stb-1/idea');
    await waitFor(() => expect(screen.getByText('Cross-machine resume off')).toBeTruthy());
    // Reconcile is hidden while sync is off (local-only sessions can't reconcile).
    expect(screen.queryByRole('button', { name: /Reconcile/i })).toBeNull();

    fireEvent.click(screen.getByText('Cross-machine resume off'));
    await waitFor(() => expect(api.setStorySessionSync).toHaveBeenCalledWith('stb-1', true, expect.objectContaining({ silent: true })));
    // Reactive: label flips and the reconcile control appears without a refetch.
    await waitFor(() => expect(screen.getByText('Cross-machine resume on')).toBeTruthy());
    expect(screen.getByRole('button', { name: /Reconcile/i })).toBeTruthy();
  });

  it('cross-machine resume: reconcile is enabled only when drift exists, and clears it (#730)', async () => {
    const { fireEvent } = await import('@testing-library/react');
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'Salt Run', currentStep: 'idea', seedIdea: 'seed',
      universeId: 'u1', seriesId: 's1', steps: mkSteps(), staleSteps: [], sync: true, syncDrift: true, llm: { provider: '', model: '' },
    });
    renderAt('/story-builder/stb-1/idea');
    await waitFor(() => expect(screen.getByText('Cross-machine resume on')).toBeTruthy());
    const reconcileBtn = screen.getByRole('button', { name: /Reconcile/i });
    expect(reconcileBtn.disabled).toBe(false);
    expect(screen.getByText(/drifted from the synced baseline/i)).toBeTruthy();

    fireEvent.click(reconcileBtn);
    await waitFor(() => expect(api.reconcileStorySession).toHaveBeenCalledWith('stb-1', expect.objectContaining({ silent: true })));
    // Drift clears reactively → message flips and the button disables.
    await waitFor(() => expect(screen.getByText(/Baseline matches this machine/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: /Reconcile/i }).disabled).toBe(true);
  });

  it('cross-machine resume: reconcile surfaces newly-stale steps from the recomputed view (#730)', async () => {
    const { fireEvent } = await import('@testing-library/react');
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'Salt Run', currentStep: 'readerMap',
      universeId: 'u1', seriesId: 's1',
      steps: mkSteps({
        idea: { locked: true }, universeAesthetic: { locked: true },
        plotArc: { locked: true }, readerMap: { status: 'locked', locked: true },
      }),
      staleSteps: [], sync: true, syncDrift: true, llm: { provider: '', model: '' },
    });
    // Reconcile adopts this machine's records → a locked step whose frozen hash
    // differs from the adopted baseline becomes stale; the route returns it.
    api.reconcileStorySession.mockResolvedValue({ id: 'stb-1', sync: true, staleSteps: ['readerMap'], syncDrift: false });
    renderAt('/story-builder/stb-1/readerMap');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Reader Map' })).toBeTruthy());
    // No stale warning before reconcile.
    expect(screen.queryByText(/re-review and re-lock/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Reconcile/i }));
    await waitFor(() => expect(api.reconcileStorySession).toHaveBeenCalled());
    // The recomputed view's staleSteps merges reactively → stale banner appears
    // without a full refetch.
    await waitFor(() => expect(screen.getByText(/re-review and re-lock/i)).toBeTruthy());
  });

  // #3905 — the step panel is keyed by the active step, so clicking the rail
  // mid-run used to unmount it, sever the SSE stream, and drop the completion
  // toast. The run now lives above the rail.
  it('a generate started on one step survives rail navigation and still toasts on completion', async () => {
    const { fireEvent } = await import('@testing-library/react');
    MockEventSource.reset();
    global.EventSource = MockEventSource;
    api.generateStoryStep.mockResolvedValue({ runId: 'run-1' });
    api.getPipelineSeries.mockResolvedValue({ id: 's1', arc: { logline: 'AL', summary: 'AS', readerMap: null } });
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'X', currentStep: 'readerMap', universeId: 'u1', seriesId: 's1',
      steps: mkSteps({ idea: { locked: true }, universeAesthetic: { locked: true }, plotArc: { locked: true } }),
      staleSteps: [], llm: { provider: '', model: '' },
    });
    renderAt('/story-builder/stb-1/readerMap');
    await waitFor(() => expect(screen.getByText('Generate reader map')).toBeTruthy());

    fireEvent.click(screen.getByText('Generate reader map'));
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));

    // Navigate the rail to another step — the panel unmounts.
    fireEvent.click(screen.getByRole('button', { name: /Characters/ }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Characters' })).toBeTruthy());
    expect(lastEventSource().closed).toBe(false);

    await act(async () => { lastEventSource().emit({ runId: 'run-1', type: 'complete' }); });
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Generated'));
    delete global.EventSource;
  });
});
