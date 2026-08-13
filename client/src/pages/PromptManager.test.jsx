import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import PromptManager from './PromptManager';
import toast from '../components/ui/Toast';

// The Stages pane is the subject: 100+ rows with no way to reach one (#3284).
// Only the list-shaping API calls need real fixtures; everything else resolves
// empty so the page mounts.
const getPrompts = vi.fn();
const getPrompt = vi.fn();
const getPromptUsage = vi.fn();
const deletePrompt = vi.fn();
const getPromptVariables = vi.fn();
const deletePromptVariable = vi.fn();
const getJobSkills = vi.fn(() => Promise.resolve({ skills: [] }));
const getJobSkill = vi.fn(() => Promise.resolve({}));
const saveJobSkill = vi.fn();
const previewJobSkill = vi.fn();

vi.mock('../services/apiPrompts', () => ({
  getPrompts: (...a) => getPrompts(...a),
  getPrompt: (...a) => getPrompt(...a),
  createPrompt: vi.fn(),
  savePrompt: vi.fn(),
  deletePrompt: (...a) => deletePrompt(...a),
  previewPrompt: vi.fn(),
  getPromptUsage: (...a) => getPromptUsage(...a),
  getPromptVariables: (...a) => getPromptVariables(...a),
  createPromptVariable: vi.fn(),
  savePromptVariable: vi.fn(),
  deletePromptVariable: (...a) => deletePromptVariable(...a),
  getJobSkills: (...a) => getJobSkills(...a),
  getJobSkill: (...a) => getJobSkill(...a),
  saveJobSkill: (...a) => saveJobSkill(...a),
  previewJobSkill: (...a) => previewJobSkill(...a),
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

// Surfaces the live search string so URL-driven selection can be asserted on.
const LocationProbe = () => {
  const { search } = useLocation();
  return <div data-testid="location-search">{search}</div>;
};

const renderPage = (entry = '/prompts') => render(
  <MemoryRouter initialEntries={[entry]}>
    <PromptManager />
    <LocationProbe />
  </MemoryRouter>,
);

const currentSearch = () => screen.getByTestId('location-search').textContent;

// File-level defaults so every describe mounts against the same empty-ish page;
// individual suites override only what they assert on.
beforeEach(() => {
  getPromptVariables.mockReset().mockResolvedValue({ variables: {} });
  deletePromptVariable.mockReset().mockResolvedValue({ success: true });
});

const searchBox = () => screen.getByLabelText('Search prompt stages');
const groupHeader = (label) => screen.getByRole('button', { name: new RegExp(`^${label}, \\d+ stages?$`, 'i') });

describe('PromptManager stage list', () => {
  beforeEach(() => {
    getPrompts.mockReset().mockResolvedValue({ stages: STAGES, systemStages: SYSTEM_STAGES });
    getPrompt.mockReset().mockResolvedValue({ name: 'Pipeline — Prose Draft', template: 'body', variables: [] });
    getPromptUsage.mockReset().mockResolvedValue({
      isSystemStage: false, usedBy: [], referencedBy: [], canDelete: true,
    });
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
    // Mirrors the exact wire body of GET /api/prompts/:stage/usage — pinned
    // server-side in server/routes/prompts.test.js.
    getPromptUsage.mockReset().mockResolvedValue({
      isSystemStage: true,
      usedBy: ['Brain thought classification'],
      referencedBy: ['server/services/brain.js'],
      canDelete: false,
    });
    deletePrompt.mockReset().mockResolvedValue({ success: true });
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

  // #3335: protection is wider than the SYSTEM badge. A pipeline stage carries
  // no badge but is still undeletable without ?force=true, so the dialog has to
  // warn AND the confirm has to send force — otherwise every delete 400s.
  it('warns and names the source files for a referenced non-system stage', async () => {
    getPromptUsage.mockResolvedValue({
      isSystemStage: false,
      usedBy: [],
      referencedBy: ['server/services/pipeline/textStages.js', 'server/services/pipeline/pipelineJudge.js'],
      canDelete: false,
    });
    renderPage('/prompts?stage=pipeline-comic-script');
    await screen.findByText('Prompt Stages');

    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));

    expect(await screen.findByText('Delete Referenced Stage?')).toBeTruthy();
    expect(screen.getByText('server/services/pipeline/textStages.js')).toBeTruthy();
    expect(screen.getByText('server/services/pipeline/pipelineJudge.js')).toBeTruthy();

    // The modal's confirm is the last "Delete" in the tree (the detail pane
    // keeps its own trigger mounted behind the backdrop).
    fireEvent.click(screen.getAllByRole('button', { name: /^delete$/i }).at(-1));
    await waitFor(() => expect(deletePrompt).toHaveBeenCalledWith(
      'pipeline-comic-script', { force: true }, { silent: true },
    ));
  });

  it('deletes a user-authored stage without force', async () => {
    getPromptUsage.mockResolvedValue({ isSystemStage: false, usedBy: [], referencedBy: [], canDelete: true });
    renderPage('/prompts?stage=pipeline-comic-script');
    await screen.findByText('Prompt Stages');

    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    expect(await screen.findByText('Delete Stage?')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: /^delete$/i }).at(-1));
    await waitFor(() => expect(deletePrompt).toHaveBeenCalledWith(
      'pipeline-comic-script', { force: false }, { silent: true },
    ));
  });
});

// #3935: the row trash icon used to fire DELETE on the first click, so a
// mis-click on a 14px target destroyed the variable with no undo.
describe('PromptManager variable deletion', () => {
  const VARIABLES = {
    'tone-guide': { name: 'Tone Guide', category: 'style', content: 'stay wry' },
    'house-style': { name: 'House Style', category: 'style', content: 'oxford comma' },
  };

  beforeEach(() => {
    getPrompts.mockReset().mockResolvedValue({ stages: STAGES, systemStages: SYSTEM_STAGES });
    getPromptVariables.mockResolvedValue({ variables: VARIABLES });
  });

  const openVariables = async () => {
    renderPage('/prompts?tab=variables');
    return screen.findByText('Tone Guide');
  };

  it('arms an inline confirm instead of deleting on the trash click', async () => {
    await openVariables();

    fireEvent.click(screen.getByLabelText('Delete variable Tone Guide'));

    expect(deletePromptVariable).not.toHaveBeenCalled();
    expect(screen.getByText('Delete "Tone Guide"?')).toBeTruthy();
    // Only the armed row confirms; its sibling stays a normal row.
    expect(screen.getByLabelText('Delete variable House Style')).toBeTruthy();
  });

  it('deletes only after the inline confirm', async () => {
    await openVariables();

    fireEvent.click(screen.getByLabelText('Delete variable Tone Guide'));
    fireEvent.click(within(screen.getByLabelText('Confirm delete variable Tone Guide'))
      .getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(deletePromptVariable).toHaveBeenCalledWith('tone-guide', { silent: true }));
  });

  it('leaves the variable intact when the confirm is cancelled', async () => {
    await openVariables();

    fireEvent.click(screen.getByLabelText('Delete variable Tone Guide'));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(deletePromptVariable).not.toHaveBeenCalled();
    expect(screen.queryByText('Delete "Tone Guide"?')).toBeNull();
    expect(screen.getByLabelText('Delete variable Tone Guide')).toBeTruthy();
  });

  it('arms one row at a time', async () => {
    await openVariables();

    fireEvent.click(screen.getByLabelText('Delete variable Tone Guide'));
    fireEvent.click(screen.getByLabelText('Delete variable House Style'));

    expect(screen.queryByText('Delete "Tone Guide"?')).toBeNull();
    expect(screen.getByText('Delete "House Style"?')).toBeTruthy();
  });
});

// Job skill selection lives in `?skill=` so the open editor is deep-linkable and
// survives a reload or a tab round-trip (#3936).
describe('PromptManager job skill selection', () => {
  const SKILLS = [
    { name: 'code-fixer', jobId: 'job-code-fixer', hasTemplate: true },
    { name: 'doc-writer', jobId: 'job-doc-writer', hasTemplate: false },
  ];

  beforeEach(() => {
    getPrompts.mockReset().mockResolvedValue({ stages: STAGES, systemStages: SYSTEM_STAGES });
    getJobSkills.mockReset().mockResolvedValue({ skills: SKILLS });
    getJobSkill.mockReset().mockImplementation((name) => Promise.resolve({
      content: `# ${name} template`,
      jobName: `Job ${name}`,
      jobId: `job-${name}`,
      category: 'maintenance',
      interval: 'daily',
    }));
  });

  it('writes the picked skill to the URL instead of local state', async () => {
    renderPage('/prompts?tab=job-skills');
    await screen.findByText('code-fixer');

    fireEvent.click(screen.getByText('code-fixer'));

    await waitFor(() => expect(currentSearch()).toContain('skill=code-fixer'));
    expect(currentSearch()).toContain('tab=job-skills');
    await screen.findByText('Job code-fixer');
  });

  it('loads the skill named by a deep link on mount', async () => {
    renderPage('/prompts?tab=job-skills&skill=doc-writer');

    await screen.findByText('Job doc-writer');
    expect(getJobSkill).toHaveBeenCalledWith('doc-writer', { silent: true });
    expect(screen.getByDisplayValue('# doc-writer template')).toBeTruthy();
  });

  it('keeps the open skill editor across a tab round-trip', async () => {
    renderPage('/prompts?tab=job-skills&skill=code-fixer');
    await screen.findByText('Job code-fixer');

    fireEvent.click(screen.getByRole('button', { name: /variables/i }));
    fireEvent.click(screen.getByRole('button', { name: /job skills/i }));

    await screen.findByText('Job code-fixer');
    expect(currentSearch()).toContain('skill=code-fixer');
  });

  it('does not leave the previous skill rendered when the next fetch fails', async () => {
    renderPage('/prompts?tab=job-skills&skill=code-fixer');
    await screen.findByText('Job code-fixer');

    getJobSkill.mockRejectedValueOnce(new Error('gone'));
    fireEvent.click(screen.getByText('doc-writer'));

    // The heading falls back to the raw param, and the editor is empty — never
    // the previous skill's template under the new skill's name.
    await screen.findByText('doc-writer', { selector: 'h3' });
    expect(screen.queryByDisplayValue('# code-fixer template')).toBeNull();
    expect(screen.queryByText('Job code-fixer')).toBeNull();
  });

  it('shows the placeholder when no skill is named in the URL', async () => {
    renderPage('/prompts?tab=job-skills');
    await screen.findByText('code-fixer');

    expect(getJobSkill).not.toHaveBeenCalled();
    expect(screen.getByText('Select a job skill to edit its prompt template')).toBeTruthy();
  });
});

// A failed PUT used to be swallowed entirely: the Save button re-enabled and the
// user believed the edit had persisted (#3937).
describe('PromptManager job skill save feedback', () => {
  const SKILLS = [{ name: 'code-fixer', jobId: 'job-code-fixer', hasTemplate: true }];

  beforeEach(() => {
    getPrompts.mockReset().mockResolvedValue({ stages: STAGES, systemStages: SYSTEM_STAGES });
    getJobSkills.mockReset().mockResolvedValue({ skills: SKILLS });
    getJobSkill.mockReset().mockResolvedValue({
      content: '# code-fixer template', jobName: 'Job code-fixer', jobId: 'job-code-fixer',
    });
    saveJobSkill.mockReset().mockResolvedValue({ success: true });
    previewJobSkill.mockReset().mockResolvedValue({ preview: 'rendered' });
    toast.error.mockReset();
    toast.success.mockReset();
  });

  const openEditor = async () => {
    renderPage('/prompts?tab=job-skills&skill=code-fixer');
    await screen.findByText('Job code-fixer');
  };

  it('toasts the failure message when the save rejects', async () => {
    saveJobSkill.mockRejectedValueOnce(new Error('boom'));
    await openEditor();

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to save job skill: boom'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('re-enables Save after a failure so the user can retry', async () => {
    saveJobSkill.mockRejectedValueOnce(new Error('boom'));
    await openEditor();

    const save = screen.getByRole('button', { name: /save/i });
    fireEvent.click(save);

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() => expect(save.disabled).toBe(false));
  });

  it('confirms a successful save', async () => {
    await openEditor();

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Job skill saved'));
    expect(saveJobSkill).toHaveBeenCalledWith('code-fixer', '# code-fixer template', { silent: true });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('toasts a failed preview instead of blanking the panel', async () => {
    previewJobSkill.mockRejectedValueOnce(new Error('nope'));
    await openEditor();

    fireEvent.click(screen.getByRole('button', { name: /preview/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to preview: nope'));
  });
});

// Clicking another skill used to overwrite the editor outright, silently
// discarding whatever the user had typed (#3939).
describe('PromptManager job skill unsaved-edit guard', () => {
  const SKILLS = [
    { name: 'code-fixer', jobId: 'job-code-fixer', hasTemplate: true },
    { name: 'doc-writer', jobId: 'job-doc-writer', hasTemplate: false },
  ];

  beforeEach(() => {
    getPrompts.mockReset().mockResolvedValue({ stages: STAGES, systemStages: SYSTEM_STAGES });
    getJobSkills.mockReset().mockResolvedValue({ skills: SKILLS });
    getJobSkill.mockReset().mockImplementation((name) => Promise.resolve({
      content: `# ${name} template`,
      jobName: `Job ${name}`,
      jobId: `job-${name}`,
    }));
    saveJobSkill.mockReset().mockResolvedValue({ success: true });
    toast.error.mockReset();
    toast.success.mockReset();
  });

  const editor = () => screen.getByLabelText('Skill Template (Markdown)');

  const openDirtyEditor = async () => {
    renderPage('/prompts?tab=job-skills&skill=code-fixer');
    await screen.findByText('Job code-fixer');
    fireEvent.change(editor(), { target: { value: '# edited by hand' } });
    await screen.findByText('Unsaved changes');
  };

  it('marks the editor dirty once the template is modified', async () => {
    renderPage('/prompts?tab=job-skills&skill=code-fixer');
    await screen.findByText('Job code-fixer');
    expect(screen.queryByText('Unsaved changes')).toBeNull();

    fireEvent.change(editor(), { target: { value: '# edited by hand' } });

    expect(screen.getByText('Unsaved changes')).toBeTruthy();
  });

  it('treats an edit reverted to the loaded text as clean again', async () => {
    await openDirtyEditor();

    fireEvent.change(editor(), { target: { value: '# code-fixer template' } });

    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('asks before discarding unsaved edits when another skill is clicked', async () => {
    await openDirtyEditor();

    fireEvent.click(screen.getByText('doc-writer'));

    expect(screen.getByText('Discard unsaved changes to "Job code-fixer"?')).toBeTruthy();
    // Nothing switched yet: the URL, the fetch, and the typed text all hold.
    expect(currentSearch()).toContain('skill=code-fixer');
    expect(getJobSkill).not.toHaveBeenCalledWith('doc-writer', { silent: true });
    expect(screen.getByDisplayValue('# edited by hand')).toBeTruthy();
  });

  it('keeps the edits when the discard prompt is cancelled', async () => {
    await openDirtyEditor();
    fireEvent.click(screen.getByText('doc-writer'));

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    expect(screen.queryByText(/Discard unsaved changes/)).toBeNull();
    expect(screen.getByDisplayValue('# edited by hand')).toBeTruthy();
    expect(currentSearch()).toContain('skill=code-fixer');
  });

  it('switches skills after the discard is confirmed', async () => {
    await openDirtyEditor();
    fireEvent.click(screen.getByText('doc-writer'));

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(currentSearch()).toContain('skill=doc-writer'));
    await screen.findByText('Job doc-writer');
    expect(screen.getByDisplayValue('# doc-writer template')).toBeTruthy();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('switches without prompting once the edits are saved', async () => {
    await openDirtyEditor();

    // Exact match: the dirty list row is labelled "… Unsaved", which /save/i
    // would also match.
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(screen.queryByText('Unsaved changes')).toBeNull();

    fireEvent.click(screen.getByText('doc-writer'));

    expect(screen.queryByText(/Discard unsaved changes/)).toBeNull();
    await waitFor(() => expect(currentSearch()).toContain('skill=doc-writer'));
  });

  it('does not prompt when a clean editor switches skills', async () => {
    renderPage('/prompts?tab=job-skills&skill=code-fixer');
    await screen.findByText('Job code-fixer');

    fireEvent.click(screen.getByText('doc-writer'));

    expect(screen.queryByText(/Discard unsaved changes/)).toBeNull();
    await waitFor(() => expect(currentSearch()).toContain('skill=doc-writer'));
  });
});
