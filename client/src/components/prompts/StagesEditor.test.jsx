import { describe, it, expect, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import {
  api, renderPage, currentSearch, groupHeader, describeDetailAdmission, withNarrowLayout, chooser, toast, STAGES, SYSTEM_STAGES,
} from '../../test/promptManagerPageMocks.jsx';

const { getPrompts, getPrompt, getPromptUsage, savePrompt, previewPrompt, deletePrompt, createPrompt } = api;

describe('StagesEditor delete demotion', () => {
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
    await renderPage();
    await screen.findByText('Prompt Stages');
    fireEvent.click(groupHeader('Pipeline'));

    // Count buttons rather than probe for a label: a re-added row control
    // fails this however it happens to be named.
    const rows = screen.getByText('Pipeline — Prose Draft').closest('div[class*="space-y-1"]');
    expect(within(rows).getAllByRole('button')).toHaveLength(2);
    expect(within(rows).getByText('Pipeline — Comic Book Script')).toBeTruthy();
  });

  it('offers delete from the selected stage detail pane', async () => {
    await renderPage('/prompts/stages?stage=brain-classifier');
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
    await renderPage('/prompts/stages?stage=pipeline-comic-script');
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
    await renderPage('/prompts/stages?stage=pipeline-comic-script');
    await screen.findByText('Prompt Stages');

    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    expect(await screen.findByText('Delete Stage?')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: /^delete$/i }).at(-1));
    await waitFor(() => expect(deletePrompt).toHaveBeenCalledWith(
      'pipeline-comic-script', { force: false }, { silent: true },
    ));
  });
});

