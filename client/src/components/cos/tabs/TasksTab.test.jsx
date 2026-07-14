import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

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

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosLearningDurations.mockResolvedValue(null);
});

describe('TasksTab Run Now', () => {
  it('does not toast success when the evaluate request fails', async () => {
    api.forceCosEvaluate.mockRejectedValue(new Error('offline'));
    render(<TasksTab tasks={emptyTasks} onRefresh={vi.fn()} providers={[]} apps={[]} />);

    fireEvent.click(screen.getByRole('button', { name: /Run tasks now/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('offline'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('toasts success only after the evaluate request resolves', async () => {
    api.forceCosEvaluate.mockResolvedValue({ success: true });
    render(<TasksTab tasks={emptyTasks} onRefresh={vi.fn()} providers={[]} apps={[]} />);

    fireEvent.click(screen.getByRole('button', { name: /Run tasks now/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Evaluation triggered'));
    expect(toast.error).not.toHaveBeenCalled();
  });
});
