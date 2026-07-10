import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  updateCosTask: vi.fn(),
  deleteCosTask: vi.fn(),
  approveCosTask: vi.fn(),
  forceSpawnTask: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('../../../services/api', () => api);
vi.mock('../../ui/Toast', () => ({ default: toast }));

const TaskItem = (await import('./TaskItem')).default;

const task = {
  id: 'sys-model-edit',
  description: 'Reference repo review',
  status: 'pending',
  metadata: { provider: 'codex-tui', model: 'gpt-5.6-terra' },
};
const providers = [{ id: 'codex-tui', name: 'Codex TUI', enabled: true, models: ['gpt-5.6-terra'] }];

beforeEach(() => {
  vi.clearAllMocks();
  api.updateCosTask.mockResolvedValue({ ...task });
});

describe('TaskItem task source', () => {
  it('updates a system task in the internal queue when saving its model', async () => {
    render(<TaskItem task={task} isSystem onRefresh={vi.fn()} providers={providers} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateCosTask).toHaveBeenCalledWith(
      'sys-model-edit',
      expect.objectContaining({
        provider: 'codex-tui',
        model: 'gpt-5.6-terra',
        type: 'internal',
      }),
      { silent: true },
    ));
  });

  it('updates an approval-gated task in the internal queue when changing status', async () => {
    render(<TaskItem task={task} awaitingApproval onRefresh={vi.fn()} providers={providers} />);

    fireEvent.click(screen.getByRole('button', { name: /Status: pending/i }));

    await waitFor(() => expect(api.updateCosTask).toHaveBeenCalledWith(
      'sys-model-edit',
      { status: 'completed', type: 'internal' },
      { silent: true },
    ));
  });
});
