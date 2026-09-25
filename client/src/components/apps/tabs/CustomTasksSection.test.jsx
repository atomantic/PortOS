import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getCosJobs: vi.fn(),
  getProviders: vi.fn(),
  createCosJob: vi.fn(),
  updateCosJob: vi.fn(),
  triggerCosJob: vi.fn(),
  toggleCosJob: vi.fn(),
  getSettings: vi.fn()
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('../../../services/api', () => api);
vi.mock('../../../services/apiLocalLlm', async (importOriginal) => ({
  ...await importOriginal(),
  getToolUseModels: vi.fn().mockResolvedValue({ models: [] }),
}));
vi.mock('../../ui/Toast', () => ({ default: toast }));

import CustomTasksSection, { emptyForm, formFromJob, toPayload } from './CustomTasksSection';

const task = {
  id: 'job-1',
  appId: 'app-1',
  name: 'Example Task',
  description: 'A short card summary',
  enabled: true,
  type: 'agent',
  interval: 'daily',
  promptTemplate: 'Do the thing',
  providerId: 'claude-code',
  model: 'claude-sonnet',
  effort: 'high',
  dataInputs: ['project-goals'],
  runCount: 0
};

describe('CustomTasksSection trigger outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getCosJobs.mockResolvedValue({
      jobs: [task],
      dataInputCatalog: [
        { id: 'project-goals', label: 'Project goals', description: 'Include GOALS.md.' },
        { id: 'open-issues', label: 'Open issues', description: 'Include open issues.' },
      ]
    });
    api.getProviders.mockResolvedValue({
      activeProvider: 'claude-code',
      providers: [{
        id: 'claude-code',
        name: 'Claude',
        type: 'cli',
        enabled: true,
        defaultModel: 'claude-sonnet',
        models: ['claude-sonnet']
      }, {
        id: 'codex',
        name: 'Codex',
        type: 'cli',
        enabled: true,
        defaultModel: 'gpt-5',
        models: ['gpt-5']
      }]
    });
    api.getSettings.mockResolvedValue({ timezone: 'UTC' });
  });

  it('includes the app scope and all AI overrides, including explicit clears', () => {
    const form = {
      ...emptyForm(),
      name: 'Example Task',
      promptTemplate: 'Do the thing',
      providerId: 'claude-code',
      model: 'claude-sonnet',
      effort: 'high',
      dataInputs: ['project-goals']
    };

    expect(toPayload(form, 'app-1')).toEqual(expect.objectContaining({
      type: 'agent',
      appId: 'app-1',
      providerId: 'claude-code',
      model: 'claude-sonnet',
      effort: 'high',
      dataInputs: ['project-goals']
    }));
    expect(toPayload({ ...form, providerId: '', model: '', effort: '' }, 'app-1')).toEqual(
      expect.objectContaining({ providerId: null, model: null, effort: null })
    );
  });

  it('keeps saved provider/model/effort pins in edit state until the user changes them', () => {
    expect(formFromJob(task)).toEqual(expect.objectContaining({
      providerId: 'claude-code',
      model: 'claude-sonnet',
      effort: 'high'
    }));
  });

  it('creates an app-scoped task with provider, model, and effort selections', async () => {
    api.createCosJob.mockResolvedValue({ success: true, job: task });

    render(<CustomTasksSection appId="app-1" appName="Example App" />);
    await screen.findByText('Example Task');
    fireEvent.click(screen.getByRole('button', { name: /New Custom Task/ }));
    fireEvent.change(screen.getByPlaceholderText('Task name *'), { target: { value: 'Pinned Task' } });
    fireEvent.change(screen.getByPlaceholderText('One-line summary (optional)'), { target: { value: 'A concise card summary' } });
    fireEvent.change(screen.getByPlaceholderText('Prompt for the agent *'), { target: { value: 'Do the thing' } });
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'codex' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5' } });
    fireEvent.change(screen.getByLabelText('Thinking effort'), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open issues: off' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(api.createCosJob).toHaveBeenCalledWith(expect.objectContaining({
      appId: 'app-1',
      type: 'agent',
      description: 'A concise card summary',
      providerId: 'codex',
      model: 'gpt-5',
      effort: 'high',
      dataInputs: ['open-issues']
    })));
  });

  it('edits the saved task pins through the shared controls', async () => {
    api.updateCosJob.mockResolvedValue({ success: true, job: task });

    render(<CustomTasksSection appId="app-1" appName="Example App" />);
    await screen.findByText('Example Task');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.queryByLabelText('App scope')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'codex' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5' } });
    fireEvent.change(screen.getByLabelText('Thinking effort'), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateCosJob).toHaveBeenCalledWith('job-1', expect.objectContaining({
      appId: 'app-1',
      providerId: 'codex',
      model: 'gpt-5',
      effort: 'high'
    }), { silent: true }));
  });

  it('declares a configuration field, fills it in, and saves both halves', async () => {
    api.createCosJob.mockResolvedValue({ success: true, job: task });

    render(<CustomTasksSection appId="app-1" appName="Example App" />);
    await screen.findByText('Example Task');
    fireEvent.click(screen.getByRole('button', { name: /New Custom Task/ }));
    fireEvent.change(screen.getByPlaceholderText('Task name *'), { target: { value: 'Parameterized Task' } });
    fireEvent.change(screen.getByPlaceholderText('Prompt for the agent *'), { target: { value: 'Do the thing' } });

    fireEvent.click(screen.getByRole('button', { name: /Add field/ }));
    fireEvent.change(screen.getByPlaceholderText('What the agent reads, e.g. Topic'), { target: { value: 'Subject' } });
    fireEvent.change(screen.getByPlaceholderText('topic'), { target: { value: 'subject' } });
    // The value input appears only once the definition exists, and is bound by key.
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'tides' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(api.createCosJob).toHaveBeenCalledWith(expect.objectContaining({
      formFields: [expect.objectContaining({ key: 'subject', label: 'Subject', type: 'text' })],
      formValues: { subject: 'tides' }
    })));
  });

  it('lets a multi-line choice list be typed without eating the newlines', async () => {
    // parse→serialize is lossy, so echoing the re-serialized value back into the
    // textarea erased each newline as it was typed and a second choice could
    // never be entered. The editor keeps the raw text; only the parse leaves it.
    api.createCosJob.mockResolvedValue({ success: true, job: task });

    render(<CustomTasksSection appId="app-1" appName="Example App" />);
    await screen.findByText('Example Task');
    fireEvent.click(screen.getByRole('button', { name: /New Custom Task/ }));
    fireEvent.change(screen.getByPlaceholderText('Task name *'), { target: { value: 'Choice Task' } });
    fireEvent.change(screen.getByPlaceholderText('Prompt for the agent *'), { target: { value: 'Do the thing' } });

    fireEvent.click(screen.getByRole('button', { name: /Add field/ }));
    fireEvent.change(screen.getByPlaceholderText('What the agent reads, e.g. Topic'), { target: { value: 'Size' } });
    fireEvent.change(screen.getByPlaceholderText('topic'), { target: { value: 'size' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'select' } });

    const choices = screen.getByLabelText('Choices');
    fireEvent.change(choices, { target: { value: 'sq\n' } });
    expect(choices.value).toBe('sq\n'); // the newline survives the round trip
    fireEvent.change(choices, { target: { value: 'sq|Square\ntall' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(api.createCosJob).toHaveBeenCalledWith(expect.objectContaining({
      formFields: [expect.objectContaining({
        type: 'select',
        options: [{ value: 'sq', label: 'Square' }, { value: 'tall' }]
      })]
    })));
  });

  it('refuses to save while a required configuration field is blank', async () => {
    api.updateCosJob.mockResolvedValue({ success: true, job: task });
    api.getCosJobs.mockResolvedValue({
      jobs: [{ ...task, formFields: [{ key: 'subject', label: 'Subject', type: 'text', required: true }], formValues: {} }],
      dataInputCatalog: []
    });

    render(<CustomTasksSection appId="app-1" appName="Example App" />);
    await screen.findByText('Example Task');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Fill in Subject'));
    expect(api.updateCosJob).not.toHaveBeenCalled();
  });

  it('keeps required prompt validation when editing the shared card', async () => {
    render(<CustomTasksSection appId="app-1" appName="Example App" />);
    await screen.findByText('Example Task');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Prompt template'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Prompt is required'));
    expect(api.updateCosJob).not.toHaveBeenCalled();
  });

  it('reports a direct manual trigger as started', async () => {
    api.triggerCosJob.mockResolvedValue({ success: true, status: 'queued', started: true });
    render(<CustomTasksSection appId="app-1" appName="Example App" />);
    await screen.findByText('Example Task');

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Started "Example Task" for Example App'));
  });

  it('surfaces a skipped trigger without claiming the task ran', async () => {
    api.triggerCosJob.mockResolvedValue({
      success: false,
      status: 'skipped',
      reason: 'Task was not queued'
    });
    render(<CustomTasksSection appId="app-1" appName="Example App" />);
    await screen.findByText('Example Task');

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Task was not queued'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('treats an existing equivalent task as an informational skip', async () => {
    api.triggerCosJob.mockResolvedValue({
      success: true,
      status: 'skipped',
      reason: 'An equivalent task is already queued',
      duplicate: true
    });
    render(<CustomTasksSection appId="app-1" appName="Example App" />);
    await screen.findByText('Example Task');

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('An equivalent task is already queued'));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('runs a task with values typed into the card, without saving them to the task', async () => {
    api.getCosJobs.mockResolvedValue({
      jobs: [{
        ...task,
        formFields: [{ key: 'subject', label: 'Subject', type: 'text' }],
        formValues: { subject: 'Saved subject' }
      }],
      dataInputCatalog: []
    });
    api.triggerCosJob.mockResolvedValue({ success: true, status: 'queued', started: true });

    render(<CustomTasksSection appId="app-1" appName="Example App" />);
    await screen.findByText('Example Task');

    // The card exposes the field itself — no Edit round-trip to re-aim a run.
    const subject = screen.getByLabelText('Subject');
    expect(subject).toHaveValue('Saved subject');
    fireEvent.change(subject, { target: { value: 'One-off subject' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));

    await waitFor(() => expect(api.triggerCosJob).toHaveBeenCalledWith('job-1', {
      formValues: { subject: 'One-off subject' }
    }));
    expect(api.updateCosJob).not.toHaveBeenCalled();
  });

  it('sends no configuration when the card fields were left untouched', async () => {
    api.getCosJobs.mockResolvedValue({
      jobs: [{
        ...task,
        formFields: [{ key: 'subject', label: 'Subject', type: 'text' }],
        formValues: { subject: 'Saved subject' }
      }],
      dataInputCatalog: []
    });
    api.triggerCosJob.mockResolvedValue({ success: true, status: 'queued', started: true });

    render(<CustomTasksSection appId="app-1" appName="Example App" />);
    await screen.findByText('Example Task');
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));

    // "Run as saved" must send nothing rather than echo the card's own copy of
    // the values: the server merges what it receives over the job it just read,
    // so echoing them would revert a change made from another surface since
    // this card rendered.
    await waitFor(() => expect(api.triggerCosJob).toHaveBeenCalledWith('job-1', {}));
  });

  it('blocks an ad-hoc run that leaves a required card field blank', async () => {
    api.getCosJobs.mockResolvedValue({
      jobs: [{
        ...task,
        formFields: [{ key: 'subject', label: 'Subject', type: 'text', required: true }],
        formValues: { subject: 'Saved subject' }
      }],
      dataInputCatalog: []
    });

    render(<CustomTasksSection appId="app-1" appName="Example App" />);
    await screen.findByText('Example Task');

    fireEvent.change(screen.getByLabelText('Subject *'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Fill in Subject'));
    expect(api.triggerCosJob).not.toHaveBeenCalled();
  });

  it('keeps Run now available for a disabled recurring schedule', async () => {
    api.getCosJobs.mockResolvedValue({ jobs: [{ ...task, enabled: false }] });
    api.triggerCosJob.mockResolvedValue({ success: true, status: 'queued' });

    render(<CustomTasksSection appId="app-1" appName="Example App" />);
    await screen.findByText('Example Task');

    const runNow = screen.getByRole('button', { name: 'Run now' });
    expect(runNow).not.toBeDisabled();
    fireEvent.click(runNow);

    await waitFor(() => expect(api.triggerCosJob).toHaveBeenCalledWith('job-1', {}));
    expect(api.toggleCosJob).not.toHaveBeenCalled();
  });
});
