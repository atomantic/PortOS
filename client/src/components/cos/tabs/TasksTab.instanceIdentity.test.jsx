import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const identityApi = vi.hoisted(() => ({ getAssignableInstances: vi.fn() }));
const api = vi.hoisted(() => ({ getCosLearningDurations: vi.fn(), recheckCosAgentCleanup: vi.fn() }));
vi.mock('../../../services/apiSystem', () => identityApi);
vi.mock('../../../services/api', () => api);
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('./AgentCard', () => ({ default: () => null }));
vi.mock('../TaskAddForm', () => ({ default: () => null }));

const TasksTab = (await import('./TasksTab')).default;
const task = { id: 'held-task', description: 'Held cleanup', status: 'in_progress',
  metadata: { claimedBy: 'local-id', deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-owner' } };
const owner = { id: 'agent-owner', taskId: task.id, status: 'completed', result: { cleanupPending: true } };
const renderQueue = () => render(<MemoryRouter><TasksTab tasks={{ user: { tasks: [] }, cos: { tasks: [task] } }}
  agents={[owner]} onRefresh={vi.fn()} providers={[]} apps={[]} /></MemoryRouter>);

beforeEach(() => {
  vi.resetAllMocks();
  api.getCosLearningDurations.mockResolvedValue(null);
});

describe('retrying instance identity on an unconfirmed cleanup task', () => {
  it.each(['failed', 'empty'])('recovers from a %s identity read without reloading the page', async firstResult => {
    if (firstResult === 'failed') identityApi.getAssignableInstances.mockRejectedValueOnce(new Error('offline'));
    else identityApi.getAssignableInstances.mockResolvedValueOnce({ instances: [] });
    let finishRetry;
    identityApi.getAssignableInstances.mockImplementationOnce(() => new Promise(resolve => { finishRetry = resolve; }));
    renderQueue();

    expect(await screen.findByText('Activity unconfirmed (1)')).toBeInTheDocument();
    const retry = await screen.findByRole('button', { name: 'Retry instance identity' });
    expect(screen.queryByRole('button', { name: 'Retry cleanup' })).toBeNull();
    fireEvent.click(retry);
    await waitFor(() => expect(finishRetry).toBeTypeOf('function'));
    expect(screen.getByRole('button', { name: 'Checking instance identity…' })).toBeDisabled();
    await act(async () => finishRetry({ instances: [{ instanceId: 'local-id', isSelf: true }] }));

    expect(await screen.findByText('Pending (1)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry cleanup' })).toBeInTheDocument();
    expect(identityApi.getAssignableInstances).toHaveBeenCalledTimes(2);
    expect(api.recheckCosAgentCleanup).not.toHaveBeenCalled();
  });

  it('words a failed identity read as unidentified, not still loading', async () => {
    identityApi.getAssignableInstances.mockRejectedValueOnce(new Error('offline'));
    renderQueue();
    expect(await screen.findByRole('button', { name: 'Retry instance identity' })).toBeInTheDocument();
    expect(screen.queryByText(/identity is loading/)).toBeNull();
  });

  it('keeps a differently claimed task unconfirmed after identity is recovered', async () => {
    identityApi.getAssignableInstances.mockResolvedValueOnce({ instances: [] })
      .mockResolvedValueOnce({ instances: [{ instanceId: 'other-id', isSelf: true }] });
    renderQueue();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry instance identity' }));
    expect(await screen.findByText(/A different instance claimed this task/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry cleanup' })).toBeNull();
  });
});
