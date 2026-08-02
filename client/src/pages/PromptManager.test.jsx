import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PromptManager from './PromptManager';

// The Stages pane is the subject: 100+ rows with no way to reach one (#3284).
// Only the list-shaping API calls need real fixtures; everything else resolves
// empty so the page mounts.
const getPrompts = vi.fn();
const getPrompt = vi.fn();
const getPromptUsage = vi.fn();

vi.mock('../services/apiPrompts', () => ({
  getPrompts: (...a) => getPrompts(...a),
  getPrompt: (...a) => getPrompt(...a),
  createPrompt: vi.fn(),
  savePrompt: vi.fn(),
  deletePrompt: vi.fn(),
  previewPrompt: vi.fn(),
  getPromptUsage: (...a) => getPromptUsage(...a),
  getPromptVariables: vi.fn(() => Promise.resolve({ variables: {} })),
  createPromptVariable: vi.fn(),
  savePromptVariable: vi.fn(),
  deletePromptVariable: vi.fn(),
  getJobSkills: vi.fn(() => Promise.resolve({ skills: [] })),
  getJobSkill: vi.fn(),
  saveJobSkill: vi.fn(),
  previewJobSkill: vi.fn(),
}));

vi.mock('../services/apiProviders', () => ({
  getProviders: vi.fn(() => Promise.resolve({ providers: [], activeProvider: null })),
}));

vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const STAGES = {
  'pipeline-prose-draft': { name: 'Pipeline — Prose Draft', description: 'Draft the prose' },
  'pipeline-comic-script': { name: 'Pipeline — Comic Book Script', description: 'Panels and balloons' },
  'creative-director-treatment': { name: 'Creative Director — Treatment', description: 'Treatment doc' },
  'brain-classifier': { name: 'Brain Classifier', description: 'Classify a thought' },
};

// The system-stage list is served, not mirrored client-side (#3314) — the page
// badges and filters exactly what GET /api/prompts names in `systemStages`.
const SYSTEM_STAGES = ['brain-classifier'];

const renderPage = (entry = '/prompts') => render(
  <MemoryRouter initialEntries={[entry]}>
    <PromptManager />
  </MemoryRouter>,
);

const searchBox = () => screen.getByLabelText('Search prompt stages');
const groupHeader = (label) => screen.getByRole('button', { name: new RegExp(`^${label}, \\d+ stages?$`, 'i') });

