import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('../../../../services/apiMoodBoard.js', () => ({
  listMoodBoardNames: vi.fn(async () => [{ id: 'mb-1', name: 'Neon Rain' }]),
}));
vi.mock('../../../../services/apiMusic.js', () => ({
  listMusicEngines: vi.fn(async () => ({ engines: [{ id: 'acestep', name: 'ACE-Step', ready: true, lyrics: true }] })),
}));
vi.mock('../../../../services/apiImageVideo.js', () => ({
  getVideoGenModelContext: vi.fn(async () => ({
    models: [
      { id: 'example-ltx', name: 'Example LTX' },
      { id: 'example-wan', name: 'Example Wan' },
    ],
    defaultModel: 'example-ltx',
  })),
}));
vi.mock('../../../../hooks/useProviderModels', () => ({
  default: ({ filter } = {}) => ({
    providers: filter ? [{ id: 'fixture-api', name: 'Fixture API', type: 'api', enabled: true, defaultModel: 'fixture-model', models: ['fixture-model'] }].filter(filter) : [],
    selectedProviderId: '', selectedModel: '', availableModels: filter ? ['fixture-model'] : [],
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
    fireEvent.change(screen.getByLabelText('Design and composition media'), { target: { value: 'code-images' } });
    fireEvent.change(screen.getByLabelText('Code authoring provider'), { target: { value: 'fixture-api' } });
    fireEvent.click(screen.getByText('Save settings'));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    const [type, payload] = onUpdate.mock.calls[0];
    expect(type).toBe('music-video-autopilot');
    expect(payload.taskMetadata.musicVideoAutopilot).toMatchObject({
      mediaMode: 'code-images', authoring: { providerId: 'fixture-api', model: 'fixture-model' },
      tools: ['image:local'], budgetUsd: 8, instrumental: true, ideaTags: ['song'], moodBoardId: 'mb-1',
      limits: { maxGenerations: 10, maxReviewAttempts: 5 },
    });
  });

  it('round-trips the song source and the Suno fallback opt-in through the saved params', async () => {
    const onUpdate = vi.fn(async () => {});
    const config = { taskMetadata: { musicVideoAutopilot: { tools: ['code:render'], songSource: 'suno', localFallback: true } } };
    render(<MusicVideoAutopilotSettings taskType="music-video-autopilot" config={config} onUpdate={onUpdate} updating={false} setUpdating={() => {}} />);
    expect(screen.getByLabelText('Render locally if Suno is unavailable').checked).toBe(true);
    expect(screen.getByLabelText('Design and composition media').value).toBe('code-only');
    fireEvent.change(screen.getByLabelText('Song source'), { target: { value: 'local' } });
    fireEvent.click(screen.getByText('Save settings'));
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    expect(onUpdate.mock.calls[0][1].taskMetadata.musicVideoAutopilot).toMatchObject({ mediaMode: 'code-only', songSource: 'local', localFallback: false });
  });

  it('keeps a saved local video model in the menu, including one the catalog no longer lists', async () => {
    const onUpdate = vi.fn(async () => {});
    const config = {
      taskMetadata: { musicVideoAutopilot: { tools: ['video:local'], models: { 'video:local': 'retired-model' } } },
    };
    render(<MusicVideoAutopilotSettings taskType="music-video-autopilot" config={config} onUpdate={onUpdate} updating={false} setUpdating={() => {}} />);
    const model = screen.getByLabelText(/local video gen model/i);
    expect(model.tagName).toBe('SELECT');
    expect(await screen.findByRole('option', { name: 'Example LTX' })).toBeTruthy();
    expect(model.value).toBe('retired-model');
    expect(screen.getByRole('option', { name: 'retired-model (unavailable on this machine)' })).toBeTruthy();

    fireEvent.change(model, { target: { value: 'example-wan' } });
    fireEvent.click(screen.getByText('Save settings'));
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    expect(onUpdate.mock.calls[0][1].taskMetadata.musicVideoAutopilot.models).toEqual({ 'video:local': 'example-wan' });
  });

  it('keeps a saved writer-LLM pin when saved before the provider catalog loads', async () => {
    const onUpdate = vi.fn(async () => {});
    const config = { taskMetadata: { musicVideoAutopilot: { authoring: { providerId: 'saved-author', model: 'saved-model', effort: 'high' }, llm: { providerId: 'prov-1', model: 'm-1' } } } };
    render(<MusicVideoAutopilotSettings taskType="music-video-autopilot" config={config} onUpdate={onUpdate} updating={false} setUpdating={() => {}} />);
    fireEvent.click(screen.getByText('Save settings'));
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    expect(onUpdate.mock.calls[0][1].taskMetadata.musicVideoAutopilot.llm).toEqual({ providerId: 'prov-1', model: 'm-1' });
    expect(onUpdate.mock.calls[0][1].taskMetadata.musicVideoAutopilot.authoring).toEqual({ providerId: 'saved-author', model: 'saved-model', effort: 'high' });
  });
});
