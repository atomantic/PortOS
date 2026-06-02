import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

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
}));
vi.mock('../services/api', () => api);

// The plotArc step embeds the full ArcCanvas roadmap editor; mock it to an
// inert sentinel so these tests assert the EMBEDDING (and its props) without
// pulling ArcCanvas's heavy import graph or its own API calls into scope.
vi.mock('../components/pipeline/ArcCanvas', () => ({
  default: ({ series }) => <div data-testid="arc-canvas">ArcCanvas[{series?.id}]</div>,
}));

import StoryBuilder from './StoryBuilder';

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/story-builder" element={<StoryBuilder />} />
      <Route path="/story-builder/:storyId/:step" element={<StoryBuilder />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
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
  api.getUniverse.mockResolvedValue({ id: 'u1', logline: 'L', premise: 'P', styleNotes: 'S', influences: { embrace: [], avoid: [] }, characters: [] });
  api.getPipelineSeries.mockResolvedValue({ id: 's1', arc: { logline: 'AL', summary: 'AS', readerMap: { hooks: [{ id: 'rm-1', label: 'Why?' }] } } });
  api.listPipelineIssues.mockResolvedValue([]);
});

describe('StoryBuilder — index', () => {
  it('renders the seed create form by default', async () => {
    renderAt('/story-builder');
    expect(await screen.findByLabelText('Universe / story name')).toBeTruthy();
    expect(screen.getByText('Start from an idea')).toBeTruthy();
    expect(screen.getByText('Import a finished work')).toBeTruthy();
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
});

describe('StoryBuilder — detail stepper', () => {
  it('gates the Next button until the active step is locked', async () => {
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'Salt Run', currentStep: 'idea', seedIdea: 'seed',
      universeId: 'u1', seriesId: 's1', steps: mkSteps(), staleSteps: [],
    });
    renderAt('/story-builder/stb-1/idea');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Idea' })).toBeTruthy());
    // Idea not locked → primary action is "Lock & continue" and Next is disabled.
    expect(screen.getByText('Lock & continue')).toBeTruthy();
    const next = screen.getByRole('button', { name: /Next/i });
    expect(next.disabled).toBe(true);
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
  });

  it('persists the provider/model picker choice to session.llm', async () => {
    const { fireEvent } = await import('@testing-library/react');
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'Salt Run', currentStep: 'idea', seedIdea: 'seed',
      universeId: 'u1', seriesId: 's1', steps: mkSteps(), staleSteps: [], llm: { provider: '', model: '' },
    });
    renderAt('/story-builder/stb-1/idea');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Idea' })).toBeTruthy());
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
});
