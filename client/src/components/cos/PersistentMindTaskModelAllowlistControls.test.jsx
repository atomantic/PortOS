import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({
  getProviders: vi.fn(),
  updateCosConfig: vi.fn(),
}));

vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import PersistentMindTaskModelAllowlistControls from './PersistentMindTaskModelAllowlistControls.jsx';

describe('PersistentMindTaskModelAllowlistControls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'ollama', name: 'Ollama', type: 'cli', enabled: true, models: ['example-local', 'example-other'] }],
    });
    api.updateCosConfig.mockResolvedValue({ success: true });
  });

  it('adds an exact provider/model pair and persists the restriction', async () => {
    const user = userEvent.setup();
    render(<PersistentMindTaskModelAllowlistControls capabilities={{ createTasks: true, taskModelAllowlist: [] }} />);

    await user.click(await screen.findByRole('button', { name: 'Add model' }));

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith({
      persistentMindCapabilities: {
        schemaVersion: 3,
        createTasks: true,
        readPortos: false,
        writePortos: false,
        taskModelAllowlist: [{ providerId: 'ollama', model: 'example-local' }],
      },
    }, { silent: true }));
    expect(screen.getByLabelText('Model')).toHaveValue('example-local');
  });
});
