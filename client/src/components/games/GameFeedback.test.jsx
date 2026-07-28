import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../hooks/useProviderModels.js', () => ({
  default: () => ({
    providers: [{
      id: 'codex',
      name: 'Codex',
      command: 'codex',
      enabled: true,
      defaultModel: 'gpt-5.6-terra',
      models: ['gpt-5.6-terra'],
    }],
    selectedProviderId: 'codex',
    selectedModel: 'gpt-5.6-terra',
    availableModels: ['gpt-5.6-terra'],
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
    loading: false,
  }),
}));

import GameFeedback from './GameFeedback.jsx';

describe('GameFeedback', () => {
  it('submits the selected provider, model, effort, and review prompt', async () => {
    const onSubmit = vi.fn(async () => true);
    render(<GameFeedback history={[]} submitting={false} onSubmit={onSubmit} />);

    await userEvent.selectOptions(screen.getByLabelText('Thinking effort'), 'high');
    await userEvent.type(screen.getByLabelText('Review request'), 'Find missing gameplay assets.');
    await userEvent.click(screen.getByRole('button', { name: 'Request feedback' }));

    expect(onSubmit).toHaveBeenCalledWith({
      providerId: 'codex',
      model: 'gpt-5.6-terra',
      effort: 'high',
      prompt: 'Find missing gameplay assets.',
    });
  });

  it('renders persisted feedback history', () => {
    render(
      <GameFeedback
        submitting={false}
        onSubmit={vi.fn()}
        history={[{
          id: 'feedback-1',
          prompt: 'Review the plan.',
          text: 'Add a victory cue.',
          providerId: 'codex',
          model: 'gpt-5.6-terra',
          effort: 'medium',
          createdAt: '2026-01-02T00:00:00.000Z',
        }]}
      />,
    );
    expect(screen.getByText('Add a victory cue.')).toBeInTheDocument();
    expect(screen.getByText('Review the plan.')).toBeInTheDocument();
  });
});
