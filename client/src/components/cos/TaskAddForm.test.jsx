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
  applyCosTaskTemplate: vi.fn(),
  addCosTask: vi.fn()
}));

// useAssignableInstances reads the instance registry straight off apiSystem, so
// the picker (#4520) has to be driven from there rather than the `api` barrel.
const apiSystem = vi.hoisted(() => ({ getAssignableInstances: vi.fn() }));
vi.mock('../../services/apiSystem', () => apiSystem);
vi.mock('../../services/api', () => api);

describe('TaskAddForm responsive layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getCosPopularTemplates.mockResolvedValue({ templates: [] });
    api.getCodeReviewDefaults.mockResolvedValue(null);
    api.getLocalLlmStatus.mockResolvedValue({ ollama: { models: [] }, lmstudio: { models: [] } });
    api.getProviders.mockResolvedValue({ providers: [] });
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
});

// A slashdo quick-template carries the run shape its workflow implies (#3089).
// `settings` keys are tri-state: absent means "leave the toggle alone", `false`
// means "turn it off" — collapsing the two would make a plain user template
// silently clear toggles it never meant to touch.
describe('TaskAddForm quick templates', () => {
  const worktreeToggle = () => screen.getByTitle(/isolated git worktree/i).closest('label').querySelector('input');
  const openTemplates = async (user) => {
    await waitFor(() => expect(screen.getByText('Quick Templates')).toBeInTheDocument());
    await user.click(screen.getByText('Quick Templates'));
  };
  const renderForm = () => render(
    <TaskAddForm
      providers={[]}
      apps={[{ id: 'example-app', name: 'Example App', repoPath: 'example.com/repo', defaultOpenPR: true, defaultUseWorktree: true }]}
      defaultApp="example-app"
      onTaskAdded={vi.fn()}
    />
  );

  beforeEach(() => {
    vi.clearAllMocks();
    api.getCodeReviewDefaults.mockResolvedValue(null);
    api.getLocalLlmStatus.mockResolvedValue({ ollama: { models: [] }, lmstudio: { models: [] } });
    api.getProviders.mockResolvedValue({ providers: [] });
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

    // The app defaults turned the worktree on; the template turns it back off.
    expect(worktreeToggle()).toBeChecked();
    await user.click(screen.getByText('Plan a Task'));

    await waitFor(() => expect(worktreeToggle()).not.toBeChecked());
    expect(screen.getByPlaceholderText('Task description *')).toHaveValue('Investigate and file an issue for: ');
    expect(api.applyCosTaskTemplate).toHaveBeenCalledWith('builtin-do-plan-task');
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
