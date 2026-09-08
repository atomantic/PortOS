import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

vi.mock('../services/apiCreativeDirector.js', () => ({
  getCreativeDirectorProject: vi.fn(),
  getCreativeDirectorSources: vi.fn(async () => ({ draft: [], artifact: [] })),
  deleteCreativeDirectorProject: vi.fn(),
  startCreativeDirectorProject: vi.fn(),
  pauseCreativeDirectorProject: vi.fn(),
  stopCreativeDirectorProject: vi.fn(),
  resumeCreativeDirectorProject: vi.fn(),
}));
vi.mock('../services/apiAgents.js', () => ({ getCosAgents: vi.fn(() => Promise.resolve([])) }));
vi.mock('../hooks/useMediaJobProgress', () => ({ default: () => ({ status: 'unknown', error: null }) }));
vi.mock('../components/creative-director/OverviewTab.jsx', () => ({ default: () => <div>Overview content</div> }));
vi.mock('../components/creative-director/TreatmentTab.jsx', () => ({ default: () => null }));
vi.mock('../components/creative-director/SegmentsTab.jsx', () => ({ default: () => null }));
vi.mock('../components/creative-director/PlanTab.jsx', () => ({ default: () => null }));
vi.mock('../components/creative-director/RunsTab.jsx', () => ({ default: () => null }));
vi.mock('../components/creative-director/ActiveAgentsBanner.jsx', () => ({ default: () => null }));
vi.mock('../components/creative-director/CreativeDirectorModelsDrawer.jsx', () => ({ default: () => null }));
vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import * as cdApi from '../services/apiCreativeDirector.js';
import CreativeDirectorDetail from './CreativeDirectorDetail';

const PROJECT = {
  id: 'cd-example',
  name: 'Example project',
  status: 'draft',
  treatment: null,
};

function LocationProbe() {
  const { pathname } = useLocation();
  return <div data-testid="location">{pathname}</div>;
}

const renderPage = async () => {
  render(
    <MemoryRouter initialEntries={['/creative-director/cd-example/overview']}>
      <LocationProbe />
      <Routes>
        <Route path="/creative-director/:id/:tab" element={<CreativeDirectorDetail />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: PROJECT.name });
};

describe('CreativeDirectorDetail project deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cdApi.getCreativeDirectorProject.mockResolvedValue(PROJECT);
    cdApi.deleteCreativeDirectorProject.mockResolvedValue({ ok: true });
  });

  it('requires confirmation before deleting the project', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByRole('button', { name: `Delete project ${PROJECT.name}` }));

    expect(cdApi.deleteCreativeDirectorProject).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete', exact: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('deletes the project and returns to the Creative Director list', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByRole('button', { name: `Delete project ${PROJECT.name}` }));
    await user.click(screen.getByRole('button', { name: 'Delete', exact: true }));

    await waitFor(() => expect(cdApi.deleteCreativeDirectorProject).toHaveBeenCalledWith(PROJECT.id, { silent: true }));
    expect(screen.getByTestId('location')).toHaveTextContent('/creative-director');
  });
});

