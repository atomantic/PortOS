import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import LaunchVideoPanel from './LaunchVideoPanel';
import { createAppLaunchVideo, getAppLaunchVideos } from '../../services/apiApps';
vi.mock('../../services/apiApps', () => ({ getAppLaunchVideos: vi.fn(async () => ({ videos: [] })), createAppLaunchVideo: vi.fn() }));
vi.mock('../../services/apiPipeline', () => ({ listPipelineMusicLibrary: async () => ({ tracks: [{ filename: 'track-1a2b.wav', label: 'Example track', sizeBytes: 2048, updatedAt: '2026-01-01T00:00:00.000Z' }] }) }));
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../../lib/clipboard', () => ({ copyToClipboard: vi.fn() }));
// The picker's tool-use annotation fetches from apiLocalLlm; park it unresolved.
vi.mock('../../services/apiLocalLlm', () => ({ getToolUseModels: () => new Promise(() => {}), getVisionModels: async () => ({ models: [] }) }));
const provider = { id: 'example-provider', name: 'Example Provider', type: 'cli', enabled: true, models: ['example-model'], defaultModel: 'example-model' };
vi.mock('../../hooks/useProviderModels', () => ({ default: () => ({
  providers: [provider], selectedProviderId: 'example-provider', selectedModel: 'example-model',
  availableModels: ['example-model'], loading: false, setSelectedProviderId: vi.fn(), setSelectedModel: vi.fn(),
}) }));

const renderPanel = (path = '/') => render(<MemoryRouter initialEntries={[path]}><LaunchVideoPanel app={{ id: 'example' }} /></MemoryRouter>);

describe('launch video drawer', () => {
  it('submits options with the agent pin once and leaves the run active on close', async () => {
    let finish;
    createAppLaunchVideo.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Make launch video' }));
    fireEvent.change(screen.getByLabelText('Tone'), { target: { value: 'cinematic' } });
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'vertical' } });
    fireEvent.change(screen.getByLabelText('Duration (15–25 seconds)'), { target: { value: '22' } });
    fireEvent.click(screen.getByLabelText('Include music'));
    // Each track is identifiable by name + file and audible before choosing it.
    const choice = await screen.findByRole('radio', { name: /Example track/ });
    expect(screen.getByText(/track-1a2b\.wav/)).toBeTruthy();
    expect(screen.getByLabelText('Preview Example track').getAttribute('src')).toBe('/data/music/track-1a2b.wav');
    fireEvent.click(choice);
    fireEvent.click(screen.getByRole('button', { name: 'Queue launch video' }));
    expect(screen.getByRole('button', { name: 'Queuing…' }).disabled).toBe(true);
    expect(createAppLaunchVideo).toHaveBeenCalledTimes(1);
    expect(createAppLaunchVideo).toHaveBeenCalledWith('example', {
      tone: 'cinematic', direction: '', format: 'vertical', targetDurationSec: 22, musicTrack: 'track-1a2b.wav',
      provider: 'example-provider', model: 'example-model',
    }, { silent: true });
    finish({ taskId: 'task-example' });
    await waitFor(() => expect(screen.getByText('Launch video queued. Closing this drawer leaves the run active.')).toBeTruthy());
    expect(screen.getByRole('link', { name: /Open CoS agents/ }).getAttribute('href')).toBe('/cos/agents');
    fireEvent.click(screen.getByRole('button', { name: /Close/ }));
    expect(screen.queryByText('Launch video queued. Closing this drawer leaves the run active.')).toBeNull();
    expect(createAppLaunchVideo).toHaveBeenCalledTimes(1);
  });

  it('previews the URL-selected take and offers it for download', async () => {
    getAppLaunchVideos.mockResolvedValueOnce({ videos: [
      { id: 'newest', filename: 'composition-newest.mp4', thumbnail: 'newest.jpg', createdAt: '2026-01-02T00:00:00.000Z', durationSec: 20, caption: 'Newest caption.' },
      { id: 'older', filename: 'composition-older.mp4', thumbnail: 'older.jpg', createdAt: '2026-01-01T00:00:00.000Z', durationSec: 18, caption: 'Older caption.' },
    ] });
    renderPanel('/?video=older');
    expect(await screen.findByText('Older caption.')).toBeTruthy();
    expect(screen.getByLabelText('Selected launch video').getAttribute('src')).toBe('/data/videos/composition-older.mp4');
    const download = screen.getByRole('link', { name: 'Download' });
    expect(download.getAttribute('href')).toBe('/data/videos/composition-older.mp4');
    expect(download.hasAttribute('download')).toBe(true);
    const takes = screen.getByRole('list', { name: 'Launch video takes' });
    fireEvent.click(takes.querySelectorAll('button')[0]);
    expect(await screen.findByText('Newest caption.')).toBeTruthy();
  });
});
