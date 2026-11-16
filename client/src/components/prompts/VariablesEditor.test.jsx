import { describe, it, expect, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import {
  api, renderPage, currentSearch, promptTab, withNarrowLayout, chooser, toast, STAGES, SYSTEM_STAGES,
} from '../../test/promptManagerPageMocks.jsx';

const { getPrompts, getPromptVariables, createPromptVariable, savePromptVariable, deletePromptVariable } = api;

// #3935: the row trash icon used to fire DELETE on the first click, so a
// mis-click on a 14px target destroyed the variable with no undo.
describe('VariablesEditor variable deletion', () => {
  const VARIABLES = {
    'tone-guide': { name: 'Tone Guide', category: 'style', content: 'stay wry' },
    'house-style': { name: 'House Style', category: 'style', content: 'oxford comma' },
  };

  beforeEach(() => {
    getPrompts.mockReset().mockResolvedValue({ stages: STAGES, systemStages: SYSTEM_STAGES });
    getPromptVariables.mockResolvedValue({ variables: VARIABLES });
  });

  const openVariables = async () => {
    await renderPage('/prompts/variables');
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

// Saving a variable used to deselect it and blank the editor with no toast, so
// a successful save read as a crash; switching variables threw unsaved edits
// away silently (#6023).
describe('VariablesEditor variable editing', () => {
  const VARIABLES = {
    'tone-guide': { name: 'Tone Guide', category: 'style', content: 'stay wry' },
    'house-style': { name: 'House Style', category: 'style', content: 'oxford comma' },
  };

  beforeEach(() => {
    getPrompts.mockReset().mockResolvedValue({ stages: STAGES, systemStages: SYSTEM_STAGES });
    getPromptVariables.mockResolvedValue({ variables: VARIABLES });
    toast.success.mockReset();
  });

  const contentBox = () => screen.getByPlaceholderText('Variable content...');
  const saveButton = () => screen.getByRole('button', { name: /^save$/i });

  // Waits on the hydrated CONTENT, not just the heading: the heading renders
  // from the URL param a commit before the effect fills the form, so keying off
  // it makes every later assertion a race against an empty editor.
  const openVariable = async (key = 'tone-guide') => {
    await renderPage(`/prompts/variables?var=${key}`);
    await screen.findByDisplayValue(VARIABLES[key].content);
  };

  it('keeps the saved variable open in the editor and confirms with a toast', async () => {
    await openVariable();
    // Re-stub AFTER the mount load, so only the post-save refetch carries the
    // extra sibling — staging it with mockResolvedValueOnce instead would bake
    // in an assumption about how many times the page loads before the save.
    getPromptVariables.mockResolvedValue({ variables: { ...VARIABLES, 'aside-voice': { name: 'Aside Voice', content: 'wink' } } });

    fireEvent.change(contentBox(), { target: { value: 'stay dry' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Variable "Tone Guide" saved'));
    expect(savePromptVariable).toHaveBeenCalledWith(
      'tone-guide', expect.objectContaining({ content: 'stay dry' }), { silent: true },
    );
    // The refetch still carries the PRE-save content, so the editor must NOT be
    // re-hydrated from it, deselected, or blanked. The toast fires BEFORE that
    // refetch, so waiting on it asserts ahead of the very state change under
    // test — the sibling above is what makes the refresh's arrival observable,
    // and #6023 slips through this test unnoticed without it (#6189).
    await screen.findByText('Aside Voice');
    expect(currentSearch()).toContain('var=tone-guide');
    expect(screen.getByText('Edit: tone-guide')).toBeTruthy();
    expect(contentBox().value).toBe('stay dry');
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('selects the created variable in the URL and confirms with a toast', async () => {
    // The list only holds the new key after the post-create refetch, which is
    // what the URL waits for.
    getPromptVariables
      .mockResolvedValueOnce({ variables: VARIABLES })
      .mockResolvedValue({ variables: { ...VARIABLES, 'aside-voice': { name: 'Aside Voice', content: 'wink' } } });
    await renderPage('/prompts/variables');
    await screen.findByText('Tone Guide');

    fireEvent.change(screen.getByPlaceholderText('variableKey'), { target: { value: 'aside-voice' } });
    fireEvent.change(contentBox(), { target: { value: 'wink' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Variable "aside-voice" created'));
    expect(createPromptVariable).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'aside-voice', content: 'wink' }), { silent: true },
    );
    // Both halves in ONE barrier: neither settles last on its own (#6189).
    // The post-create refetch re-runs the hydration effect while the selection
    // is still null, which resets the form to BLANK — the URL adopts the new key
    // only afterwards, and re-hydrating from the refetched record is a further
    // commit still. So waiting on the URL alone reads a blanked textarea. But
    // waiting on the textarea alone is a barrier already open, since it holds
    // 'wink' from the typing above, leaving the URL as the racing read instead.
    await waitFor(() => {
      expect(currentSearch()).toContain('var=aside-voice');
      expect(contentBox().value).toBe('wink');
    });
    expect(screen.getByText('Edit: aside-voice')).toBeTruthy();
  });

  it('confirms a delete with a toast', async () => {
    await renderPage('/prompts/variables');
    await screen.findByText('Tone Guide');

    fireEvent.click(screen.getByLabelText('Delete variable Tone Guide'));
    fireEvent.click(within(screen.getByLabelText('Confirm delete variable Tone Guide'))
      .getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Variable "Tone Guide" deleted'));
  });

  it('asks before another variable replaces unsaved edits', async () => {
    await openVariable();
    fireEvent.change(contentBox(), { target: { value: 'stay dry' } });

    fireEvent.click(screen.getByText('House Style'));

    // Parked, not switched: the discard question takes over the clicked row.
    expect(screen.getByText('Discard unsaved changes to "Tone Guide"?')).toBeTruthy();
    expect(currentSearch()).toContain('var=tone-guide');
    expect(contentBox().value).toBe('stay dry');
  });

  it('keeps the edits when the discard prompt is cancelled', async () => {
    await openVariable();
    fireEvent.change(contentBox(), { target: { value: 'stay dry' } });
    fireEvent.click(screen.getByText('House Style'));

    fireEvent.click(screen.getByRole('button', { name: /^keep editing$/i }));

    expect(screen.queryByText('Discard unsaved changes to "Tone Guide"?')).toBeNull();
    expect(currentSearch()).toContain('var=tone-guide');
    expect(contentBox().value).toBe('stay dry');
    expect(screen.getByText('House Style')).toBeTruthy();
  });

  it('switches to the clicked variable once the discard is confirmed', async () => {
    await openVariable();
    fireEvent.change(contentBox(), { target: { value: 'stay dry' } });
    fireEvent.click(screen.getByText('House Style'));

    fireEvent.click(screen.getByRole('button', { name: /^discard$/i }));

    await screen.findByDisplayValue('oxford comma');
    expect(currentSearch()).toContain('var=house-style');
    expect(screen.getByText('Edit: house-style')).toBeTruthy();
  });

  it('asks before the add button discards an unsaved draft', async () => {
    await openVariable();
    fireEvent.change(contentBox(), { target: { value: 'stay dry' } });

    fireEvent.click(screen.getByLabelText('Add variable'));

    expect(screen.getByText('Discard unsaved changes to "Tone Guide"?')).toBeTruthy();
    expect(currentSearch()).toContain('var=tone-guide');

    fireEvent.click(screen.getByRole('button', { name: /^discard$/i }));

    await screen.findByText('New Variable');
    expect(currentSearch()).not.toContain('var=');
    expect(contentBox().value).toBe('');
  });

  it('does not ask when the edit is undone back to the saved value', async () => {
    await openVariable();
    fireEvent.change(contentBox(), { target: { value: 'stay dry' } });
    expect(screen.getByText('Unsaved changes')).toBeTruthy();

    fireEvent.change(contentBox(), { target: { value: 'stay wry' } });
    fireEvent.click(screen.getByText('House Style'));

    expect(screen.queryByText('Discard unsaved changes to "Tone Guide"?')).toBeNull();
    await waitFor(() => expect(currentSearch()).toContain('var=house-style'));
  });
});

describe('VariablesEditor unavailable catalogue (#11143)', () => {
  const SKILLS = [{ name: 'code-fixer', jobId: 'job-code-fixer', hasTemplate: true }];
  const VARS = { 'tone-guide': { name: 'Tone Guide', category: 'style', content: 'Be brief' } };
  const down = () => Promise.reject(new Error('503'));

  beforeEach(() => {
    getPromptVariables.mockReset().mockResolvedValue({ variables: VARS });
    api.getJobSkills.mockReset().mockResolvedValue({ skills: SKILLS });
    api.getJobSkill.mockReset().mockResolvedValue({ content: '# t', jobName: 'Job', jobId: 'job-code-fixer' });
  });

  it('keeps other catalogues usable when only the variables read fails', async () => {
    getPromptVariables.mockReset().mockImplementation(down);
    await renderPage('/prompts/variables?var=tone-guide');
    await screen.findByText(/Variables are unavailable/);
    expect(screen.queryByText(/could not be found/)).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Retry variables' }).length).toBe(2);
    // Skills were never touched.
    fireEvent.click(promptTab(/Job Skills/i));
    await screen.findByText('code-fixer');
    expect(screen.queryByText(/Job skills are unavailable/)).toBeNull();
  });

  it('keeps rows and the open variable when a refresh fails, flagging them stale', async () => {
    await renderPage('/prompts/variables?var=tone-guide');
    await screen.findByText('Edit: tone-guide');
    getPromptVariables.mockReset().mockImplementation(down);
    fireEvent.click(screen.getByLabelText('Reload'));
    await screen.findByText(/Variables may be out of date/);
    expect(screen.getByText('Edit: tone-guide')).toBeTruthy();
    expect(screen.getByText('Tone Guide')).toBeTruthy();

    getPromptVariables.mockReset().mockResolvedValue({ variables: VARS });
    fireEvent.click(screen.getByRole('button', { name: 'Retry variables' }));
    await waitFor(() => expect(screen.queryByText(/may be out of date/)).toBeNull());
  });
});

describe('VariablesEditor narrow layout (#11142)', () => {
  withNarrowLayout();
  const VARIABLES = {
    'tone-guide': { name: 'Tone Guide', category: 'style', content: 'stay wry' },
    'house-style': { name: 'House Style', category: 'style', content: 'oxford comma' },
  };

  beforeEach(() => {
    getPromptVariables.mockReset().mockResolvedValue({ variables: VARIABLES });
  });

  it('opens a variable editor first, and a blank draft from the catalogue add button', async () => {
    await renderPage('/prompts/variables');
    await screen.findByText('Tone Guide');
    expect(screen.queryByPlaceholderText('Variable content...')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Add variable' }));
    expect(screen.getByText('New Variable')).toBeTruthy();
    expect(screen.queryByText('Tone Guide')).toBeNull();

    fireEvent.click(chooser('variable'));
    const drawer = screen.getByRole('dialog', { name: 'Variables' });
    fireEvent.click(within(drawer).getByText('House Style'));
    await screen.findByDisplayValue('oxford comma');
    expect(currentSearch()).toContain('var=house-style');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
