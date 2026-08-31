import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TaskAddForm from './TaskAddForm';

const api = vi.hoisted(() => ({
  getCosPopularTemplates: vi.fn(),
  getCodeReviewDefaults: vi.fn(),
  // Back the reviewer table's Model column (useReviewerModelOptions).
  getLocalLlmStatus: vi.fn(),
  getProviders: vi.fn(),
  getAppWorkTracker: vi.fn(),
  applyCosTaskTemplate: vi.fn(),
  addCosTask: vi.fn()
}));

// useAssignableInstances reads the instance registry straight off apiSystem, so
// the picker (#4520) has to be driven from there rather than the `api` barrel.
const apiSystem = vi.hoisted(() => ({ getAssignableInstances: vi.fn() }));
const toast = vi.hoisted(() => {
  const toastFn = vi.fn();
  toastFn.success = vi.fn();
  toastFn.error = vi.fn();
  toastFn.warning = vi.fn();
  return toastFn;
});
vi.mock('../../services/apiSystem', () => apiSystem);
vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: toast }));

const worktreeToggle = () => screen.getByTitle(/isolated git worktree/i).closest('label').querySelector('input');
const openPrToggle = () => screen.getByTitle(/Open a pull request/i).closest('label').querySelector('input');
const planOnlyToggle = () => screen.getByLabelText(/Plan & file issue/i);

describe('TaskAddForm responsive layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getCosPopularTemplates.mockResolvedValue({ templates: [] });
    api.getCodeReviewDefaults.mockResolvedValue(null);
    api.getLocalLlmStatus.mockResolvedValue({ ollama: { models: [] }, lmstudio: { models: [] } });
    api.getProviders.mockResolvedValue({ providers: [] });
    api.getAppWorkTracker.mockResolvedValue({ resolved: 'github' });
    api.applyCosTaskTemplate.mockResolvedValue({ success: true });
    apiSystem.getAssignableInstances.mockResolvedValue({ instances: [] });
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
});
