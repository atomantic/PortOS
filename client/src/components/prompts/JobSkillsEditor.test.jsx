import { describe, it, expect, beforeEach } from 'vitest';
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import {
  api, renderPage, currentSearch, currentPathname, promptTab, describeDetailAdmission, withNarrowLayout, chooser, toast, STAGES, SYSTEM_STAGES,
} from '../../test/promptManagerPageMocks.jsx';

const { getPrompts, getJobSkills, getJobSkill, saveJobSkill, previewJobSkill } = api;

// Job skill selection lives in `?skill=` so the open editor is deep-linkable and
// survives a reload or a tab round-trip (#3936).
describe('JobSkillsEditor job skill selection', () => {
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
    await renderPage('/prompts/job-skills');
    await screen.findByText('code-fixer');

    fireEvent.click(screen.getByText('code-fixer'));

    await waitFor(() => expect(currentSearch()).toContain('skill=code-fixer'));
    expect(currentPathname()).toBe('/prompts/job-skills');
    await screen.findByText('Job code-fixer');
  });

  it('loads the skill named by a deep link on mount', async () => {
    await renderPage('/prompts/job-skills?skill=doc-writer');

    await screen.findByText('Job doc-writer');
    expect(getJobSkill).toHaveBeenCalledWith('doc-writer', { silent: true });
    expect(screen.getByDisplayValue('# doc-writer template')).toBeTruthy();
  });

  it('keeps the open skill editor across a tab round-trip', async () => {
    await renderPage('/prompts/job-skills?skill=code-fixer');
    await screen.findByText('Job code-fixer');

    fireEvent.click(promptTab(/variables/i));
    fireEvent.click(promptTab(/job skills/i));

    await screen.findByText('Job code-fixer');
    expect(currentSearch()).toContain('skill=code-fixer');
  });

  it('does not leave the previous skill rendered when the next fetch fails', async () => {
    await renderPage('/prompts/job-skills?skill=code-fixer');
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
    await renderPage('/prompts/job-skills');
    await screen.findByText('code-fixer');

    expect(getJobSkill).not.toHaveBeenCalled();
    expect(screen.getByText('Select a job skill to edit its prompt template')).toBeTruthy();
  });
});

