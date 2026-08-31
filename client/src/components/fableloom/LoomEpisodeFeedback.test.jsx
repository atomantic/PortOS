import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/api', () => ({
  feedbackLoomEpisode: vi.fn(),
  getProviders: vi.fn(),
}));
vi.mock('../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn() },
}));

import * as api from '../../services/api';
import LoomEpisodeFeedback from './LoomEpisodeFeedback';

const loom = { id: 'loom-1', name: 'Example Loom' };
const episode = { id: 'ep-1', number: 1, title: 'Pilot' };
const providers = [{
  id: 'codex',
  name: 'Codex',
  type: 'cli',
  command: 'codex',
  enabled: true,
  defaultModel: 'gpt-5',
  models: ['gpt-5'],
}];

beforeEach(() => {
  vi.clearAllMocks();
  api.getProviders.mockResolvedValue({ activeProvider: 'codex', providers });
  api.feedbackLoomEpisode.mockResolvedValue({ loom: { ...loom }, changedScenes: 1 });
});

describe('LoomEpisodeFeedback', () => {
  it('submits conversational feedback with the selected provider, model, and effort', async () => {
    const user = userEvent.setup();
    const onLoomUpdate = vi.fn();
    const onFeedbackStarted = vi.fn();
    render(
      <LoomEpisodeFeedback
        open
        loom={loom}
        episode={episode}
        onLoomUpdate={onLoomUpdate}
        onFeedbackStarted={onFeedbackStarted}
      />,
    );

    await user.type(await screen.findByLabelText('What should change?'), 'Make the opening urgent.');
    await user.selectOptions(screen.getByLabelText('AI route'), 'codex');
    await user.selectOptions(screen.getByLabelText('Model'), 'gpt-5');
    await user.selectOptions(screen.getByLabelText('Thinking effort'), 'high');
    await user.click(screen.getByRole('button', { name: 'Apply AI feedback' }));

    await waitFor(() => expect(api.feedbackLoomEpisode).toHaveBeenCalledWith(
      'loom-1',
      'ep-1',
      expect.objectContaining({
        feedback: 'Make the opening urgent.', providerId: 'codex', model: 'gpt-5', effort: 'high',
        operationId: expect.any(String),
      }),
      { silent: true },
    ));
    expect(onFeedbackStarted).toHaveBeenCalledTimes(1);
    expect(onLoomUpdate).toHaveBeenCalledWith({ ...loom });
  });

  it('keeps the AI action disabled until feedback text exists', async () => {
    render(
      <LoomEpisodeFeedback
        open
        loom={loom}
        episode={episode}
        onLoomUpdate={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply AI feedback' })).toBeDisabled());
    expect(api.feedbackLoomEpisode).not.toHaveBeenCalled();
  });
});
