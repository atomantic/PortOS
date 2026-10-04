/**
 * Auto-review panel (#8988) rendered with the real useMusicVideoAutoReview
 * hook over a mocked API and socket: a run starts only with the director's
 * explicit limits, the board only REPORTS the sections the server submitted for
 * its own project (the server generates them, #10014), and a run stopped at a
 * limit resumes only with the limits the director raised.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const listeners = vi.hoisted(() => new Map());
vi.mock('../../services/socket', () => ({
  default: {
    on: (ev, fn) => listeners.set(ev, fn),
    off: (ev) => listeners.delete(ev),
  },
}));
vi.mock('../../services/apiMusicVideo.js', () => ({
  startMusicVideoAutoReview: vi.fn(),
  resumeMusicVideoAutoReview: vi.fn(),
  stopMusicVideoAutoReview: vi.fn(),
  cancelMusicVideoAutoReview: vi.fn(),
}));
vi.mock('../../hooks/useProviderModels.js', () => ({
  default: () => ({
    providers: [], selectedProviderId: '', selectedModel: '', availableModels: [],
    setSelectedProviderId: vi.fn(), setSelectedModel: vi.fn(),
  }),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import * as api from '../../services/apiMusicVideo.js';
import useMusicVideoAutoReview from '../../hooks/useMusicVideoAutoReview.js';
import AutoReviewPanel from './AutoReviewPanel.jsx';

const baseProject = { id: 'mv-1', scenes: [{ sceneId: 's2', order: 0 }], autoReviews: [] };
const limitRun = {
  id: 'mvar-1', status: 'limit-reached', startSec: 0, endSec: 10, stopReason: 'Reached the 1-review attempt limit',
  limits: { maxAttempts: 1, maxGenerations: 2 }, usage: { reviews: 1, generations: 1 },
  attempts: [{ n: 1, excerptId: 'mve-1', review: null, revisionId: null }],
};

function Harness({ initial }) {
  const [project, setProject] = useState(initial);
  const autoReview = useMusicVideoAutoReview({ project, replaceProject: setProject });
  return <AutoReviewPanel project={project} startSec={0} endSec={10} rangeValid rendering={false} autoReview={autoReview} />;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AutoReviewPanel (#8988)', () => {
  it('starts a run with the limits the director set, and refuses to start without valid ones', async () => {
    api.startMusicVideoAutoReview.mockResolvedValue({ project: baseProject, run: { id: 'mvar-1', status: 'running' } });
    render(<Harness initial={baseProject} />);
    const start = screen.getByRole('button', { name: /start auto-review/i });

    fireEvent.change(screen.getByLabelText('Max reviews'), { target: { value: '0' } });
    expect(start).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Max reviews'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Max paid generations'), { target: { value: '5' } });
    fireEvent.click(start);
    await waitFor(() => expect(api.startMusicVideoAutoReview).toHaveBeenCalledWith(
      'mv-1', { startSec: 0, endSec: 10, limits: { maxAttempts: 2, maxGenerations: 5 } }, { silent: true },
    ));
  });

  it('reports the sections the server itself submitted for THIS project, and never submits from the board (#10014)', async () => {
    render(<Harness initial={baseProject} />);
    const running = { ...limitRun, status: 'running', stopReason: null };
    const project = { ...baseProject, autoReviews: [running] };
    const submitted = { type: 'wait', on: 'generation', revisionId: 'mvr-1', submitted: [{ sceneId: 's2', kind: 'video', jobId: 'job-1' }] };

    act(() => listeners.get('music-video:auto-review')({ projectId: 'mv-other', run: running, project, action: submitted }));
    expect(screen.queryByText(/Generating 1 revised section/)).not.toBeInTheDocument();

    act(() => listeners.get('music-video:auto-review')({ projectId: 'mv-1', run: running, project, action: submitted }));
    expect(await screen.findByText(/Generating 1 revised section/)).toBeInTheDocument();
  });

  it('a run stopped at a limit resumes with the raised limit only', async () => {
    api.resumeMusicVideoAutoReview.mockResolvedValue({ project: baseProject, run: { ...limitRun, status: 'running' } });
    render(<Harness initial={{ ...baseProject, autoReviews: [limitRun] }} />);
    expect(screen.getByText('Reached the 1-review attempt limit')).toBeInTheDocument();

    fireEvent.change(screen.getAllByLabelText('Max reviews')[0], { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /resume/i }));
    await waitFor(() => expect(api.resumeMusicVideoAutoReview).toHaveBeenCalledWith('mv-1', 'mvar-1', { limits: { maxAttempts: 3 } }, { silent: true }));
  });
});
