import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';

// #15167: a render that finishes while the socket is down never replays its
// image-gen:* event, so the card / live button stayed on "Rendering…". A socket
// `connect` must re-read the pending job and settle it.

const handlers = new Map();
vi.mock('../../services/socket', () => ({
  default: {
    on: (event, fn) => { handlers.set(event, fn); },
    off: (event, fn) => { if (handlers.get(event) === fn) handlers.delete(event); },
    emit: () => {},
  },
}));
const getMediaJob = vi.fn();
vi.mock('../../services/apiMediaJobs', () => ({ getMediaJob: (...a) => getMediaJob(...a) }));
const generateImage = vi.fn();
vi.mock('../../services/apiSystem', () => ({ generateImage: (...a) => generateImage(...a) }));
const getWritersRoomAnalysis = vi.fn();
vi.mock('../../services/apiWritersRoom', () => ({
  getWritersRoomAnalysis: (...a) => getWritersRoomAnalysis(...a),
  reserveWritersRoomRenderPreview: vi.fn(async () => ({ renderUsage: { count: 1 } })),
  attachWritersRoomSceneImage: vi.fn(),
}));

import SceneCard from './SceneCard';
import LiveRenderPanel from './LiveRenderPanel';

const reconnect = () => act(async () => { handlers.get('connect')?.(); });

beforeEach(() => {
  handlers.clear();
  getMediaJob.mockReset();
  generateImage.mockReset();
  getWritersRoomAnalysis.mockReset();
  generateImage.mockResolvedValue({ jobId: 'job-1', status: 'queued' });
});
afterEach(cleanup);

describe('SceneCard reconnect settle', () => {
  const scene = { id: 's1', heading: 'Kitchen', visualPrompt: 'a kitchen at dawn' };
  const analysis = { id: 'a1', sceneImages: { s1: { filename: 'job-1.png', jobId: 'job-1' } } };

  async function startRender(props = {}) {
    render(<SceneCard scene={scene} workId="w1" analysisId="a1" workTitle="Example Work" {...props} />);
    const button = screen.getByTitle("Queue an image render using this scene's visual prompt");
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    return button;
  }

  it('leaves the running state and re-enables Render when the completed event was missed', async () => {
    getMediaJob.mockResolvedValue({ status: 'completed', result: { path: '/data/images/job-1.png' } });
    getWritersRoomAnalysis.mockResolvedValue(analysis);
    const onSceneImageAttached = vi.fn();
    const button = await startRender({ onSceneImageAttached });
    await reconnect();
    expect(button).not.toBeDisabled();
    expect(button).toHaveTextContent('↻');
    expect(document.querySelector('img[src="/data/images/job-1.png"]')).not.toBeNull();
    await waitFor(() => expect(onSceneImageAttached).toHaveBeenCalledWith(analysis));
  });

  it('keeps rendering while the job is still running', async () => {
    getMediaJob.mockResolvedValue({ status: 'running' });
    const button = await startRender();
    await reconnect();
    expect(button).toBeDisabled();
  });

  it('shows the failure and re-enables Render when the failed event was missed', async () => {
    getMediaJob.mockResolvedValue({ status: 'failed', error: 'GPU out of memory' });
    const button = await startRender();
    await reconnect();
    expect(button).not.toBeDisabled();
    expect(screen.getByText('GPU out of memory')).toBeInTheDocument();
  });
});

describe('LiveRenderPanel reconnect settle', () => {
  const body = '## Kitchen\nShe pours coffee.';
  const renderContext = {
    analysisId: 'a1',
    scenes: [{ id: 's1', heading: 'Kitchen', visualPrompt: 'a kitchen at dawn' }],
  };

  async function startRender(onSceneImageAttached = vi.fn()) {
    render(
      <LiveRenderPanel
        workId="w1"
        liveMode={{ enabled: true, dailyRenderBudget: 5 }}
        getCursorOffset={() => 3}
        body={body}
        renderContext={renderContext}
        registerQueue={() => {}}
        onSceneImageAttached={onSceneImageAttached}
        workTitle="Example Work"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Render scene/ }));
    await screen.findByRole('button', { name: /Rendering…/ });
    return onSceneImageAttached;
  }

  it('unblocks the Render button and refreshes the analysis when the completed event was missed', async () => {
    getMediaJob.mockResolvedValue({ status: 'completed', result: { path: '/data/images/job-1.png' } });
    const analysis = { id: 'a1', sceneImages: { s1: { filename: 'job-1.png' } } };
    getWritersRoomAnalysis.mockResolvedValue(analysis);
    const onAttached = await startRender();
    await reconnect();
    expect(await screen.findByRole('button', { name: /Render scene/ })).not.toBeDisabled();
    expect(getWritersRoomAnalysis).toHaveBeenCalledWith('w1', 'a1', { silent: true });
    await waitFor(() => expect(onAttached).toHaveBeenCalledWith(analysis));
  });

  it('stays rendering while the job is still running', async () => {
    getMediaJob.mockResolvedValue({ status: 'running' });
    await startRender();
    await reconnect();
    expect(screen.getByRole('button', { name: /Rendering…/ })).toBeDisabled();
  });
});
