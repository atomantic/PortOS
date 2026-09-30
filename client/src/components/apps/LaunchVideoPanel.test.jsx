import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import LaunchVideoPanel from './LaunchVideoPanel';
import { createAppLaunchVideo, getAppLaunchVideos, getMotionToolkit, installMotionSkills, publishAppLaunchVideo } from '../../services/apiApps';
vi.mock('../../services/apiApps', () => ({ getAppLaunchVideos: vi.fn(async () => ({ videos: [] })), createAppLaunchVideo: vi.fn(), publishAppLaunchVideo: vi.fn(),
  getMotionToolkit: vi.fn(async () => ({ ffmpeg: true, skillPacks: [] })), installMotionSkills: vi.fn() }));
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
    // One frame keeps the original single `format` request.
    fireEvent.click(screen.getByLabelText('Vertical 9:16'));
    fireEvent.click(screen.getByLabelText('Landscape 16:9'));
    fireEvent.change(screen.getByLabelText('Duration (15–120 seconds)'), { target: { value: '22' } });
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
      tone: 'cinematic', direction: '', format: 'vertical', targetDurationSec: 22, motionStyle: 'walkthrough', critiqueRounds: 2, musicTrack: 'track-1a2b.wav',
      provider: 'example-provider', model: 'example-model',
    }, { silent: true });
    finish({ taskId: 'task-example' });
    await waitFor(() => expect(screen.getByText('Launch video queued. Closing this drawer leaves the run active.')).toBeTruthy());
    expect(screen.getByRole('link', { name: /Open CoS agents/ }).getAttribute('href')).toBe('/cos/agents');
    fireEvent.click(screen.getByRole('button', { name: /Close/ }));
    expect(screen.queryByText('Launch video queued. Closing this drawer leaves the run active.')).toBeNull();
    expect(createAppLaunchVideo).toHaveBeenCalledTimes(1);
  });

  it('installs and enables motion skills from the form', async () => {
    installMotionSkills.mockResolvedValue({ skillPacks: [{ id: 'hyperframes', label: 'HyperFrames', found: ['motion-graphics'], installed: true }] });
    getMotionToolkit.mockResolvedValueOnce({ ffmpeg: true, skillPacks: [{ id: 'hyperframes', label: 'HyperFrames', found: [], installed: false }] });
    renderPanel('/?launchVideo=true');
    fireEvent.click(await screen.findByRole('button', { name: 'Install and enable motion skills' }));
    await waitFor(() => expect(screen.getByLabelText('Consult motion skills').checked).toBe(true));
    expect(installMotionSkills).toHaveBeenCalledWith({ silent: true });
  });

  it.each(['agent', 'service'])('queues %s music without requiring a library track or installed engine', async musicMethod => {
    createAppLaunchVideo.mockReset().mockResolvedValue({ taskId: 'task-generated' });
    getMotionToolkit.mockResolvedValueOnce({ ffmpeg: true, skillPacks: [{ id: 'hyperframes', label: 'HyperFrames', found: ['motion-graphics'] }] });
    renderPanel('/?launchVideo=true');
    fireEvent.change(screen.getByLabelText('Motion style'), { target: { value: 'ui-morph' } });
    fireEvent.change(screen.getByLabelText('Critique rounds'), { target: { value: '3' } });
    await waitFor(() => expect(screen.getByLabelText('Consult motion skills').disabled).toBe(false));
    fireEvent.click(screen.getByLabelText('Consult motion skills'));
    fireEvent.change(screen.getByLabelText('Duration (15–120 seconds)'), { target: { value: '90' } });
    fireEvent.click(screen.getByLabelText('Landscape 16:9'));
    expect(screen.getByRole('button', { name: 'Queue launch video' }).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Square 1:1'));
    fireEvent.click(screen.getByLabelText('Vertical 9:16'));
    fireEvent.click(screen.getByLabelText('Include music'));
    expect(screen.getByLabelText('Generate original music').checked).toBe(false);
    fireEvent.click(screen.getByLabelText('Generate original music'));
    expect(screen.getByLabelText('Music creation').value).toBe('agent');
    fireEvent.change(screen.getByLabelText('Music creation'), { target: { value: musicMethod } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue launch video' }));
    await waitFor(() => expect(createAppLaunchVideo).toHaveBeenCalledWith('example', expect.objectContaining({ formats: ['vertical', 'square'], targetDurationSec: 90, generateMusic: true, musicMethod, motionStyle: 'ui-morph', critiqueRounds: 3, motionSkills: true }), { silent: true }));
    expect(createAppLaunchVideo.mock.calls[0][1].musicTrack).toBeUndefined();
    expect(createAppLaunchVideo.mock.calls[0][1].format).toBeUndefined();
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


it('groups a multi-format run into one take with a download per format', async () => {
  getAppLaunchVideos.mockResolvedValueOnce({ videos: [
    { id: 'run-a-landscape', runId: 'run-a', format: 'landscape', filename: 'a-landscape.mp4', thumbnail: 'a-landscape.jpg', createdAt: '2026-01-02T00:00:00.000Z', caption: 'Run A.' },
    { id: 'run-a-vertical', runId: 'run-a', format: 'vertical', filename: 'a-vertical.mp4', thumbnail: 'a-vertical.jpg', createdAt: '2026-01-02T00:00:00.000Z', caption: 'Run A.' },
    { id: 'run-b', runId: 'run-b', format: 'square', filename: 'b.mp4', thumbnail: 'b.jpg', createdAt: '2026-01-01T00:00:00.000Z', caption: 'Run B.' },
  ] });
  renderPanel('/?video=run-a-vertical');
  expect(await screen.findByText('Run A.')).toBeTruthy();
  expect(screen.getByLabelText('Selected launch video').getAttribute('src')).toBe('/data/videos/a-vertical.mp4');
  // Two takes, not three videos; the run's tile names its format count.
  const takes = screen.getByRole('list', { name: 'Launch video takes' });
  expect(takes.querySelectorAll('button')).toHaveLength(2);
  expect(takes.textContent).toContain('2 formats');
  expect(screen.getByRole('link', { name: 'Download Landscape 16:9' }).getAttribute('href')).toBe('/data/videos/a-landscape.mp4');
  expect(screen.getByRole('link', { name: 'Download Vertical 9:16' }).getAttribute('href')).toBe('/data/videos/a-vertical.mp4');
  const switcher = screen.getByRole('group', { name: 'Formats in this take' });
  fireEvent.click(within(switcher).getByRole('button', { name: 'Landscape 16:9' }));
  await waitFor(() => expect(screen.getByLabelText('Selected launch video').getAttribute('src')).toBe('/data/videos/a-landscape.mp4'));
  fireEvent.click(takes.querySelectorAll('button')[1]);
  expect(await screen.findByText('Run B.')).toBeTruthy();
  expect(screen.queryByRole('group', { name: 'Formats in this take' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Download' }).getAttribute('href')).toBe('/data/videos/b.mp4');
});


it('publishes the URL-selected take once and exposes the queued workflow', async () => {
  getAppLaunchVideos.mockResolvedValueOnce({ videos: [
    { id: 'newest', filename: 'newest.mp4', createdAt: '2026-01-02' },
    { id: 'older', filename: 'older.mp4', createdAt: '2026-01-01' },
  ] });
  let finish;
  publishAppLaunchVideo.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  renderPanel('/?video=older');
  fireEvent.click(await screen.findByRole('button', { name: 'Publish to README and merge PR' }));
  expect(screen.getByRole('button', { name: 'Queuing publication…' }).disabled).toBe(true);
  expect(publishAppLaunchVideo).toHaveBeenCalledExactlyOnceWith('example', {
    videoId: 'older', format: 'mp4', provider: 'example-provider', model: 'example-model',
  }, { silent: true });
  finish({ taskId: 'task-publish' });
  expect((await screen.findByRole('status')).textContent).toContain('README publication queued');
  expect(screen.getByRole('link', { name: /Follow the render/ }).getAttribute('href')).toBe('/cos/agents');
});


it('revises the selected older take with feedback and a model pin, without duplicate submission', async () => {
  getAppLaunchVideos.mockResolvedValueOnce({ videos: [
    { id: 'newest', filename: 'newest.mp4', createdAt: '2026-01-02' },
    { id: 'older', filename: 'older.mp4', createdAt: '2026-01-01' },
  ] });
  let finish;
  createAppLaunchVideo.mockReset().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  renderPanel('/?video=older');
  const feedback = await screen.findByLabelText('Feedback');
  expect(screen.getByRole('button', { name: 'Revise as new version' }).disabled).toBe(true);
  fireEvent.change(feedback, { target: { value: '  Enlarge the closing headline  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Revise as new version' }));
  expect(screen.getByRole('button', { name: 'Queuing revision…' }).disabled).toBe(true);
  expect(createAppLaunchVideo).toHaveBeenCalledExactlyOnceWith('example', {
    sourceVideoId: 'older', feedback: 'Enlarge the closing headline', provider: 'example-provider', model: 'example-model',
  }, { silent: true });
  finish({ taskId: 'task-revise' });
  expect((await screen.findByRole('status')).textContent).toContain('Revision queued');
  expect(screen.getByLabelText('Selected launch video').getAttribute('src')).toBe('/data/videos/older.mp4');
});
