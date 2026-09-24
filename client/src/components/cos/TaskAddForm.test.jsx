import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import TaskAddForm from './TaskAddForm';
import { __resetToolUseModelIdsCache } from '../../hooks/useToolUseModelIds.js';
import { findEnabledByLabelText } from '../../test/enabledBarrier.js';

const api = vi.hoisted(() => ({
  getCosPopularTemplates: vi.fn(),
  getCodeReviewDefaults: vi.fn(),
  // Back the reviewer table's Model column (useReviewerModelOptions).
  getLocalLlmStatus: vi.fn(),
  getProviders: vi.fn(),
  getAppWorkTracker: vi.fn(),
  getAppRepositorySources: vi.fn(),
  applyCosTaskTemplate: vi.fn(),
  addCosTask: vi.fn(),
  getOrchestrationProfiles: vi.fn(),
  // Declared so the render-path assertion below is real: the picker must read the
  // cached catalog off the provider payload, never fetch one of its own (#6306).
  getCodexModels: vi.fn(),
  // The shared selector resolves a COMPOSITE pin the caller's preset list cannot
  // name against this catalog, and fetches it ONLY in that case.
  getProviderCatalog: vi.fn(),
}));

// useAssignableInstances reads the instance registry straight off apiSystem, so
// the picker (#4520) has to be driven from there rather than the `api` barrel.
const apiSystem = vi.hoisted(() => ({ getAssignableInstances: vi.fn() }));
// `highlightToolUse` on the main picker (#7588) pulls in the authoritative
// tool-use capability fetch — mock it so the suite never issues a real request.
// Resolved to empty here (not just in the top describe's beforeEach) so every
// describe below that clears mocks without re-seeding it still renders without
// unhandled fetch, since `vi.clearAllMocks()` clears calls but keeps this default.
const apiLocalLlm = vi.hoisted(() => ({ getToolUseModels: vi.fn().mockResolvedValue({ models: [] }), getVisionModels: vi.fn().mockResolvedValue({ models: [] }) }));
const featureGate = vi.hoisted(() => ({ quickTemplatesEnabled: true }));
const toast = vi.hoisted(() => {
  const toastFn = vi.fn();
  toastFn.success = vi.fn();
  toastFn.error = vi.fn();
  toastFn.warning = vi.fn();
  return toastFn;
});
vi.mock('../../services/apiSystem', () => apiSystem);
vi.mock('../../services/api', () => api);
vi.mock('../../services/apiLocalLlm', () => apiLocalLlm);
vi.mock('../../hooks/useInstanceFeatures', () => ({
  useInstanceFeatures: () => ({
    isFeatureEnabled: (featureId) => featureId === 'cos-task-templates' ? featureGate.quickTemplatesEnabled : true,
  }),
}));
vi.mock('../ui/Toast', () => ({ default: toast }));

beforeEach(() => {
  featureGate.quickTemplatesEnabled = true;
  localStorage.removeItem('portos-cos-quick-templates-expanded');
});

const worktreeToggle = () => screen.getByTitle(/isolated git worktree/i).closest('label').querySelector('input');
const openPrToggle = () => screen.getByTitle(/Open a pull request/i).closest('label').querySelector('input');
const planOnlyToggle = () => screen.getByLabelText(/Plan & file issue/i);