describe('StagesEditor stage save/create/delete feedback (#6022)', () => {
  beforeEach(() => {
    getPrompts.mockReset().mockResolvedValue({ stages: STAGES, systemStages: SYSTEM_STAGES });
    getPrompt.mockReset().mockResolvedValue({ name: 'Pipeline — Comic Book Script', template: 'body', variables: [] });
    getPromptUsage.mockReset().mockResolvedValue({
      isSystemStage: false, usedBy: [], referencedBy: [], canDelete: true,
    });
    savePrompt.mockReset().mockResolvedValue({ success: true });
    createPrompt.mockReset().mockResolvedValue({ success: true, stageName: 'my-new-stage' });
    deletePrompt.mockReset().mockResolvedValue({ success: true });
    toast.error.mockReset();
    toast.success.mockReset();
  });

  it('confirms a successful stage save with a named toast', async () => {
    await renderPage('/prompts/stages?stage=pipeline-comic-script');
    await screen.findByText('Prompt Stages');
    await screen.findByRole('button', { name: /^save$/i });

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Stage "Pipeline — Comic Book Script" saved'));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('confirms stage creation with a named toast and deep-links straight to the new stage', async () => {
    await renderPage('/prompts/stages');
    await screen.findByText('Prompt Stages');

    fireEvent.click(screen.getByRole('button', { name: 'New Stage' }));
    fireEvent.change(screen.getByPlaceholderText('my-stage'), { target: { value: 'my-new-stage' } });
    fireEvent.change(screen.getByPlaceholderText('Pipeline — My Stage'), { target: { value: 'My New Stage' } });
    fireEvent.click(screen.getByRole('button', { name: /create stage/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Stage "My New Stage" created'));
    await waitFor(() => expect(currentSearch()).toContain('stage=my-new-stage'));
  });

  it('confirms a successful stage delete with a named toast', async () => {
    await renderPage('/prompts/stages?stage=pipeline-comic-script');
    await screen.findByText('Prompt Stages');

    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    expect(await screen.findByText('Delete Stage?')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /^delete$/i }).at(-1));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Stage "pipeline-comic-script" deleted'));
  });
});

// Clicking another stage used to overwrite the editor outright, silently
// discarding whatever template/config edits the user had in flight (#6021).
// Mirrors the job-skill guard above (#3939).
describe('StagesEditor stage unsaved-edit guard', () => {
  beforeEach(() => {
    getPrompts.mockReset().mockResolvedValue({ stages: STAGES, systemStages: SYSTEM_STAGES });
    getPrompt.mockReset().mockImplementation((name) => Promise.resolve({
      name: STAGES[name]?.name || name,
      description: STAGES[name]?.description,
      template: `${name} template`,
      variables: [],
    }));
    savePrompt.mockReset().mockResolvedValue({ success: true });
    getPromptUsage.mockReset().mockResolvedValue({
      isSystemStage: false, usedBy: [], referencedBy: [], canDelete: true,
    });
    toast.error.mockReset();
    toast.success.mockReset();
  });

  const templateBox = () => screen.getByLabelText('Template');

  // A deep link expands the group holding the open stage, so the sibling row
  // under test is on screen without any manual disclosure click.
  const openDirtyEditor = async () => {
    await renderPage('/prompts/stages?stage=pipeline-prose-draft');
    await screen.findByDisplayValue('pipeline-prose-draft template');
    fireEvent.change(templateBox(), { target: { value: 'edited by hand' } });
    await screen.findByText('Unsaved changes');
  };

  it('marks the stage editor dirty once the template is modified', async () => {
    await renderPage('/prompts/stages?stage=pipeline-prose-draft');
    await screen.findByDisplayValue('pipeline-prose-draft template');
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect(screen.queryByText('Unsaved')).toBeNull();

    fireEvent.change(templateBox(), { target: { value: 'edited by hand' } });

    // Header badge and the list-row badge on the open stage.
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(screen.getByText('Unsaved')).toBeTruthy();
  });

  it('marks the editor dirty on a config-only change', async () => {
    await renderPage('/prompts/stages?stage=pipeline-prose-draft');
    await screen.findByDisplayValue('pipeline-prose-draft template');

    fireEvent.change(screen.getByLabelText('Model tier'), { target: { value: 'quick' } });

    expect(screen.getByText('Unsaved changes')).toBeTruthy();
  });

  it('treats an edit reverted to the loaded template as clean again', async () => {
    await openDirtyEditor();

    fireEvent.change(templateBox(), { target: { value: 'pipeline-prose-draft template' } });

    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('asks before discarding unsaved edits when another stage is clicked', async () => {
    await openDirtyEditor();

    fireEvent.click(screen.getByText('Pipeline — Comic Book Script'));

    expect(screen.getByText('Discard unsaved changes to "Pipeline — Prose Draft"?')).toBeTruthy();
    // Nothing switched yet: the URL, the fetch, and the typed text all hold.
    expect(currentSearch()).toContain('stage=pipeline-prose-draft');
    expect(getPrompt).not.toHaveBeenCalledWith('pipeline-comic-script', { silent: true });
    expect(screen.getByDisplayValue('edited by hand')).toBeTruthy();
  });

  it('keeps the edits when the discard prompt is cancelled', async () => {
    await openDirtyEditor();
    fireEvent.click(screen.getByText('Pipeline — Comic Book Script'));

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    expect(screen.queryByText(/Discard unsaved changes/)).toBeNull();
    expect(screen.getByDisplayValue('edited by hand')).toBeTruthy();
    expect(currentSearch()).toContain('stage=pipeline-prose-draft');
  });

  it('switches stages after the discard is confirmed', async () => {
    await openDirtyEditor();
    fireEvent.click(screen.getByText('Pipeline — Comic Book Script'));

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(currentSearch()).toContain('stage=pipeline-comic-script'));
    await screen.findByDisplayValue('pipeline-comic-script template');
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('switches without prompting once the edits are saved', async () => {
    await openDirtyEditor();

    // Exact match: the dirty list row is labelled "… Unsaved", which /save/i
    // would also match.
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(savePrompt).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());

    fireEvent.click(screen.getByText('Pipeline — Comic Book Script'));

    expect(screen.queryByText(/Discard unsaved changes/)).toBeNull();
    await waitFor(() => expect(currentSearch()).toContain('stage=pipeline-comic-script'));
  });

  it('drops the armed prompt when the edit is undone back to the saved template', async () => {
    await openDirtyEditor();
    fireEvent.click(screen.getByText('Pipeline — Comic Book Script'));
    expect(screen.getByText(/Discard unsaved changes/)).toBeTruthy();

    fireEvent.change(templateBox(), { target: { value: 'pipeline-prose-draft template' } });

    expect(screen.queryByText(/Discard unsaved changes/)).toBeNull();
    // The row the question had taken over comes back.
    expect(screen.getByText('Pipeline — Comic Book Script')).toBeTruthy();
  });

  it('backs out of the prompt when the already-open stage is re-clicked', async () => {
    await openDirtyEditor();
    fireEvent.click(screen.getByText('Pipeline — Comic Book Script'));

    // By role, not text: the editor heading renders the same label.
    fireEvent.click(screen.getByRole('button', { name: /Pipeline — Prose Draft/ }));

    expect(screen.queryByText(/Discard unsaved changes/)).toBeNull();
    expect(currentSearch()).toContain('stage=pipeline-prose-draft');
    expect(screen.getByDisplayValue('edited by hand')).toBeTruthy();
  });

  it('does not prompt when a clean editor switches stages', async () => {
    await renderPage('/prompts/stages?stage=pipeline-prose-draft');
    await screen.findByDisplayValue('pipeline-prose-draft template');

    fireEvent.click(await screen.findByText('Pipeline — Comic Book Script'));

    expect(screen.queryByText(/Discard unsaved changes/)).toBeNull();
    await waitFor(() => expect(currentSearch()).toContain('stage=pipeline-comic-script'));
    await screen.findByDisplayValue('pipeline-comic-script template');
  });
});

describeDetailAdmission({
  kind: 'stage', entry: '/prompts/stages?stage=pipeline-prose-draft', detail: getPrompt, save: savePrompt, preview: previewPrompt,
  label: 'Template', first: 'pipeline-prose-draft', second: 'pipeline-comic-script', secondLabel: 'Pipeline — Comic Book Script', param: 'stage',
});

describe('StagesEditor unavailable catalogue (#11143)', () => {
  const down = () => Promise.reject(new Error('503'));

  beforeEach(() => {
    getPrompt.mockReset().mockResolvedValue({ name: 'Pipeline — Prose Draft', template: 'body', variables: [] });
    getPromptUsage.mockReset().mockResolvedValue({ isSystemStage: false, usedBy: [], referencedBy: [], canDelete: true });
  });

  it('names a failed stage catalogue without claiming the deep-linked stage was deleted, and recovers on Retry', async () => {
    getPrompts.mockReset().mockImplementationOnce(down).mockResolvedValue({ stages: STAGES, systemStages: SYSTEM_STAGES });
    await renderPage('/prompts/stages?stage=pipeline-prose-draft');
    await screen.findByText(/Stages are unavailable/);
    expect(screen.queryByText('No prompt stages found')).toBeNull();
    expect(screen.queryByText(/could not be found/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry stages' }));
    await screen.findByText('4 stages');
    expect(screen.queryByText(/Stages are unavailable/)).toBeNull();
  });
});

describe('StagesEditor narrow layout (#11142)', () => {
  withNarrowLayout();

  beforeEach(() => {
    getPrompt.mockReset().mockImplementation((name) => Promise.resolve({
      name: STAGES[name]?.name || name, description: STAGES[name]?.description, template: `${name} template`, variables: [],
    }));
  });

  it('leads with the selected stage editor and keeps the catalogue out of the page flow', async () => {
    await renderPage('/prompts/stages?stage=pipeline-prose-draft');
    await screen.findByDisplayValue('pipeline-prose-draft template');

    expect(screen.getByRole('button', { name: /^save$/i })).toBeTruthy();
    expect(screen.queryByLabelText('Search prompt stages')).toBeNull();
    expect(chooser('stage')).toBeTruthy();
  });

  it('opens the catalogue in a drawer, keeps unsaved edits, and switches stage from it', async () => {
    await renderPage('/prompts/stages?stage=pipeline-prose-draft');
    await screen.findByDisplayValue('pipeline-prose-draft template');
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'edited by hand' } });

    fireEvent.click(chooser('stage'));
    const drawer = screen.getByRole('dialog', { name: 'Prompt Stages' });
    expect(within(drawer).getByLabelText('Search prompt stages')).toBeTruthy();
    // Opening the chooser alone must not touch the edit.
    expect(screen.getByLabelText('Template').value).toBe('edited by hand');

    // The unsaved-edit guard runs inside the drawer, in the clicked row's slot.
    fireEvent.click(within(drawer).getByText('Pipeline — Comic Book Script'));
    expect(within(drawer).getByText(/Discard unsaved changes/)).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Template').value).toBe('edited by hand');

    fireEvent.click(within(drawer).getByText('Pipeline — Comic Book Script'));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Discard' }));
    await screen.findByDisplayValue('pipeline-comic-script template');
    expect(currentSearch()).toContain('stage=pipeline-comic-script');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the catalogue alone when nothing is selected', async () => {
    await renderPage('/prompts/stages');
    expect(await screen.findByLabelText('Search prompt stages')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Choose another/ })).toBeNull();
    expect(screen.queryByText('Select a stage to edit')).toBeNull();
  });

  it('offers Retry in the active workspace when the selected stage fails to load', async () => {
    getPrompt.mockReset().mockRejectedValue(new Error('boom'));
    await renderPage('/prompts/stages?stage=pipeline-prose-draft');
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByLabelText('Search prompt stages')).toBeNull();
  });
});
