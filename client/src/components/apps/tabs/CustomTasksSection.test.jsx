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

  it('keeps Run now available for a disabled recurring schedule', async () => {
    api.getCosJobs.mockResolvedValue({ jobs: [{ ...task, enabled: false }] });
    api.triggerCosJob.mockResolvedValue({ success: true, status: 'queued' });

    render(<CustomTasksSection appId="app-1" appName="Example App" />);
    await screen.findByText('Example Task');

    const runNow = screen.getByRole('button', { name: 'Run now' });
    expect(runNow).not.toBeDisabled();
    fireEvent.click(runNow);

    await waitFor(() => expect(api.triggerCosJob).toHaveBeenCalledWith('job-1'));
    expect(api.toggleCosJob).not.toHaveBeenCalled();
  });
});
