import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  createFeatureAgent: vi.fn(),
  getToolUseModels: vi.fn(),
}));
const providerHook = vi.hoisted(() => ({
  providers: [{
    id: 'codex',
    name: 'Codex',
    type: 'cli',
    enabled: true,
    defaultModel: 'gpt-5',
    models: ['gpt-5'],
  }],
  activeProviderId: 'codex',
}));

vi.mock('../../services/api', () => api);
vi.mock('../../services/apiLocalLlm', () => ({ getToolUseModels: api.getToolUseModels }));
vi.mock('../../hooks/useProviderModels', () => ({ default: () => providerHook }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import ConfigTab from './ConfigTab.jsx';

beforeEach(() => {
  vi.clearAllMocks();
  api.getToolUseModels.mockResolvedValue({ models: [] });
  api.createFeatureAgent.mockResolvedValue({ id: 'fa-example' });
});

describe('Feature agent AI provider controls', () => {
  it('uses the shared provider/model/effort selectors and persists their choices', async () => {
    render(<ConfigTab isCreate apps={[{ id: 'app-example', name: 'Example App' }]} />);

    expect(screen.queryByLabelText('Provider ID')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Model')).toBeInTheDocument();
    expect(screen.getByLabelText('Provider')).toHaveValue('');

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'codex' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5' } });
    fireEvent.change(screen.getByLabelText('Thinking effort'), { target: { value: 'high' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Example Agent' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Improve the example app' } });
    fireEvent.change(screen.getByLabelText('App'), { target: { value: 'app-example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));

    await waitFor(() => expect(api.createFeatureAgent).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'codex',
      model: 'gpt-5',
      effort: 'high',
    }), { silent: true }));
  });
});