describe('TaskAddForm responsive layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetToolUseModelIdsCache();
    api.getCosPopularTemplates.mockResolvedValue({ templates: [] });
    api.getCodeReviewDefaults.mockResolvedValue(null);
    api.getLocalLlmStatus.mockResolvedValue({ ollama: { models: [] }, lmstudio: { models: [] } });
    api.getProviders.mockResolvedValue({ providers: [] });
    api.getAppWorkTracker.mockResolvedValue({ resolved: 'github' });
    api.getAppRepositorySources.mockResolvedValue({
      issueTargets: {
        default: 'origin',
        canChoose: false,
        origin: { fullName: 'example-org/example-app' },
        upstream: { fullName: 'example-org/example-app' },
      },
    });
    api.applyCosTaskTemplate.mockResolvedValue({ success: true });
    api.getOrchestrationProfiles.mockResolvedValue({ profiles: [] });
    apiSystem.getAssignableInstances.mockResolvedValue({ instances: [] });
    // Nothing authoritative by default, so the id regex alone decides.
    apiLocalLlm.getToolUseModels.mockResolvedValue({ models: [] });
  });

  it('hides quick templates and skips their fetch when the feature is disabled', async () => {
    featureGate.quickTemplatesEnabled = false;
    api.getCosPopularTemplates.mockResolvedValue({
      templates: [{ id: 'hidden-template', name: 'Hidden Template', description: 'Not shown', isBuiltin: true }],
    });

    render(<TaskAddForm providers={[]} apps={[]} onTaskAdded={vi.fn()} />);

    await waitFor(() => expect(screen.getByPlaceholderText('Task description *')).toBeInTheDocument());
    expect(screen.queryByText('Quick Templates')).toBeNull();
    expect(screen.queryByRole('button', { name: /Save Template/i })).toBeNull();
    expect(api.getCosPopularTemplates).not.toHaveBeenCalled();
  });

  it('can submit the full form with Quick Templates disabled', async () => {
    localStorage.clear();
    featureGate.quickTemplatesEnabled = false;
    api.addCosTask.mockResolvedValue({ id: 'example-task' });
    const user = userEvent.setup();
    render(<TaskAddForm providers={[]} apps={[]} onTaskAdded={vi.fn()} />);

    await user.type(screen.getByRole('textbox', { name: /Task description/ }), 'Inspect the example app');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(api.addCosTask).toHaveBeenCalledWith(expect.objectContaining({ description: 'Inspect the example app' }), { silent: true });
    expect(screen.getByRole('textbox', { name: /Task description/ })).toHaveValue('');
  });

  it.each([
    ['full', {}], ['compact', { compact: true }], ['queue', { queueFirst: true }],
  ])('does not launch from an IME confirmation in the %s form', async (_variant, props) => {
    localStorage.clear();
    api.addCosTask.mockResolvedValue({ id: 'example-task' });
    render(<TaskAddForm {...props} providers={[]} apps={[]} onTaskAdded={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: /Task description/ });
    fireEvent.change(input, { target: { value: 'Inspect the example app' } });

    await act(async () => { fireEvent.keyDown(input, { key: 'Enter', isComposing: true }); });
    expect(api.addCosTask).not.toHaveBeenCalled();
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 }); });
    expect(api.addCosTask).not.toHaveBeenCalled();

    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(api.addCosTask).toHaveBeenCalledTimes(1);
  });

  it('does not submit twice while the first request is pending', async () => {
    localStorage.clear();
    let resolveTask;
    api.addCosTask.mockReturnValue(new Promise((resolve) => { resolveTask = resolve; }));
    render(<TaskAddForm providers={[]} apps={[]} onTaskAdded={vi.fn()} />);

    const input = screen.getByRole('textbox', { name: /Task description/ });
    fireEvent.change(input, { target: { value: 'Submit once' } });
    const button = screen.getByRole('button', { name: 'Add' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(api.addCosTask).toHaveBeenCalledTimes(1);
    await act(async () => { resolveTask({ id: 'example-task' }); });
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it.each([false, true])('keeps a new app selection after restoring a draft (deferred apps: %s)', async (deferred) => {
    localStorage.clear();
    localStorage.setItem('portos-cos-task-description-draft', JSON.stringify({ description: 'Inspect the selected app', app: 'draft-app' }));
    api.addCosTask.mockResolvedValue({ id: 'example-task' });
    const user = userEvent.setup();
    const apps = [{ id: 'draft-app', name: 'Draft App' }, { id: 'chosen-app', name: 'Chosen App' }];
    const props = { providers: [], defaultApp: 'chosen-app', onTaskAdded: vi.fn() };
    const { rerender } = render(<TaskAddForm {...props} apps={deferred ? [] : apps} />);
    if (deferred) rerender(<TaskAddForm {...props} apps={apps} />);
    await waitFor(() => expect(screen.getByLabelText('Target application')).toHaveValue('draft-app'));

    await user.selectOptions(screen.getByLabelText('Target application'), 'chosen-app');
    expect(screen.getByLabelText('Target application')).toHaveValue('chosen-app');
    rerender(<TaskAddForm {...props} apps={[...apps]} />);
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(api.addCosTask).toHaveBeenCalledWith(expect.objectContaining({ app: 'chosen-app' }), { silent: true });
  });

  it('keeps the target app selector on the main queue-first form', async () => {
    localStorage.clear();
    api.addCosTask.mockResolvedValue({ id: 'example-task' });
    const user = userEvent.setup();
    render(<TaskAddForm queueFirst providers={[]} defaultApp="first-app"
      apps={[{ id: 'first-app', name: 'First App' }, { id: 'chosen-app', name: 'Chosen App' }]}
      onTaskAdded={vi.fn()} />);

    const appSelect = screen.getByLabelText('Target application');
    expect(appSelect).toHaveValue('first-app');
    expect(appSelect.closest('#task-configuration')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Task configuration' })).not.toBeInTheDocument();

    await user.selectOptions(appSelect, 'chosen-app');
    await user.type(screen.getByRole('textbox', { name: /Task description/ }), 'Inspect the chosen app');
    await user.click(screen.getByRole('button', { name: 'Add task' }));

    expect(api.addCosTask).toHaveBeenCalledWith(expect.objectContaining({
      app: 'chosen-app',
      description: 'Inspect the chosen app',
    }), { silent: true });
  });

  // #7796: hiding configuration must not reset the draft or silently change
  // app completion defaults, and a failed submission must remain retryable.
  it('keeps queue settings inline and retains drafts across collapse and failed submission', async () => {
    localStorage.clear();
    const user = userEvent.setup();
    const added = vi.fn();
    api.getCosPopularTemplates.mockResolvedValue({ templates: [{ id: 'example-template', name: 'Inspect example', description: 'Inspect example', isBuiltin: true }] });
    api.getCodeReviewDefaults.mockResolvedValue({ reviewers: ['codex'] });
    api.addCosTask.mockRejectedValueOnce(new Error('Queue unavailable'))
      .mockResolvedValueOnce({ id: 'example-task', status: 'pending' });
    render(<MemoryRouter><TaskAddForm queueFirst providers={[]} defaultApp="example-app"
      apps={[{ id: 'example-app', name: 'Example App', defaultUseWorktree: true, defaultOpenPR: true, defaultPrCompletion: 'review-then-merge' }]}
      onTaskAdded={added} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByLabelText('Task execution summary')).toHaveTextContent('Review: codex'));
    expect(screen.queryByLabelText('AI provider')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Attach screenshots')).toBeInTheDocument();
    expect(screen.getByLabelText('Attach files')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Inspect example/ })).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: /Task description/ }), 'Inspect synthetic queue');
    await user.click(screen.getByRole('button', { name: 'Task configuration' }));
    expect(openPrToggle()).toBeChecked();
    expect(worktreeToggle()).toBeChecked();
    await user.click(worktreeToggle());
    await user.selectOptions(screen.getByLabelText('When done'), 'commit-push');
    expect(screen.getByLabelText('When done')).toHaveValue('commit-push');
    await user.click(screen.getByRole('button', { name: 'Task configuration' }));
    expect(screen.getByLabelText('Task execution summary')).toHaveTextContent('Direct checkout · Commit and push to default branch');
    await user.click(screen.getByRole('button', { name: 'Add task' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Queue unavailable'));
    expect(screen.getByRole('textbox', { name: /Task description/ })).toHaveValue('Inspect synthetic queue');
    expect(added).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Task configuration' }));
    expect(screen.getByLabelText('When done')).toHaveValue('commit-push');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add task' }));
    await waitFor(() => expect(added).toHaveBeenCalledWith({ id: 'example-task', status: 'pending' }, { position: 'bottom' }));
    expect(api.addCosTask).toHaveBeenLastCalledWith(expect.objectContaining({
      app: 'example-app', description: 'Inspect synthetic queue', useWorktree: false,
      openPR: false, whenDone: 'commit-push',
    }), { silent: true });
    expect(screen.getByRole('textbox', { name: /Task description/ })).toHaveValue('');
  });

  it('keeps PR completion controls full-width on mobile', async () => {
    render(
      <TaskAddForm
        providers={[]}
        apps={[{
          id: 'example-app',
          name: 'Example App',
          repoPath: 'example.com/repo',
          defaultOpenPR: true,
          defaultPrCompletion: 'review-then-merge'
        }]}
        defaultApp="example-app"
        onTaskAdded={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('Reviewers (in order):')).toBeInTheDocument());

    const options = screen.getByRole('form', { name: 'Add new task' }).querySelector('div.grid');
    expect(options).toHaveClass('grid-cols-1');
    expect(options).not.toHaveClass('grid-cols-2');
  });

  it('restores the description draft and clears it after a successful submit', async () => {
    const user = userEvent.setup();
    const description = 'Keep this task after an accidental navigation';
    localStorage.setItem('portos-cos-task-description-draft', JSON.stringify({ description, app: 'draft-app' }));
    api.addCosTask.mockResolvedValue({ success: true });

    const apps = [
      { id: 'draft-app', name: 'Draft App', repoPath: 'example.com/draft' },
      { id: 'current-app', name: 'Current App', repoPath: 'example.com/current' },
    ];
    const { unmount } = render(<TaskAddForm providers={[]} apps={apps} defaultApp="current-app" onTaskAdded={vi.fn()} />);
    expect(screen.getByPlaceholderText('Task description *')).toHaveValue(description);
    expect(screen.getByLabelText('Target application')).toHaveValue('draft-app');

    unmount();
    render(<TaskAddForm providers={[]} apps={apps} defaultApp="current-app" onTaskAdded={vi.fn()} />);
    const descriptionInput = screen.getByPlaceholderText('Task description *');
    await user.click(descriptionInput);
    await user.type(descriptionInput, ' with more detail');
    expect(JSON.parse(localStorage.getItem('portos-cos-task-description-draft'))).toEqual({
      description: `${description} with more detail`,
      app: 'draft-app',
    });

    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await waitFor(() => expect(api.addCosTask).toHaveBeenCalled());
    expect(localStorage.getItem('portos-cos-task-description-draft')).toBeNull();
  });

  it('passes the persisted task to queue views immediately after submission', async () => {
    const user = userEvent.setup();
    const onTaskAdded = vi.fn();
    const task = { id: 'task-new', description: 'Appear immediately', status: 'pending', metadata: {} };
    api.addCosTask.mockResolvedValue(task);
    render(<TaskAddForm providers={[]} apps={[]} onTaskAdded={onTaskAdded} />);

    await user.type(screen.getByPlaceholderText('Task description *'), task.description);
    await user.click(screen.getByRole('button', { name: /^Add$/ }));

    await waitFor(() => expect(onTaskAdded).toHaveBeenCalledWith(task, { position: 'bottom' }));
  });

  it('keeps the description draft when submission fails', async () => {
    const user = userEvent.setup();
    api.addCosTask.mockRejectedValue(new Error('Unable to add task'));
    render(<TaskAddForm providers={[]} apps={[]} onTaskAdded={vi.fn()} />);

    const descriptionInput = screen.getByPlaceholderText('Task description *');
    await user.type(descriptionInput, 'Retry this task');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));

    await waitFor(() => expect(api.addCosTask).toHaveBeenCalled());
    expect(descriptionInput).toHaveValue('Retry this task');
    expect(JSON.parse(localStorage.getItem('portos-cos-task-description-draft'))).toEqual({
      description: 'Retry this task',
      app: null,
    });
  });

  it('does not submit a stale restored app while app options are unavailable', async () => {
    const user = userEvent.setup();
    localStorage.setItem('portos-cos-task-description-draft', JSON.stringify({
      description: 'Use the current app safely',
      app: 'stale-app',
    }));
    api.addCosTask.mockResolvedValue({ success: true });
    render(<TaskAddForm providers={[]} apps={[]} defaultApp="current-app" onTaskAdded={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await waitFor(() => expect(api.addCosTask).toHaveBeenCalled());
    expect(api.addCosTask.mock.calls[0][0].app).toBe('current-app');
  });

  // #6219: ReviewerPicker gets no `defaults` prop wired, the submit payload
  // unconditionally spread all eight reviewer fields whenever review-then-merge
  // was active — even when the picker was never touched — freezing today's
  // Code Review Defaults into the new task's metadata permanently.
  describe('reviewer defaults inheritance (#6219)', () => {
    const REVIEWER_PAYLOAD_KEYS = [
      'reviewers', 'usernames', 'optionalReviewers', 'reviewerMaxRounds',
      'reviewerModels', 'reviewerEfforts', 'reviewStopMode', 'reviewerApplies',
    ];
    const app = {
      id: 'example-app',
      name: 'Example App',
      repoPath: 'example.com/repo',
      defaultOpenPR: true,
      defaultPrCompletion: 'review-then-merge',
    };

    it('leaves every reviewer field absent when the picker is never touched', async () => {
      const user = userEvent.setup();
      api.getCodeReviewDefaults.mockResolvedValue({
        reviewers: ['copilot', 'claude'], usernames: [], optionalReviewers: [],
        reviewerMaxRounds: {}, stopMode: 'all', reviewerApplies: false,
      });
      api.addCosTask.mockResolvedValue({ success: true });
      render(<TaskAddForm providers={[]} apps={[app]} defaultApp="example-app" onTaskAdded={vi.fn()} />);

      await waitFor(() => expect(screen.getByText('Reviewers (in order):')).toBeInTheDocument());
      await user.type(screen.getByPlaceholderText('Task description *'), 'Fix the bug');
      await user.click(screen.getByRole('button', { name: /^Add$/ }));

      await waitFor(() => expect(api.addCosTask).toHaveBeenCalled());
      const payload = api.addCosTask.mock.calls.at(-1)[0];
      for (const key of REVIEWER_PAYLOAD_KEYS) expect(payload).not.toHaveProperty(key);
    });

    it('sends only the field the user actually changed', async () => {
      const user = userEvent.setup();
      api.getCodeReviewDefaults.mockResolvedValue({
        reviewers: ['copilot', 'claude'], usernames: [], optionalReviewers: [],
        reviewerMaxRounds: {}, stopMode: 'all', reviewerApplies: false,
      });
      api.addCosTask.mockResolvedValue({ success: true });
      render(<TaskAddForm providers={[]} apps={[app]} defaultApp="example-app" onTaskAdded={vi.fn()} />);

      await waitFor(() => expect(screen.getByText('Reviewers (in order):')).toBeInTheDocument());
      const stopModeSelect = await screen.findByLabelText('Stop mode:');
      await user.selectOptions(stopModeSelect, 'on-clean');

      await user.type(screen.getByPlaceholderText('Task description *'), 'Fix the bug');
      await user.click(screen.getByRole('button', { name: /^Add$/ }));

      await waitFor(() => expect(api.addCosTask).toHaveBeenCalled());
      const payload = api.addCosTask.mock.calls.at(-1)[0];
      expect(payload.reviewStopMode).toBe('on-clean');
      for (const key of REVIEWER_PAYLOAD_KEYS) {
        if (key === 'reviewStopMode') continue;
        expect(payload).not.toHaveProperty(key);
      }
    });
  });

  it('restores a plain-text draft from the previous storage format', async () => {
    localStorage.setItem('portos-cos-task-description-draft', 'Legacy task draft');
    render(<TaskAddForm providers={[]} apps={[]} onTaskAdded={vi.fn()} />);

    await waitFor(() => expect(screen.getByPlaceholderText('Task description *')).toHaveValue('Legacy task draft'));
  });

  it('sends OpenCode Ollama thinking, effort, and temperature overrides with the task', async () => {
    const user = userEvent.setup();
    api.addCosTask.mockResolvedValue({ success: true });
    render(<TaskAddForm providers={[{
      id: 'opencode-ollama', name: 'OpenCode Ollama', enabled: true, type: 'tui',
      command: 'opencode', ollamaBacked: true, models: ['qwen3:8b'],
    }]} apps={[]} onTaskAdded={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('Task description *'), 'Implement the change');
    await user.selectOptions(screen.getByLabelText('AI provider'), 'opencode-ollama');
    await user.selectOptions(screen.getByLabelText('Thinking effort'), 'high');
    await user.selectOptions(screen.getByLabelText('Thinking'), 'false');
    await user.type(screen.getByLabelText('Temperature'), '0.25');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));

    await waitFor(() => expect(api.addCosTask).toHaveBeenCalled());
    expect(api.addCosTask.mock.calls.at(-1)[0]).toMatchObject({
      provider: 'opencode-ollama', effort: 'high', thinking: false, temperature: 0.25,
    });
  });

  it('queues plan-and-file mode without implementation delivery controls', async () => {
    const user = userEvent.setup();
    api.addCosTask.mockResolvedValue({ success: true });
    render(<TaskAddForm providers={[]} apps={[]} onTaskAdded={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('Task description *'), 'Add export filtering');
    await waitFor(() => expect(planOnlyToggle()).toBeInTheDocument());
    await user.click(planOnlyToggle());

    expect(planOnlyToggle()).toBeChecked();
    expect(screen.queryByTitle(/isolated git worktree/i)).toBeNull();
    expect(screen.queryByTitle(/Open a pull request/i)).toBeNull();
    expect(screen.queryByText('Simplify')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Plan & File Issue' }));
    await waitFor(() => expect(api.addCosTask).toHaveBeenCalled());
    expect(api.addCosTask.mock.calls.at(-1)[0]).toMatchObject({
      planOnly: true,
      slashdoCommand: 'plan-task',
      slashdoArgs: '--yes',
      useWorktree: false,
      openPR: false,
      simplify: false,
      worktreeChangesExpected: false,
      createJiraTicket: false,
    });

    await user.click(planOnlyToggle());
    await waitFor(() => {
      expect(planOnlyToggle()).not.toBeChecked();
      expect(worktreeToggle()).toBeChecked();
      expect(openPrToggle()).toBeChecked();
    });
  });

  it('defaults a forked app plan to upstream and permits an explicit origin target', async () => {
    const user = userEvent.setup();
    api.addCosTask.mockResolvedValue({ success: true });
    api.getAppRepositorySources.mockResolvedValue({
      issueTargets: {
        default: 'upstream',
        canChoose: true,
        origin: { fullName: 'example-owner/example-app' },
        upstream: { fullName: 'example-org/example-app' },
      },
    });
    render(<TaskAddForm
      providers={[]}
      apps={[{ id: 'example-app', name: 'Example App', repoPath: '/example/app' }]}
      defaultApp="example-app"
      onTaskAdded={vi.fn()}
    />);

    await user.type(screen.getByPlaceholderText('Task description *'), 'Plan a feature');
    await user.click(await screen.findByLabelText(/Plan & file issue/i));
    const target = await screen.findByLabelText('File issue on');
    expect(target).toHaveValue('upstream');
    expect(target).toHaveTextContent('Upstream · example-org/example-app');
    await user.selectOptions(target, 'origin');
    await user.click(screen.getByRole('button', { name: 'Plan & File Issue' }));

    await waitFor(() => expect(api.addCosTask).toHaveBeenCalledWith(
      expect.objectContaining({ planOnly: true, issueTarget: 'origin' }),
      { silent: true },
    ));
  });

  it('offers and submits the non-worktree completion choice', async () => {
    const user = userEvent.setup();
    api.addCosTask.mockResolvedValue({ success: true });
    render(<TaskAddForm providers={[]} apps={[]} onTaskAdded={vi.fn()} />);

    await user.click(worktreeToggle());
    expect(screen.getByLabelText('When done')).toHaveValue('leave-uncommitted');
    await user.selectOptions(screen.getByLabelText('When done'), 'commit-push');
    await user.type(screen.getByPlaceholderText('Task description *'), 'Update default branch');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));

    await waitFor(() => expect(api.addCosTask).toHaveBeenCalled());
    expect(api.addCosTask.mock.calls.at(-1)[0]).toMatchObject({ useWorktree: false, whenDone: 'commit-push' });
  });

  it.each([
    ['PLAN.md', 'plan', 'plan'],
    ['JIRA', 'jira', 'jira'],
    ['auto-resolved JIRA', 'auto', 'jira'],
  ])('does not offer plan-and-file mode for %s apps', async (_label, workTracker, resolvedTracker) => {
    api.getAppWorkTracker.mockResolvedValue({ resolved: resolvedTracker });
    render(
      <TaskAddForm
        providers={[]}
        apps={[{
          id: 'tracker-app',
          name: 'Tracker App',
          repoPath: 'example.com/repo',
          workTracker,
        }]}
        defaultApp="tracker-app"
        onTaskAdded={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText(/Plan & file issue is available for GitHub or GitLab/i)).toBeInTheDocument());
    expect(screen.queryByLabelText(/Plan & file issue/i)).toBeNull();
  });
});

