import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// Regression coverage for #2519 — the "Run Now" evaluate button must only toast
// success after the request resolves.
const api = vi.hoisted(() => ({
  forceCosEvaluate: vi.fn(),
  getCosLearningDurations: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('../../../services/api', () => api);
vi.mock('../../ui/Toast', () => ({ default: toast }));
// TaskAddForm pulls in provider/model plumbing not under test — stub it out.
vi.mock('../TaskAddForm', () => ({ default: () => null }));

const TasksTab = (await import('./TasksTab')).default;

const emptyTasks = { user: { tasks: [] }, cos: { tasks: [] } };
const renderTab = (props = {}, route = '/cos/tasks') => render(
  <MemoryRouter initialEntries={[route]}>
    <TasksTab tasks={emptyTasks} onRefresh={vi.fn()} providers={[]} apps={[]} {...props} />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosLearningDurations.mockResolvedValue(null);
});

describe('TasksTab Run Now', () => {
  it('does not toast success when the evaluate request fails', async () => {
    api.forceCosEvaluate.mockRejectedValue(new Error('offline'));
    renderTab();

    fireEvent.click(screen.getByRole('button', { name: /Run tasks now/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('offline'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('toasts success only after the evaluate request resolves', async () => {
    api.forceCosEvaluate.mockResolvedValue({ success: true });
    renderTab();

    fireEvent.click(screen.getByRole('button', { name: /Run tasks now/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Evaluation triggered'));
    expect(toast.error).not.toHaveBeenCalled();
    // Must pass { silent: true } so the custom catch is the only error toast.
    expect(api.forceCosEvaluate).toHaveBeenCalledWith({ silent: true });
  });

  it('opens and focuses the task identified by the queue deep link', async () => {
    const task = { id: 'task-example', description: 'Review an example task', status: 'completed', metadata: {} };
    renderTab({ tasks: { user: { tasks: [task] }, cos: { tasks: [] } } }, '/cos/tasks?task=task-example&source=user');

    await waitFor(() => expect(document.getElementById('cos-task-user-task-example')).not.toBeNull());
    const row = document.getElementById('cos-task-user-task-example');
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(row).toHaveFocus();
  });
});
