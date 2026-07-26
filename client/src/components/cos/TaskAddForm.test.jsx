import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TaskAddForm from './TaskAddForm';

const api = vi.hoisted(() => ({
  getCosPopularTemplates: vi.fn(),
  getCodeReviewDefaults: vi.fn(),
  useCosTaskTemplate: vi.fn()
}));

vi.mock('../../services/api', () => api);

describe('TaskAddForm responsive layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getCosPopularTemplates.mockResolvedValue({ templates: [] });
    api.getCodeReviewDefaults.mockResolvedValue(null);
    api.useCosTaskTemplate.mockResolvedValue({ success: true });
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
    api.useCosTaskTemplate.mockResolvedValue({ success: true });
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
    expect(api.useCosTaskTemplate).toHaveBeenCalledWith('builtin-do-plan-task');
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