describe('PromptManager stage list', () => {
  beforeEach(() => {
    getPrompts.mockReset().mockResolvedValue({ stages: STAGES, systemStages: SYSTEM_STAGES });
    getPrompt.mockReset().mockResolvedValue({ name: 'Pipeline — Prose Draft', template: 'body', variables: [] });
    getPromptUsage.mockReset().mockResolvedValue({ isSystemStage: false, usedBy: [] });
  });

  it('shows collapsed groups and a stage count instead of a flat 100-row list', async () => {
    renderPage();
    await screen.findByText('Prompt Stages');

    // Group headers, not rows.
    expect(groupHeader('Pipeline')).toBeTruthy();
    expect(groupHeader('Brain').getAttribute('aria-label')).toBe('Brain, 1 stage');
    expect(groupHeader('Pipeline').getAttribute('aria-label')).toBe('Pipeline, 2 stages');
    expect(screen.getByText('4 stages')).toBeTruthy();
    expect(screen.queryByText('Pipeline — Prose Draft')).toBeNull();
  });

  it('expands and re-collapses a group on click', async () => {
    renderPage();
    await screen.findByText('Prompt Stages');

    const header = groupHeader('Pipeline');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Pipeline — Prose Draft')).toBeTruthy();

    fireEvent.click(header);
    expect(screen.queryByText('Pipeline — Prose Draft')).toBeNull();
  });

  it('filters rows on the title as the user types, auto-revealing matches', async () => {
    renderPage();
    await screen.findByText('Prompt Stages');

    fireEvent.change(searchBox(), { target: { value: 'comic' } });

    // No manual expand needed — a filtered group shows its matches.
    expect(screen.getByText('Pipeline — Comic Book Script')).toBeTruthy();
    expect(screen.queryByText('Pipeline — Prose Draft')).toBeNull();
    expect(screen.queryByText('Brain Classifier')).toBeNull();
    expect(screen.getByText('1 of 4')).toBeTruthy();
  });

  it('keeps the group toggle live while filtering so a broad query can be folded', async () => {
    renderPage();
    await screen.findByText('Prompt Stages');

    // A query matching everything must not become an uncollapsible wall.
    fireEvent.change(searchBox(), { target: { value: 'e' } });
    expect(screen.getByText('4 of 4')).toBeTruthy();
    expect(groupHeader('Pipeline').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Pipeline — Prose Draft')).toBeTruthy();

    fireEvent.click(groupHeader('Pipeline'));
    expect(groupHeader('Pipeline').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Pipeline — Prose Draft')).toBeNull();
    // Folding one group leaves the others open.
    expect(screen.getByText('Brain Classifier')).toBeTruthy();
  });

  it('forgets a filter-scoped collapse once the filter clears', async () => {
    renderPage();
    await screen.findByText('Prompt Stages');

    fireEvent.change(searchBox(), { target: { value: 'e' } });
    fireEvent.click(groupHeader('Pipeline'));
    expect(groupHeader('Pipeline').getAttribute('aria-expanded')).toBe('false');

    // Clearing returns to the collapsed-by-default view...
    fireEvent.change(searchBox(), { target: { value: '' } });
    expect(groupHeader('Pipeline').getAttribute('aria-expanded')).toBe('false');
    // ...and the stale fold does not carry into the NEXT filter session. This
    // is the assertion that actually observes the set — while no filter is on,
    // `collapsedWhileFiltering` is never read, so clearing it is invisible.
    fireEvent.change(searchBox(), { target: { value: 'e' } });
    expect(groupHeader('Pipeline').getAttribute('aria-expanded')).toBe('true');
  });

  it('drops a fold when the query is refined, so the new match cannot hide behind it', async () => {
    renderPage();
    await screen.findByText('Prompt Stages');

    fireEvent.change(searchBox(), { target: { value: 'e' } });
    fireEvent.click(groupHeader('Pipeline'));
    expect(screen.queryByText('Pipeline — Comic Book Script')).toBeNull();

    // Refining to a query whose ONLY hit lives in the folded group must show it.
    fireEvent.change(searchBox(), { target: { value: 'comic' } });
    expect(screen.getByText('1 of 4')).toBeTruthy();
    expect(screen.getByText('Pipeline — Comic Book Script')).toBeTruthy();
  });

  it('drops a fold when the SYSTEM toggle changes the filter', async () => {
    renderPage();
    await screen.findByText('Prompt Stages');

    fireEvent.change(searchBox(), { target: { value: 'e' } });
    fireEvent.click(groupHeader('Brain'));
    expect(screen.queryByText('Brain Classifier')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /system only/i }));
    expect(screen.getByText('Brain Classifier')).toBeTruthy();
  });

  it('folds two spellings of the same family into one group', async () => {
    getPrompts.mockResolvedValue({
      stages: {
        ...STAGES,
        'pipeline-lowercase': { name: 'pipeline — hand typed', description: 'user made' },
      },
      systemStages: SYSTEM_STAGES,
    });
    renderPage();
    await screen.findByText('Prompt Stages');

    // One PIPELINE header, holding all three — not two headers that render alike.
    expect(screen.getAllByRole('button', { name: /^Pipeline, \d+ stages?$/i })).toHaveLength(1);
    fireEvent.click(groupHeader('Pipeline'));
    expect(screen.getByText('pipeline — hand typed')).toBeTruthy();
    expect(screen.getByText('Pipeline — Prose Draft')).toBeTruthy();
  });

  it('filters on the description too', async () => {
    renderPage();
    await screen.findByText('Prompt Stages');

    fireEvent.change(searchBox(), { target: { value: 'balloons' } });
    expect(screen.getByText('Pipeline — Comic Book Script')).toBeTruthy();
    expect(screen.getByText('1 of 4')).toBeTruthy();
  });

  it('reports an empty result rather than a silently blank pane', async () => {
    renderPage();
    await screen.findByText('Prompt Stages');

    fireEvent.change(searchBox(), { target: { value: 'zzzz' } });
    expect(screen.getByText('No stages match that search')).toBeTruthy();
  });

  it('clears the query from the clear button', async () => {
    renderPage();
    await screen.findByText('Prompt Stages');

    fireEvent.change(searchBox(), { target: { value: 'comic' } });
    fireEvent.click(screen.getByLabelText('Clear stage search'));

    expect(searchBox().value).toBe('');
    expect(screen.getByText('4 stages')).toBeTruthy();
    // Rows the filter revealed go back into their collapsed groups.
    expect(screen.queryByText('Pipeline — Comic Book Script')).toBeNull();
  });

  it('narrows to system stages with the SYSTEM-only toggle', async () => {
    renderPage();
    await screen.findByText('Prompt Stages');

    const toggle = screen.getByRole('button', { name: /system only/i });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Brain Classifier')).toBeTruthy();
    expect(screen.queryByText('Pipeline — Prose Draft')).toBeNull();
    expect(screen.getByText('1 of 4')).toBeTruthy();
  });

  // The badge and the filter follow the SERVED list, not a client-side copy of
  // it (#3314) — a stage the server names is reachable even though no hardcoded
  // client array ever mentioned it.
  it('badges and filters whatever the server names in systemStages', async () => {
    getPrompts.mockResolvedValue({ stages: STAGES, systemStages: ['creative-director-treatment'] });
    renderPage();
    await screen.findByText('Prompt Stages');

    fireEvent.click(screen.getByRole('button', { name: /system only/i }));
    expect(screen.getByText('Creative Director — Treatment')).toBeTruthy();
    expect(screen.queryByText('Brain Classifier')).toBeNull();
    expect(screen.getByText('1 of 4')).toBeTruthy();
    expect(screen.getAllByText('System')).toHaveLength(1);
  });

  // An older server (or a failed load) sends no list: badge nothing, filter to
  // nothing — never crash on a missing key.
  it('degrades to no system stages when the server omits the list', async () => {
    getPrompts.mockResolvedValue({ stages: STAGES });
    renderPage();
    await screen.findByText('Prompt Stages');

    fireEvent.click(screen.getByRole('button', { name: /system only/i }));
    expect(screen.getByText('No stages match that search')).toBeTruthy();
    expect(screen.getByText('0 of 4')).toBeTruthy();
  });

  it('selects a stage into the URL from a filtered row', async () => {
    renderPage();
    await screen.findByText('Prompt Stages');

    fireEvent.change(searchBox(), { target: { value: 'comic' } });
    fireEvent.click(screen.getByText('Pipeline — Comic Book Script'));

    await waitFor(() => expect(getPrompt).toHaveBeenCalledWith('pipeline-comic-script', { silent: true }));
  });

  it('opens the group holding a deep-linked stage', async () => {
    renderPage('/prompts?stage=brain-classifier');
    await screen.findByText('Prompt Stages');

    await waitFor(() => expect(groupHeader('Brain').getAttribute('aria-expanded')).toBe('true'));
    expect(screen.getByText('Brain Classifier')).toBeTruthy();
    // Sibling groups stay closed.
    expect(groupHeader('Pipeline').getAttribute('aria-expanded')).toBe('false');
  });
});

