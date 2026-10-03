import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
const api = vi.hoisted(() => ({ getProviders: vi.fn(), updateCosConfig: vi.fn() }));
vi.mock('../../services/api', () => api);
import PersistentMindSandboxControls from './PersistentMindSandboxControls.jsx';
beforeEach(() => {
  vi.clearAllMocks();
  api.getProviders.mockResolvedValue({ providers: [
    { id: 'free-api', name: 'Free API', type: 'api', models: ['openrouter/free'] },
    { id: 'trusted-api', name: 'Trusted API', type: 'api', models: ['example-evaluator'] },
    { id: 'coding-cli', name: 'Coding CLI', type: 'cli', models: ['example-cli'] },
  ] });
});

it('offers only APIs and saves a separate worker/evaluator policy without changing task grants', async () => {
  const user = userEvent.setup();
  const saved = vi.fn();
  api.updateCosConfig.mockResolvedValue({ persistentMindCapabilities: { delegateSandbox: true, createTasks: false } });
  render(<PersistentMindSandboxControls capabilities={{ createTasks: false }} onSaved={saved} />);
  await waitFor(() => expect(screen.getByLabelText('Evaluator provider')).toHaveTextContent('Trusted API'));
  expect(screen.getByLabelText('Evaluator provider')).not.toHaveTextContent('Coding CLI');
  await user.click(screen.getByLabelText('Allow tool-free delegation'));
  expect(screen.getByRole('button', { name: 'Save delegation access' })).toBeDisabled();
  await user.selectOptions(screen.getByLabelText('Evaluator provider'), 'trusted-api');
  await user.click(screen.getByRole('button', { name: 'Add worker' }));
  await user.selectOptions(screen.getByLabelText('Worker 1 provider'), 'free-api');
  await user.click(screen.getByRole('button', { name: 'Save delegation access' }));
  expect(api.updateCosConfig).toHaveBeenCalledWith({ persistentMindCapabilities: {
    delegateSandbox: true, sandboxDelegation: { workers: [{ providerId: 'free-api', model: 'openrouter/free' }], evaluator: { providerId: 'trusted-api', model: 'example-evaluator' } },
  } }, { silent: true });
  expect(saved).toHaveBeenCalledWith({ delegateSandbox: true, createTasks: false });
});

it('prevents self evaluation and preserves failed saves as editable drafts', async () => {
  const user = userEvent.setup();
  const saved = vi.fn();
  api.updateCosConfig.mockRejectedValue(new Error('Save unavailable'));
  render(<PersistentMindSandboxControls capabilities={{ delegateSandbox: true, sandboxDelegation: {
    workers: [{ providerId: 'free-api', model: 'openrouter/free' }], evaluator: { providerId: 'free-api', model: 'openrouter/free' },
  } }} onSaved={saved} />);
  await waitFor(() => expect(screen.getByLabelText('Evaluator provider')).toHaveTextContent('Trusted API'));
  expect(screen.getByRole('button', { name: 'Save delegation access' })).toBeDisabled();
  await user.selectOptions(screen.getByLabelText('Evaluator provider'), 'trusted-api');
  await user.click(screen.getByRole('button', { name: 'Save delegation access' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Save unavailable');
  expect(screen.getByLabelText('Evaluator provider')).toHaveValue('trusted-api');
  expect(saved).not.toHaveBeenCalled();
});