// A slashdo quick-template carries the run shape its workflow implies (#3089).
// `settings` keys are tri-state: absent means "leave the toggle alone", `false`
// means "turn it off" — collapsing the two would make a plain user template
// silently clear toggles it never meant to touch.
describe('TaskAddForm quick templates', () => {
  const openTemplates = async (user) => {
    await waitFor(() => expect(screen.getByText('Quick Templates')).toBeInTheDocument());
    await user.click(screen.getByText('Quick Templates'));
  };
  const renderForm = () => render(
    <TaskAddForm
      providers={[]}
      apps={[{ id: 'example-app', name: 'Example App', repoPath: 'example.com/repo', workTracker: 'github', defaultOpenPR: true, defaultUseWorktree: true }]}
      defaultApp="example-app"
      onTaskAdded={vi.fn()}
    />
  );

  beforeEach(() => {
    vi.clearAllMocks();
    api.getCodeReviewDefaults.mockResolvedValue(null);
    api.getLocalLlmStatus.mockResolvedValue({ ollama: { models: [] }, lmstudio: { models: [] } });
    api.getProviders.mockResolvedValue({ providers: [] });
    api.getAppWorkTracker.mockResolvedValue({ resolved: 'github' });
    api.applyCosTaskTemplate.mockResolvedValue({ success: true });
  });

  it('applies a slashdo template settings block to the run-shape toggles', async () => {
    const user = userEvent.setup();
    api.getCosPopularTemplates.mockResolvedValue({
      templates: [{
        id: 'builtin-do-plan-task',
        name: 'Plan a Task',
        icon: '📋',
        slashdoCommand: 'plan-task',
        description: 'Investigate and file an issue for: ',
        settings: { useWorktree: false, openPR: false, simplify: false },
        isBuiltin: true
      }]
    });

    renderForm();
    await openTemplates(user);

    // The app defaults turned the worktree on; plan-only hides implementation
    // delivery controls rather than leaving an unchecked worktree control.
    expect(worktreeToggle()).toBeChecked();
    await user.click(screen.getByText('Plan a Task'));

    await waitFor(() => expect(planOnlyToggle()).toBeChecked());
    expect(screen.queryByTitle(/isolated git worktree/i)).toBeNull();
    expect(screen.getByPlaceholderText('Task description *')).toHaveValue('Investigate and file an issue for: ');
    expect(api.applyCosTaskTemplate).toHaveBeenCalledWith('builtin-do-plan-task', { silent: true });
  });

  it('leaves the toggles as-is for a template with no settings block', async () => {
    const user = userEvent.setup();
    api.getCosPopularTemplates.mockResolvedValue({
      templates: [{ id: 'user-abc', name: 'My Template', description: 'Do the thing', isBuiltin: false }]
    });

    renderForm();
    await openTemplates(user);

    expect(worktreeToggle()).toBeChecked();
    await user.click(screen.getByText('My Template'));

    await waitFor(() => expect(screen.getByPlaceholderText('Task description *')).toHaveValue('Do the thing'));
    expect(worktreeToggle()).toBeChecked();
    // A template that pins no app must not clear the one already selected —
    // clearing it also silently reset the app's worktree/PR defaults.
    expect(screen.getByLabelText(/target application/i)).toHaveValue('example-app');
  });

  it('remembers a collapsed section across queue-first task forms', async () => {
    const user = userEvent.setup();
    api.getCosPopularTemplates.mockResolvedValue({
      templates: [{ id: 'user-abc', name: 'My Template', description: 'Do the thing', isBuiltin: false }],
    });

    const formProps = {
      queueFirst: true,
      providers: [],
      apps: [],
      onTaskAdded: vi.fn(),
    };
    const { unmount } = render(<TaskAddForm {...formProps} />);
    const firstToggle = await screen.findByRole('button', { name: /Quick Templates/ });
    expect(firstToggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(firstToggle);
    await waitFor(() => expect(firstToggle).toHaveAttribute('aria-expanded', 'false'));
    await waitFor(() => expect(localStorage.getItem('portos-cos-quick-templates-expanded')).toBe('false'));
    expect(screen.queryByText('My Template')).toBeNull();

    unmount();
    render(<TaskAddForm {...formProps} />);
    const secondToggle = await screen.findByRole('button', { name: /Quick Templates/ });
    expect(secondToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('My Template')).toBeNull();
  });

  it('keeps the local template application and warns when usage recording fails', async () => {
    const user = userEvent.setup();
    api.getCosPopularTemplates.mockResolvedValue({
      templates: [{ id: 'user-failed', name: 'Offline Template', description: 'Do the thing locally', isBuiltin: false }]
    });
    api.applyCosTaskTemplate.mockRejectedValue(new Error('Server unreachable'));

    renderForm();
    await openTemplates(user);
    await user.click(screen.getByText('Offline Template'));

    await waitFor(() => expect(api.applyCosTaskTemplate).toHaveBeenCalledWith('user-failed', { silent: true }));
    expect(screen.getByPlaceholderText('Task description *')).toHaveValue('Do the thing locally');
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
      'Template applied locally, but usage could not be recorded'
    ));
    // Reported ONCE: `silent: true` keeps the shared API helper quiet, so the
    // component's warning is the only notice — no paired red error toast, and
    // no success claim about a write that did not happen.
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});

// #3651: the slashdo catalog's deliverable posture (`worktreeChangesExpected`,
// #3636) rides the quick-template `settings` block the same way the run-shape
// toggles do, so a `/do:review` queued from a template doesn't get scored
// `idle-no-changes` by the TUI reaper for its (correct) clean tree.
describe('TaskAddForm quick templates — deliverable posture', () => {
  // Mirrors WORKFLOW_REPORTS_NO_CODE / WORKFLOW_OWNS_ITS_OWN_GIT in
  // server/lib/slashdoCatalog.js, which taskTemplates.js copies verbatim.
  const REPORTS_NO_CODE = { useWorktree: false, openPR: false, simplify: false, worktreeChangesExpected: false };
  const OWNS_ITS_OWN_GIT = { useWorktree: false, openPR: false, simplify: false, worktreeChangesExpected: true };

  beforeEach(() => {
    vi.clearAllMocks();
    api.getCodeReviewDefaults.mockResolvedValue(null);
    api.getLocalLlmStatus.mockResolvedValue({ ollama: { models: [] }, lmstudio: { models: [] } });
    api.getProviders.mockResolvedValue({ providers: [] });
    api.applyCosTaskTemplate.mockResolvedValue({ success: true });
    api.addCosTask.mockResolvedValue({ success: true });
    api.getCosPopularTemplates.mockResolvedValue({
      templates: [
        { id: 'builtin-do-review', name: 'Review Changes', icon: '🔍', slashdoCommand: 'review', description: 'Review the changes', settings: REPORTS_NO_CODE, isBuiltin: true },
        { id: 'builtin-do-release', name: 'Cut a Release', icon: '🚀', slashdoCommand: 'release', description: 'Cut a release', settings: OWNS_ITS_OWN_GIT, isBuiltin: true },
        { id: 'user-abc', name: 'My Template', description: 'Do the thing', isBuiltin: false }
      ]
    });
  });

  const queueFromTemplate = async (templateName) => {
    const user = userEvent.setup();
    render(<TaskAddForm providers={[]} apps={[]} onTaskAdded={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Quick Templates')).toBeInTheDocument());
    await user.click(screen.getByText('Quick Templates'));
    await user.click(screen.getByText(templateName));
    await waitFor(() => expect(api.applyCosTaskTemplate).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await waitFor(() => expect(api.addCosTask).toHaveBeenCalled());
    return api.addCosTask.mock.calls.at(-1)[0];
  };

  it.each([
    ['Review Changes', false],
    ['Cut a Release', true]
  ])('carries %s posture into the create-task payload ⇒ worktreeChangesExpected %s', async (templateName, expected) => {
    const payload = await queueFromTemplate(templateName);
    expect(payload.worktreeChangesExpected).toBe(expected);
    expect(payload.slashdoCommand).toBe(templateName === 'Review Changes' ? 'review' : 'release');
  });

  it('omits the key entirely for a template that pins no posture', async () => {
    const payload = await queueFromTemplate('My Template');
    expect('worktreeChangesExpected' in payload).toBe(false);
  });

  // Unlike the three visible toggles, the posture is hidden state — so picking a
  // posture-pinning template and then a plain one must CLEAR it, not leave the
  // first template's deliverable riding along invisibly on the second.
  it('clears a previously applied posture when the next template pins none', async () => {
    const user = userEvent.setup();
    render(<TaskAddForm providers={[]} apps={[]} onTaskAdded={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Quick Templates')).toBeInTheDocument());
    await user.click(screen.getByText('Quick Templates'));
    await user.click(screen.getByText('Cut a Release'));
    await waitFor(() => expect(api.applyCosTaskTemplate).toHaveBeenCalled());
    await user.click(screen.getByText('My Template'));
    await waitFor(() => expect(api.applyCosTaskTemplate).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await waitFor(() => expect(api.addCosTask).toHaveBeenCalled());
    expect('worktreeChangesExpected' in api.addCosTask.mock.calls.at(-1)[0]).toBe(false);
  });
});

// #4520: on a federated install the form offers "which machine runs this?".
describe('TaskAddForm federated instance picker (#4520)', () => {
  const PEER = 'peer-instance-id';

  beforeEach(() => {
    vi.clearAllMocks();
    api.getCosPopularTemplates.mockResolvedValue({ templates: [] });
    api.getCodeReviewDefaults.mockResolvedValue(null);
    api.getLocalLlmStatus.mockResolvedValue({ ollama: { models: [] }, lmstudio: { models: [] } });
    api.getProviders.mockResolvedValue({ providers: [] });
    api.addCosTask.mockResolvedValue({ success: true });
  });

  it('is hidden on a single-instance install — there is nothing to choose', async () => {
    apiSystem.getAssignableInstances.mockResolvedValue({
      instances: [{ instanceId: 'self-instance-id', name: 'workstation', isSelf: true }],
    });
    render(<TaskAddForm providers={[]} apps={[]} onTaskAdded={vi.fn()} />);
    await waitFor(() => expect(apiSystem.getAssignableInstances).toHaveBeenCalled());
    expect(screen.queryByLabelText('Run on')).toBeNull();
  });

  it('sends the picked instance with the task, and omits it for "Any instance"', async () => {
    const user = userEvent.setup();
    apiSystem.getAssignableInstances.mockResolvedValue({
      instances: [
        { instanceId: 'self-instance-id', name: 'workstation', isSelf: true },
        { instanceId: PEER, name: 'render-box', isSelf: false },
      ],
    });
    render(<TaskAddForm providers={[]} apps={[]} onTaskAdded={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('Run on')).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText('Task description *'), 'Render the shot');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await waitFor(() => expect(api.addCosTask).toHaveBeenCalled());
    expect(api.addCosTask.mock.calls[0][0].targetInstanceId).toBeUndefined();

    await user.selectOptions(screen.getByLabelText('Run on'), PEER);
    await user.type(screen.getByPlaceholderText('Task description *'), 'Render the other shot');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await waitFor(() => expect(api.addCosTask).toHaveBeenCalledTimes(2));
    expect(api.addCosTask.mock.calls[1][0].targetInstanceId).toBe(PEER);
  });
});

// Worktree + Open PR ride ON by default so a queued task lands on a
// branch behind a PR unless the user (or the app record) opts out.
describe('TaskAddForm worktree/PR defaults', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    api.getCosPopularTemplates.mockResolvedValue({ templates: [] });
    api.getCodeReviewDefaults.mockResolvedValue(null);
    api.getLocalLlmStatus.mockResolvedValue({ ollama: { models: [] }, lmstudio: { models: [] } });
    api.getProviders.mockResolvedValue({ providers: [] });
    api.applyCosTaskTemplate.mockResolvedValue({ success: true });
    apiSystem.getAssignableInstances.mockResolvedValue({ instances: [] });
    api.addCosTask.mockResolvedValue({ success: true });
  });

  it('checks both toggles when no app pins a default, and submits them', async () => {
    const user = userEvent.setup();
    render(<TaskAddForm providers={[]} apps={[]} onTaskAdded={vi.fn()} />);

    await waitFor(() => expect(worktreeToggle()).toBeChecked());
    expect(openPrToggle()).toBeChecked();

    await user.type(screen.getByPlaceholderText('Task description *'), 'Ship the change');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await waitFor(() => expect(api.addCosTask).toHaveBeenCalled());
    expect(api.addCosTask.mock.calls[0][0]).toMatchObject({ useWorktree: true, openPR: true });
  });

  it('honors an app that explicitly opts out of both', async () => {
    render(
      <TaskAddForm
        providers={[]}
        apps={[{ id: 'example-app', name: 'Example App', repoPath: 'example.com/repo', defaultUseWorktree: false, defaultOpenPR: false }]}
        defaultApp="example-app"
        onTaskAdded={vi.fn()}
      />
    );

    await waitFor(() => expect(worktreeToggle()).not.toBeChecked());
    expect(openPrToggle()).not.toBeChecked();
  });

  it('leaves the PR off for an app that pins only defaultUseWorktree:false', async () => {
    render(
      <TaskAddForm
        providers={[]}
        apps={[{ id: 'example-app', name: 'Example App', repoPath: 'example.com/repo', defaultUseWorktree: false }]}
        defaultApp="example-app"
        onTaskAdded={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByPlaceholderText('Task description *')).toBeInTheDocument());
    expect(worktreeToggle()).not.toBeChecked();
    expect(openPrToggle()).not.toBeChecked();
  });

  describe('description auto-sizing textarea', () => {
    it('renders task description as an auto-sizing textarea in full mode', async () => {
      render(<TaskAddForm providers={[]} apps={[]} onTaskAdded={vi.fn()} />);
      await act(async () => {});
      const fullDesc = screen.getByPlaceholderText('Task description *');
      expect(fullDesc.tagName).toBe('TEXTAREA');
      expect(fullDesc).toHaveClass('resize-none');
      expect(fullDesc).toHaveClass('break-words');
    });

    it('renders task description as an auto-sizing textarea in compact mode', async () => {
      render(<TaskAddForm providers={[]} apps={[]} onTaskAdded={vi.fn()} compact />);
      await act(async () => {});
      const compactDesc = screen.getByPlaceholderText('Task description *');
      expect(compactDesc.tagName).toBe('TEXTAREA');
      expect(compactDesc).toHaveClass('resize-none');
      expect(compactDesc).toHaveClass('break-words');
    });

    it('submits on Enter without shiftKey, and preserves newlines when typing multi-line description', async () => {
      const user = userEvent.setup();
      const onTaskAdded = vi.fn();
      api.addCosTask.mockResolvedValue({ id: 'task-1', description: 'Line 1\nLine 2', status: 'pending', metadata: {} });

      render(<TaskAddForm providers={[]} apps={[]} onTaskAdded={onTaskAdded} />);
      await act(async () => {});
      const desc = screen.getByPlaceholderText('Task description *');

      // Type multi-line text using Shift+Enter
      await user.type(desc, 'Line 1{Shift>}{Enter}{/Shift}Line 2');
      expect(desc).toHaveValue('Line 1\nLine 2');

      // Press Enter to submit
      await user.type(desc, '{Enter}');
      await waitFor(() => expect(api.addCosTask).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Line 1\nLine 2' }),
        expect.anything()
      ));
    });
  });

  describe('orchestration mode and profile picker', () => {
    it('switches to orchestrated mode and passes orchestration profile on submit', async () => {
      const user = userEvent.setup();
      const onTaskAdded = vi.fn();
      api.getOrchestrationProfiles.mockResolvedValue({
        profiles: [
          {
            id: 'heavy-planner',
            name: 'Heavy Planner',
            profile: {
              architect: { provider: 'anthropic', model: 'claude-3-opus', effort: 'high' },
              implementer: { provider: 'anthropic', model: 'claude-3-5-sonnet', effort: 'medium' },
            },
          },
        ],
      });
      api.addCosTask.mockResolvedValue({ id: 'task-orch', description: 'Orchestrated task', status: 'pending', metadata: {} });

      render(
        <TaskAddForm
          providers={[
            { id: 'anthropic', name: 'Anthropic', enabled: true, models: ['claude-3-opus', 'claude-3-5-sonnet'] },
          ]}
          apps={[{ id: 'app-1', name: 'PortOS' }]}
          onTaskAdded={onTaskAdded}
        />
      );
      await act(async () => {});

      // Click "Orchestrated" mode button
      const orchBtn = screen.getByRole('button', { name: /Orchestrated/i });
      await user.click(orchBtn);

      // Select "Heavy Planner" profile
      const profileSelect = screen.getByLabelText(/Profile:/i);
      await user.selectOptions(profileSelect, 'heavy-planner');

      const desc = screen.getByPlaceholderText('Task description *');
      await user.type(desc, 'Orchestrated task');

      const submitBtn = screen.getByRole('button', { name: 'Add' });
      await user.click(submitBtn);

      await waitFor(() => {
        expect(api.addCosTask).toHaveBeenCalledWith(
          expect.objectContaining({
            description: 'Orchestrated task',
            orchestrationMode: 'orchestrated',
            orchestrationProfile: expect.objectContaining({
              architect: expect.objectContaining({ provider: 'anthropic', model: 'claude-3-opus', effort: 'high' }),
              implementer: expect.objectContaining({ provider: 'anthropic', model: 'claude-3-5-sonnet', effort: 'medium' }),
            }),
          }),
          expect.anything()
        );
      });
    });
  });
});

// #6306: a Codex task must not be queued against a model the signed-in ChatGPT
// account cannot run — and a cold/failed catalog must not empty the dropdown.
describe('TaskAddForm Codex model catalog', () => {
  const SHIPPED = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.4'];
  const codexProvider = (codexModelCatalog) => ({
    id: 'codex',
    name: 'Codex CLI',
    type: 'cli',
    command: 'codex',
    enabled: true,
    models: SHIPPED,
    codexModelCatalog,
  });

  const renderWithCodex = async (catalog) => {
    const user = userEvent.setup();
    render(
      <TaskAddForm
        providers={[codexProvider(catalog)]}
        apps={[{ id: 'example-app', name: 'Example App', repoPath: 'example.com/repo' }]}
        defaultApp="example-app"
        onTaskAdded={vi.fn()}
      />
    );
    await findEnabledByLabelText('AI provider');
    await user.selectOptions(screen.getByLabelText('AI provider'), 'codex');
    return user;
  };

  const modelValues = () =>
    Array.from(screen.getByLabelText('AI model').querySelectorAll('option'))
      .map((option) => option.value)
      .filter(Boolean);

  beforeEach(() => {
    vi.clearAllMocks();
    api.getCosPopularTemplates.mockResolvedValue({ templates: [] });
    api.getCodeReviewDefaults.mockResolvedValue(null);
    api.getLocalLlmStatus.mockResolvedValue({ ollama: { models: [] }, lmstudio: { models: [] } });
    api.getProviders.mockResolvedValue({ providers: [] });
    api.getAppWorkTracker.mockResolvedValue({ resolved: 'github' });
    api.getAppRepositorySources.mockResolvedValue({
      issueTargets: { default: 'origin', canChoose: false, origin: { fullName: 'example-org/example-app' }, upstream: { fullName: 'example-org/example-app' } },
    });
    api.applyCosTaskTemplate.mockResolvedValue({ success: true });
    api.getOrchestrationProfiles.mockResolvedValue({ profiles: [] });
    apiSystem.getAssignableInstances.mockResolvedValue({ instances: [] });
  });

  it('offers the signed-in account catalog, and never fetches one from a render', async () => {
    await renderWithCodex({ models: [{ id: 'gpt-5.4' }, { id: 'gpt-5.4-mini' }], fetchedAt: 1, error: null });

    expect(modelValues()).toEqual(['gpt-5.4', 'gpt-5.4-mini']);
    expect(screen.getByText(/signed-in ChatGPT account can run/i)).toBeInTheDocument();
    // Rendering a picker must not be what starts `codex app-server`.
    expect(api.getCodexModels).not.toHaveBeenCalled();
  });

  it('keeps the shipped list, and says so, when the catalog failed to load', async () => {
    await renderWithCodex({ models: null, fetchedAt: null, error: { code: 'protocol', message: 'boom' } });

    expect(modelValues()).toEqual(SHIPPED);
    expect(screen.getByText(/bundled list/i)).toBeInTheDocument();
  });

  it('explains a successfully-read empty catalog instead of rendering a blank control', async () => {
    await renderWithCodex({ models: [], fetchedAt: 1, error: null });

    expect(screen.queryByLabelText('AI model')).not.toBeInTheDocument();
    expect(screen.getByText(/exposes no models/i)).toBeInTheDocument();
  });
});

describe('TaskAddForm sole model auto-select', () => {
  const grok = {
    id: 'grok-cli',
    name: 'Grok',
    enabled: true,
    type: 'cli',
    command: 'grok',
    models: ['grok-configured-default', 'grok-4.6'],
    defaultModel: 'grok-4.6',
  };
  const multi = {
    id: 'claude',
    name: 'Claude Code',
    enabled: true,
    type: 'cli',
    command: 'claude',
    models: ['claude-opus-4-6', 'claude-sonnet-4-6'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.getCosPopularTemplates.mockResolvedValue({ templates: [] });
    api.getCodeReviewDefaults.mockResolvedValue(null);
    api.getLocalLlmStatus.mockResolvedValue({ ollama: { models: [] }, lmstudio: { models: [] } });
    api.getProviders.mockResolvedValue({ providers: [] });
    api.getAppWorkTracker.mockResolvedValue({ resolved: 'github' });
    api.getAppRepositorySources.mockResolvedValue({
      issueTargets: { default: 'origin', canChoose: false, origin: { fullName: 'example-org/example-app' }, upstream: { fullName: 'example-org/example-app' } },
    });
    api.getOrchestrationProfiles.mockResolvedValue({ profiles: [] });
    apiSystem.getAssignableInstances.mockResolvedValue({ instances: [] });
    api.addCosTask.mockResolvedValue({ success: true });
  });

  it('selects grok-4.6 when it is the only real model option', async () => {
    const user = userEvent.setup();
    render(<TaskAddForm providers={[grok]} apps={[]} onTaskAdded={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText('AI provider'), 'grok-cli');
    const model = screen.getByLabelText('AI model');
    expect(model).toHaveValue('grok-4.6');
    expect(Array.from(model.querySelectorAll('option')).map((option) => option.value)).toEqual(['grok-4.6']);

    await user.type(screen.getByPlaceholderText('Task description *'), 'Ship the change');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await waitFor(() => expect(api.addCosTask).toHaveBeenCalled());
    expect(api.addCosTask.mock.calls.at(-1)[0]).toMatchObject({
      provider: 'grok-cli',
      model: 'grok-4.6',
    });
  });

  it('leaves the model unset when the provider lists more than one option', async () => {
    const user = userEvent.setup();
    render(<TaskAddForm providers={[multi]} apps={[]} onTaskAdded={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText('AI provider'), 'claude');
    const model = screen.getByLabelText('AI model');
    expect(model).toHaveValue('');
    expect(Array.from(model.querySelectorAll('option')).map((option) => option.value)).toEqual([
      '',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
    ]);
  });

  it('clears an auto-selected model when switching to a multi-model provider', async () => {
    const user = userEvent.setup();
    render(<TaskAddForm providers={[grok, multi]} apps={[]} onTaskAdded={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText('AI provider'), 'grok-cli');
    expect(screen.getByLabelText('AI model')).toHaveValue('grok-4.6');

    await user.selectOptions(screen.getByLabelText('AI provider'), 'claude');
    expect(screen.getByLabelText('AI model')).toHaveValue('');
  });
});

describe('TaskAddForm layout ordering', () => {
  it('renders screenshot and attach buttons next to the task description input', async () => {
    render(<TaskAddForm providers={[]} apps={[{ id: 'portos', name: 'PortOS' }]} onTaskAdded={vi.fn()} />);
    await act(async () => {});

    const desc = screen.getByPlaceholderText('Task description *');
    const screenshotBtn = screen.getByLabelText('Attach screenshots');
    const attachBtn = screen.getByLabelText('Attach files');

    expect(screenshotBtn).toBeInTheDocument();
    expect(attachBtn).toBeInTheDocument();

    // Verify screenshot and attach buttons sit in the same row/container as the description textarea
    const descRow = desc.closest('div.flex-col');
    expect(descRow).toBeInTheDocument();
    expect(descRow.contains(screenshotBtn)).toBe(true);
    expect(descRow.contains(attachBtn)).toBe(true);
  });

  it('places execution method and provider selector just under the description textarea, before app and options', async () => {
    render(
      <TaskAddForm
        providers={[{ id: 'anthropic', name: 'Anthropic', enabled: true, models: ['claude-3-5-sonnet'] }]}
        apps={[{ id: 'portos', name: 'PortOS' }]}
        onTaskAdded={vi.fn()}
      />
    );
    await act(async () => {});

    const desc = screen.getByPlaceholderText('Task description *');
    const directBtn = screen.getByRole('button', { name: 'Direct' });
    const providerSelect = screen.getByLabelText('AI provider');
    const appSelect = screen.getByLabelText('Target application');

    // Verify strict DOM ordering: description -> Execution method -> Provider selector -> App context
    expect(desc.compareDocumentPosition(directBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(directBtn.compareDocumentPosition(providerSelect) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(providerSelect.compareDocumentPosition(appSelect) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders upload controls in compact mode when expanded', async () => {
    render(<TaskAddForm providers={[]} apps={[{ id: 'portos', name: 'PortOS' }]} onTaskAdded={vi.fn()} compact defaultExpanded />);
    await act(async () => {});

    expect(screen.getByLabelText('Attach screenshots')).toBeInTheDocument();
    expect(screen.getByLabelText('Attach files')).toBeInTheDocument();
  });

  it('renders an Add button at the bottom next to queue position selector in queueFirst mode when expanded', async () => {
    const user = userEvent.setup();
    api.addCosTask.mockResolvedValue({ id: 'bottom-task' });
    render(<TaskAddForm queueFirst providers={[]} apps={[{ id: 'portos', name: 'PortOS' }]} onTaskAdded={vi.fn()} />);
    await act(async () => {});

    await user.type(screen.getByRole('textbox', { name: /Task description/ }), 'Test task from bottom button');
    await user.click(screen.getByRole('button', { name: 'Task configuration' }));

    const queueLabel = screen.getByText('Queue:');
    expect(queueLabel).toBeInTheDocument();

    const bottomContainer = queueLabel.closest('div.flex-wrap');
    expect(bottomContainer).toBeInTheDocument();

    const bottomAddButton = within(bottomContainer).getByRole('button', { name: 'Add' });
    expect(bottomAddButton).toBeInTheDocument();

    await user.click(bottomAddButton);
    expect(api.addCosTask).toHaveBeenCalledWith(expect.objectContaining({ description: 'Test task from bottom button' }), { silent: true });
  });
});


// A CoS task's `provider` accepts either provider-reference grammar
// (`providerRefSchema`), so the preset-first picker's "Custom combination…"
// flow can legitimately put a COMPOSITE id in this field. A composite is never
// in the preset list, so the "pinned provider is no longer selectable" reset
// has to exempt it or the selection is wiped the render after it is made.
describe('TaskAddForm composite provider pins', () => {
  const COMPOSITE = 'claude.tui@ollama';
  const preset = { id: 'claude', name: 'Claude Code', enabled: true, type: 'cli', command: 'claude', models: ['claude-opus-4-6'] };

  beforeEach(() => {
    vi.clearAllMocks();
    api.getCodeReviewDefaults.mockResolvedValue(null);
    api.getLocalLlmStatus.mockResolvedValue({ ollama: { models: [] }, lmstudio: { models: [] } });
    api.getProviders.mockResolvedValue({ providers: [] });
    api.getAppWorkTracker.mockResolvedValue({ resolved: 'github' });
    api.getOrchestrationProfiles.mockResolvedValue({ profiles: [] });
    apiSystem.getAssignableInstances.mockResolvedValue({ instances: [] });
    api.applyCosTaskTemplate.mockResolvedValue({ success: true });
    api.addCosTask.mockResolvedValue({ success: true });
    api.getProviderCatalog.mockResolvedValue({ harnesses: [], services: [], bootstraps: [], presets: [] });
  });

  const queueWithTemplateProvider = async (provider) => {
    const user = userEvent.setup();
    api.getCosPopularTemplates.mockResolvedValue({
      templates: [{ id: 'user-pin', name: 'Pinned Template', description: 'Do the thing', isBuiltin: false, provider }],
    });
    render(<TaskAddForm providers={[preset]} apps={[]} onTaskAdded={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Quick Templates')).toBeInTheDocument());
    await user.click(screen.getByText('Quick Templates'));
    await user.click(screen.getByText('Pinned Template'));
    await waitFor(() => expect(api.applyCosTaskTemplate).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await waitFor(() => expect(api.addCosTask).toHaveBeenCalled());
    return api.addCosTask.mock.calls.at(-1)[0];
  };

  it('keeps a composite pin the preset list cannot name', async () => {
    expect(await queueWithTemplateProvider(COMPOSITE)).toMatchObject({ provider: COMPOSITE });
  });

  it('still clears a PRESET pin that is no longer selectable', async () => {
    expect(await queueWithTemplateProvider('retired-preset')).not.toMatchObject({ provider: 'retired-preset' });
  });
});

// #7588: the main picker skipped `highlightToolUse`, so a task queued onto a
// local model that can't call tools got no marker and no warning — the failure
// is silent, since the agent narrates instead of writing anything.
describe('TaskAddForm tool-use warning', () => {
  const WARNING = /recognized tool-calling model/i;
  const ollamaProvider = {
    id: 'opencode-ollama', name: 'OpenCode Ollama', enabled: true, type: 'tui',
    command: 'opencode', ollamaBacked: true, models: ['gemma2:9b', 'qwen3.6:35b'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    __resetToolUseModelIdsCache();
    api.getCosPopularTemplates.mockResolvedValue({ templates: [] });
    api.getCodeReviewDefaults.mockResolvedValue(null);
    api.getLocalLlmStatus.mockResolvedValue({ ollama: { models: [] }, lmstudio: { models: [] } });
    api.getProviders.mockResolvedValue({ providers: [] });
    api.getAppWorkTracker.mockResolvedValue({ resolved: 'github' });
    api.getOrchestrationProfiles.mockResolvedValue({ profiles: [] });
    apiSystem.getAssignableInstances.mockResolvedValue({ instances: [] });
    apiLocalLlm.getToolUseModels.mockResolvedValue({ models: [] });
  });

  it('warns when pinned to a local model with no known tool use', async () => {
    const user = userEvent.setup();
    render(<TaskAddForm providers={[ollamaProvider]} apps={[]} onTaskAdded={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText('AI provider'), 'opencode-ollama');
    await user.selectOptions(screen.getByLabelText('AI model'), 'gemma2:9b');

    expect(await screen.findByText(WARNING)).toBeInTheDocument();
  });

  it('does not warn when pinned to a tool-capable local model', async () => {
    const user = userEvent.setup();
    render(<TaskAddForm providers={[ollamaProvider]} apps={[]} onTaskAdded={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText('AI provider'), 'opencode-ollama');
    await user.selectOptions(screen.getByLabelText('AI model'), 'qwen3.6:35b');

    await waitFor(() => expect(apiLocalLlm.getToolUseModels).toHaveBeenCalled());
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });
});