// A failed PUT used to be swallowed entirely: the Save button re-enabled and the
// user believed the edit had persisted (#3937).
describe('JobSkillsEditor job skill save feedback', () => {
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
    await renderPage('/prompts/job-skills?skill=code-fixer');
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
describe('JobSkillsEditor job skill unsaved-edit guard', () => {
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
    await renderPage('/prompts/job-skills?skill=code-fixer');
    await screen.findByText('Job code-fixer');
    fireEvent.change(editor(), { target: { value: '# edited by hand' } });
    await screen.findByText('Unsaved changes');
  };

  it('marks the editor dirty once the template is modified', async () => {
    await renderPage('/prompts/job-skills?skill=code-fixer');
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

  it('drops the armed prompt when the edit is undone back to the saved text', async () => {
    await openDirtyEditor();
    fireEvent.click(screen.getByText('doc-writer'));
    expect(screen.getByText(/Discard unsaved changes/)).toBeTruthy();

    fireEvent.change(editor(), { target: { value: '# code-fixer template' } });

    expect(screen.queryByText(/Discard unsaved changes/)).toBeNull();
    expect(screen.getByText('doc-writer')).toBeTruthy();
  });

  it('does not re-arm the old prompt when the editor goes dirty a second time', async () => {
    await openDirtyEditor();
    fireEvent.click(screen.getByText('doc-writer'));
    fireEvent.change(editor(), { target: { value: '# code-fixer template' } });

    fireEvent.change(editor(), { target: { value: '# a different edit' } });

    // The question only ever appears in response to a click on another skill.
    expect(screen.queryByText(/Discard unsaved changes/)).toBeNull();
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
  });

  it('drops the armed prompt when the edits are saved instead of discarded', async () => {
    await openDirtyEditor();
    fireEvent.click(screen.getByText('doc-writer'));
    expect(screen.getByText(/Discard unsaved changes/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => expect(screen.queryByText(/Discard unsaved changes/)).toBeNull());
    expect(currentSearch()).toContain('skill=code-fixer');
  });

  it('disarms the prompt when the already-open skill is clicked', async () => {
    await openDirtyEditor();
    fireEvent.click(screen.getByText('doc-writer'));

    fireEvent.click(screen.getByText('code-fixer'));

    expect(screen.queryByText(/Discard unsaved changes/)).toBeNull();
    expect(screen.getByDisplayValue('# edited by hand')).toBeTruthy();
  });

  it('does not adopt an in-flight save as the next skill\'s baseline', async () => {
    let resolveSave;
    saveJobSkill.mockImplementationOnce(() => new Promise((r) => { resolveSave = r; }));
    await openDirtyEditor();

    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    // Switch away while the PUT is still open, then let it land.
    fireEvent.click(screen.getByText('doc-writer'));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await screen.findByText('Job doc-writer');
    resolveSave({ success: true });

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    // The old skill's text must not become the new skill's clean baseline.
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('never renders the outgoing skill\'s text or dirty badge under the new skill', async () => {
    await openDirtyEditor();
    fireEvent.click(screen.getByText('doc-writer'));

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    // Synchronously after the switch — before the fetch resolves — the editor is
    // already empty and clean rather than still showing code-fixer's edit.
    expect(screen.queryByDisplayValue('# edited by hand')).toBeNull();
    expect(screen.queryByText('Unsaved changes')).toBeNull();

    // Settle the in-flight load so the fetch's state updates land inside act().
    await screen.findByText('Job doc-writer');
  });

  it('drops a preview that resolves after the user switched skills', async () => {
    let resolvePreview;
    previewJobSkill.mockReset().mockImplementationOnce(() => new Promise((r) => { resolvePreview = r; }));
    await renderPage('/prompts/job-skills?skill=code-fixer');
    await screen.findByText('Job code-fixer');

    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    fireEvent.click(screen.getByText('doc-writer'));
    await screen.findByText('Job doc-writer');
    await act(async () => { resolvePreview({ preview: 'code-fixer rendered' }); });

    expect(screen.queryByText('code-fixer rendered')).toBeNull();
    expect(screen.getByText('Job doc-writer')).toBeTruthy();
  });

  it('does not prompt when a clean editor switches skills', async () => {
    await renderPage('/prompts/job-skills?skill=code-fixer');
    await screen.findByText('Job code-fixer');

    fireEvent.click(screen.getByText('doc-writer'));

    expect(screen.queryByText(/Discard unsaved changes/)).toBeNull();
    await waitFor(() => expect(currentSearch()).toContain('skill=doc-writer'));
  });

  it('disables Preview button while request is in flight and re-enables when complete', async () => {
    let resolvePreview;
    previewJobSkill.mockReset().mockImplementationOnce(() => new Promise((r) => { resolvePreview = r; }));
    await renderPage('/prompts/job-skills?skill=code-fixer');
    await screen.findByText('Job code-fixer');

    const previewBtn = screen.getByRole('button', { name: /preview/i });
    expect(previewBtn.disabled).toBe(false);

    fireEvent.click(previewBtn);
    expect(previewBtn.disabled).toBe(true);

    resolvePreview({ preview: 'latest preview content' });
    await waitFor(() => expect(previewBtn.disabled).toBe(false));
    expect(screen.getByText('latest preview content')).toBeTruthy();
  });

  it('sequences preview requests for the same skill and ignores stale out-of-order responses', async () => {
    let resolveFirst;
    let resolveSecond;
    let previewBtn;

    previewJobSkill
      .mockReset()
      .mockImplementationOnce(() => {
        fireEvent.click(previewBtn);
        return new Promise((r) => { resolveFirst = r; });
      })
      .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }));

    await renderPage('/prompts/job-skills?skill=code-fixer');
    await screen.findByText('Job code-fixer');

    previewBtn = screen.getByRole('button', { name: /preview/i });

    // Trigger first request (which synchronously triggers second request)
    fireEvent.click(previewBtn);

    // Resolve second request first
    resolveSecond({ preview: 'second response' });
    await waitFor(() => expect(screen.getByText('second response')).toBeTruthy());

    // Resolve first request later (stale out-of-order response)
    resolveFirst({ preview: 'stale first response' });

    // Verify stale response is ignored and second response remains rendered
    expect(screen.queryByText('stale first response')).toBeNull();
    expect(screen.getByText('second response')).toBeTruthy();
  });
});

describeDetailAdmission({
  kind: 'job skill', entry: '/prompts/job-skills?skill=code-fixer', detail: getJobSkill, save: saveJobSkill, preview: previewJobSkill,
  label: 'Skill Template (Markdown)', first: 'code-fixer', second: 'doc-writer', secondLabel: 'doc-writer', param: 'skill',
});

describe('JobSkillsEditor unavailable catalogue (#11143)', () => {
  const down = () => Promise.reject(new Error('503'));

  it('shows the genuine empty state for a successful empty skills read', async () => {
    getJobSkills.mockReset().mockResolvedValue({ skills: [] });
    await renderPage('/prompts/job-skills');
    await screen.findByText('No job skill templates found');
    expect(screen.queryByText(/Job skills are unavailable/)).toBeNull();
  });

  it('names a failed skills read instead of "No job skill templates found"', async () => {
    getJobSkills.mockReset().mockImplementation(down);
    await renderPage('/prompts/job-skills');
    await screen.findByText(/Job skills are unavailable/);
    expect(screen.queryByText('No job skill templates found')).toBeNull();
  });
});

describe('JobSkillsEditor narrow layout (#11142)', () => {
  withNarrowLayout();
  const SKILLS = [
    { name: 'code-fixer', jobId: 'job-code-fixer', hasTemplate: true },
    { name: 'doc-writer', jobId: 'job-doc-writer', hasTemplate: false },
  ];

  beforeEach(() => {
    getJobSkills.mockReset().mockResolvedValue({ skills: SKILLS });
    getJobSkill.mockReset().mockImplementation((name) => Promise.resolve({
      content: `# ${name} template`, jobName: `Job ${name}`, jobId: `job-${name}`, category: 'maintenance', interval: 'daily',
    }));
  });

  it('opens a job skill editor first with the skills behind the chooser', async () => {
    await renderPage('/prompts/job-skills?skill=code-fixer');
    await screen.findByDisplayValue('# code-fixer template');
    expect(screen.queryByText('doc-writer')).toBeNull();

    fireEvent.click(chooser('job skill'));
    fireEvent.click(within(screen.getByRole('dialog')).getByText('doc-writer'));
    await screen.findByDisplayValue('# doc-writer template');
    expect(currentSearch()).toContain('skill=doc-writer');
  });
});