describe('PromptManager delete demotion', () => {
  beforeEach(() => {
    getPrompts.mockReset().mockResolvedValue({ stages: STAGES, systemStages: SYSTEM_STAGES });
    getPrompt.mockReset().mockResolvedValue({ name: 'Brain Classifier', template: 'body', variables: [] });
    getPromptUsage.mockReset().mockResolvedValue({ isSystemStage: true, usedBy: ['Brain thought classification'] });
  });

  it('keeps delete — or any other control — out of the list rows entirely', async () => {
    renderPage();
    await screen.findByText('Prompt Stages');
    fireEvent.click(groupHeader('Pipeline'));

    // Count buttons rather than probe for a label: a re-added row control
    // fails this however it happens to be named.
    const rows = screen.getByText('Pipeline — Prose Draft').closest('div[class*="space-y-1"]');
    expect(within(rows).getAllByRole('button')).toHaveLength(2);
    expect(within(rows).getByText('Pipeline — Comic Book Script')).toBeTruthy();
  });

  it('offers delete from the selected stage detail pane', async () => {
    renderPage('/prompts?stage=brain-classifier');
    await screen.findByText('Prompt Stages');

    const del = await screen.findByRole('button', { name: /^delete$/i });
    fireEvent.click(del);

    await waitFor(() => expect(getPromptUsage).toHaveBeenCalledWith('brain-classifier', { silent: true }));
    expect(await screen.findByText('Delete System Stage?')).toBeTruthy();
  });
});
