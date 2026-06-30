/**
 * Focused tests for the music-video Render control (#1760 Phase 2): the button
 * gates on a scene having a generated clip, and clicking it kicks off the render.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const PROJECT_WITH_CLIP = {
  id: 'mv-1', name: 'Neon Run', mode: 'director', status: 'ready',
  trackId: 't1', uploadedAudioFilename: null, audioAnalysis: null, renderHistoryId: null,
  scenes: [{ sceneId: 's1', order: 0, prompt: 'a', referenceImageId: 'img1', videoHistoryId: 'h1' }],
};
const PROJECT_NO_CLIP = {
  ...PROJECT_WITH_CLIP, id: 'mv-2', name: 'No Clips',
  scenes: [{ sceneId: 's1', order: 0, prompt: 'a', referenceImageId: 'img1', videoHistoryId: null }],
};

const { sseState } = vi.hoisted(() => ({ sseState: { latest: null, closed: false, frames: [], isOpen: false } }));

vi.mock('../services/apiMusicVideo.js', () => ({
  listMusicVideoProjects: vi.fn(async () => []),
  createMusicVideoProject: vi.fn(),
  deleteMusicVideoProject: vi.fn(),
  analyzeMusicVideoProject: vi.fn(),
  addMusicVideoScene: vi.fn(),
  updateMusicVideoScene: vi.fn(),
  deleteMusicVideoScene: vi.fn(),
  reorderMusicVideoScenes: vi.fn(),
  renderMusicVideoProject: vi.fn(async () => ({ jobId: 'job-1' })),
  musicVideoRenderEventsUrl: (jobId) => `/api/music-video/render/${jobId}/events`,
  cancelMusicVideoRender: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../services/apiSystem.js', () => ({ generateImage: vi.fn() }));
vi.mock('../services/apiImageVideo.js', () => ({ generateVideo: vi.fn() }));
vi.mock('../services/apiTracks.js', () => ({ listTracks: vi.fn(async () => []) }));
vi.mock('../hooks/useSceneRenderLifecycle.js', () => ({
  default: () => ({ genScenes: {}, startScene: vi.fn(), clearScene: vi.fn(), trackJob: vi.fn() }),
}));
vi.mock('../hooks/useSseProgress.js', () => ({ useSseProgress: () => sseState }));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../components/PageHeader', () => ({ default: ({ title }) => <div>{title}</div> }));

import MusicVideo from './MusicVideo.jsx';
import { listMusicVideoProjects, renderMusicVideoProject } from '../services/apiMusicVideo.js';

const openProject = async (project) => {
  listMusicVideoProjects.mockResolvedValue([project]);
  render(<MusicVideo />);
  // Project list button appears, then select it to open the board.
  const btn = await screen.findByRole('button', { name: new RegExp(project.name) });
  fireEvent.click(btn);
};

beforeEach(() => {
  vi.clearAllMocks();
  sseState.latest = null;
  sseState.closed = false;
});

describe('MusicVideo render control (#1760)', () => {
  it('enables Render and kicks off the job when a scene has a clip', async () => {
    await openProject(PROJECT_WITH_CLIP);
    const renderBtn = await screen.findByRole('button', { name: /^Render$/ });
    expect(renderBtn).toHaveProperty('disabled', false);

    fireEvent.click(renderBtn);
    await waitFor(() => expect(renderMusicVideoProject).toHaveBeenCalledWith('mv-1', { silent: true }));
  });

  it('disables Render when no scene has a generated clip', async () => {
    await openProject(PROJECT_NO_CLIP);
    const renderBtn = await screen.findByRole('button', { name: /^Render$/ });
    expect(renderBtn).toHaveProperty('disabled', true);
  });

  it('shows the rendered-video link once a project carries a renderHistoryId', async () => {
    await openProject({ ...PROJECT_WITH_CLIP, renderHistoryId: 'rh-9' });
    const link = await screen.findByText(/View rendered music video/i);
    // Media History matches video items by their `video:<id>` key via ?preview=.
    expect(link.closest('a').getAttribute('href')).toContain('preview=video%3Arh-9');
  });
});
