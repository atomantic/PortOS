import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('../../../../services/apiMoodBoard.js', () => ({
  listMoodBoardNames: vi.fn(async () => [{ id: 'mb-1', name: 'Neon Rain' }]),
}));
vi.mock('../../../../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [], selectedProviderId: '', selectedModel: '', availableModels: [],
    setSelectedProviderId: () => {}, setSelectedModel: () => {},
  }),
}));

import MusicVideoAutopilotSettings from './MusicVideoAutopilotSettings';

afterEach(cleanup);

describe('MusicVideoAutopilotSettings', () => {
  it('loads the saved params, saves edits into taskMetadata.musicVideoAutopilot, and keeps unedited fields', async () => {
    const onUpdate = vi.fn(async () => {});
    const setUpdating = vi.fn();
    const config = {
      taskMetadata: {
        musicVideoAutopilot: { tools: ['image:local'], budgetUsd: 3, ideaTags: ['song'], limits: { maxGenerations: 10, maxReviewAttempts: 5 }, moodBoardId: 'mb-1' },
      },
    };
    render(<MusicVideoAutopilotSettings taskType="music-video-autopilot" config={config} onUpdate={onUpdate} updating={false} setUpdating={setUpdating} />);

    expect(screen.getByLabelText('Budget cap (USD)').value).toBe('3');
    expect(screen.getByLabelText('Brain idea tags (optional)').value).toBe('song');
    await waitFor(() => expect(screen.getByLabelText('Mood board').value).toBe('mb-1'));

    fireEvent.change(screen.getByLabelText('Budget cap (USD)'), { target: { value: '8' } });
    fireEvent.click(screen.getByLabelText('Instrumental (no vocals)'));
    fireEvent.click(screen.getByText('Save settings'));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    const [type, payload] = onUpdate.mock.calls[0];
    expect(type).toBe('music-video-autopilot');
    expect(payload.taskMetadata.musicVideoAutopilot).toMatchObject({
      tools: ['image:local'], budgetUsd: 8, instrumental: true, ideaTags: ['song'], moodBoardId: 'mb-1',
      limits: { maxGenerations: 10, maxReviewAttempts: 5 },
    });
  });

  it('round-trips the song source and the Suno fallback opt-in through the saved params', async () => {
    const onUpdate = vi.fn(async () => {});
    const config = { taskMetadata: { musicVideoAutopilot: { songSource: 'suno', localFallback: true } } };
    render(<MusicVideoAutopilotSettings taskType="music-video-autopilot" config={config} onUpdate={onUpdate} updating={false} setUpdating={() => {}} />);
    expect(screen.getByLabelText('Render locally if Suno is unavailable').checked).toBe(true);
    fireEvent.change(screen.getByLabelText('Song source'), { target: { value: 'local' } });
    fireEvent.click(screen.getByText('Save settings'));
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    expect(onUpdate.mock.calls[0][1].taskMetadata.musicVideoAutopilot).toMatchObject({ songSource: 'local', localFallback: false });
  });

  it('keeps a saved writer-LLM pin when saved before the provider catalog loads', async () => {
    const onUpdate = vi.fn(async () => {});
    const config = { taskMetadata: { musicVideoAutopilot: { llm: { providerId: 'prov-1', model: 'm-1' } } } };
    render(<MusicVideoAutopilotSettings taskType="music-video-autopilot" config={config} onUpdate={onUpdate} updating={false} setUpdating={() => {}} />);
    fireEvent.click(screen.getByText('Save settings'));
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    expect(onUpdate.mock.calls[0][1].taskMetadata.musicVideoAutopilot.llm).toEqual({ providerId: 'prov-1', model: 'm-1' });
  });
});