describe('Video saved artifacts', () => {
  const videoProject = {
    ...PROJECT, workspace: 'video', targetDurationSeconds: 120,
    plan: { steps: [{
      stepId: 'attach-series', toolName: 'series.create', status: 'blocked', dependsOn: ['outline'],
      args: { privateReasoning: 'Hidden tool arguments' },
      result: { seriesId: 'example-series', privateReasoning: 'Hidden result field' },
    }] },
    treatment: {
      script: 'Example script.\nA traveler arrives.',
      scenes: Array.from({ length: 20 }, (_, order) => ({ sceneId: order === 0 ? 'arrival' : `scene-${order}`, intent: 'A traveler arrives', order, durationSeconds: 6 })),
      artifact: {
        scriptId: 'script-cd-example', revision: 2, targetDurationSeconds: 120, aspectRatio: '16:9', stale: false,
        shots: Array.from({ length: 20 }, (_, order) => ({ shotId: order === 0 ? 'shot-arrival' : `shot-scene-${order}`, sceneId: order === 0 ? 'arrival' : `scene-${order}`, startSeconds: order * 6, endSeconds: (order + 1) * 6, durationSeconds: 6 })),
        references: [
          { referenceId: 'universe:example-universe', kind: 'universe', id: 'example-universe', revision: 'rev-4' },
          { referenceId: 'voice:example-voice', kind: 'voice', id: 'example-voice' },
        ],
      },
    },
  };
  function renderVideo(tab = 'artifacts') {
    return render(
      <MemoryRouter initialEntries={[`/video/cd-example/${tab}`]}>
        <LocationProbe />
        <Routes>
          <Route path="/video/:id/:tab" element={<CreativeDirectorDetail basePath="/video" />} />
          <Route path="/video/:id/:tab/:sceneId" element={<CreativeDirectorDetail basePath="/video" />} />
        </Routes>
      </MemoryRouter>,
    );
  }
  beforeEach(() => {
    vi.clearAllMocks();
    cdApi.getCreativeDirectorProject.mockResolvedValue(videoProject);
  });
  it('opens artifacts from Video navigation and restores the saved revision on a fresh deep link', async () => {
    const user = userEvent.setup();
    const page = renderVideo('overview');
    await screen.findByRole('heading', { name: PROJECT.name });
    await user.click(screen.getByRole('tab', { name: 'Artifacts', exact: true }));
    expect(screen.getByTestId('location')).toHaveTextContent('/video/cd-example/artifacts');
    expect(screen.getByText('Revision 2 · 120 seconds · 16:9')).toBeInTheDocument();
    expect(screen.getByText(/Example script/)).toHaveTextContent('A traveler arrives.');
    expect(screen.getByText('0:00.00–0:06.00 · 6s')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'shot-arrival' })).toHaveAttribute('href', '/video/cd-example/segments/arrival');
    expect(screen.getByRole('link', { name: 'Open universe' })).toHaveAttribute('href', '/universes/example-universe');
    expect(screen.getByText('Source revision: rev-4')).toBeInTheDocument();
    expect(screen.getByText('Source revision: Not recorded')).toBeInTheDocument();
    expect(screen.getByText('series.create · Blocked')).toBeInTheDocument();
    expect(screen.getByText('Depends on: outline')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open series' })).toHaveAttribute('href', '/pipeline/series/example-series');
    expect(screen.queryByText(/Hidden tool arguments|Hidden result field/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start|Resume|Approve|Render/ })).not.toBeInTheDocument();
    page.unmount();
    renderVideo();
    expect(await screen.findByText('Revision 2 · 120 seconds · 16:9')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'shot-arrival' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/video/cd-example/segments/arrival');
    expect(cdApi.startCreativeDirectorProject).not.toHaveBeenCalled();
    expect(cdApi.resumeCreativeDirectorProject).not.toHaveBeenCalled();
  });
  it('shows stale and missing-scene repair guidance while retaining original artifact timing', async () => {
    cdApi.getCreativeDirectorProject.mockResolvedValue({
      ...videoProject, targetDurationSeconds: 180,
      treatment: { ...videoProject.treatment, scenes: [], artifact: { ...videoProject.treatment.artifact, stale: true } },
    });
    renderVideo();
    await screen.findByText(/This artifact is out of date/);
    expect(screen.getByRole('status')).toHaveTextContent('This artifact is out of date');
    expect(screen.getByText('Revision 2 · 120 seconds · 16:9')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review the current draft' })).toHaveAttribute('href', '/video/cd-example/overview');
    expect(screen.getAllByText(/Scene missing/)).toHaveLength(20);
    expect(screen.queryByRole('link', { name: 'shot-arrival' })).not.toBeInTheDocument();
  });
  it('keeps drafts without compiled artifacts usable', async () => {
    cdApi.getCreativeDirectorProject.mockResolvedValue({ ...videoProject, treatment: null, plan: null });
    renderVideo();
    expect(await screen.findByText(/No compiled artifact yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review the brief' })).toHaveAttribute('href', '/video/cd-example/overview');
    expect(screen.getByText('No tool plan saved.')).toBeInTheDocument();
  });

  it('reports missing sources, links to repair, and retries failed checks without altering saved revisions', async () => {
    const user = userEvent.setup();
    cdApi.getCreativeDirectorSources.mockRejectedValueOnce(new Error('Unavailable'));
    renderVideo();
    expect(await screen.findByRole('alert')).toHaveTextContent('Availability is unknown');
    cdApi.getCreativeDirectorSources.mockResolvedValueOnce({
      draft: [{ referenceId: 'universe:example-universe', kind: 'universe', id: 'example-universe', available: false }],
      artifact: [{ referenceId: 'universe:example-universe', kind: 'universe', id: 'example-universe', available: false }],
    });
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Missing universe: example-universe')).toBeInTheDocument();
    expect(screen.getByText('Source revision: rev-4')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit source attachments' })).toHaveAttribute('href', '/video/cd-example/overview?draft=1&videoDraftTab=sources');
    expect(cdApi.startCreativeDirectorProject).not.toHaveBeenCalled();
  });
});
