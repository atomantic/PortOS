/**
 * Voice-discovery passages belong to the series they were written for. The
 * series page stays mounted when the route switches to another series, so the
 * Style guide section's local candidates (and an in-flight discovery) must not
 * carry over — filing one would add series A's trial passage to series B's
 * exemplars.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import PipelineSeries from './PipelineSeries';

const getPipelineSeries = vi.fn();
const listPipelineIssues = vi.fn();
const listUniverses = vi.fn();
const discoverSeriesVoice = vi.fn();

vi.mock('../services/api', () => ({
  getPipelineSeries: (...args) => getPipelineSeries(...args),
  updatePipelineSeries: vi.fn(),
  listPipelineIssues: (...args) => listPipelineIssues(...args),
  listUniverses: (...args) => listUniverses(...args),
  generateSeriesTitleLogo: vi.fn(),
  discoverSeriesVoice: (...args) => discoverSeriesVoice(...args),
  SERIES_TITLE_LOGO_MAX: 1_000,
}));

vi.mock('../hooks/useArcCanvasSync', () => ({
  useArcCanvasSync: () => ({
    updateSeriesFromServer: vi.fn(),
    handleIssuesUpdate: vi.fn(),
    flushPending: vi.fn(async () => false),
  }),
}));
vi.mock('../hooks/useLocalStorageBool', () => ({ useLocalStorageBool: () => [false, vi.fn()] }));
vi.mock('../components/pipeline/ArcCanvas', () => ({ default: () => <div>arc canvas</div> }));
vi.mock('../components/pipeline/AutopilotPanel', () => ({ default: () => <div>autopilot</div> }));
vi.mock('../components/pipeline/SeriesReviewPanel', () => ({ default: () => <div>series review</div> }));
vi.mock('../components/pipeline/SeriesLoomsPanel', () => ({ default: () => <div>branching narratives</div> }));
vi.mock('../components/CatalogCastPanel', () => ({ default: () => <div>cast</div> }));
vi.mock('../components/pipeline/AuthorPicker', () => ({ default: () => <div>author</div> }));
vi.mock('../components/VoiceExemplarEditor', () => ({ default: () => <div>voice exemplars</div>, VOICE_EXEMPLARS_MAX: 5 }));
vi.mock('../components/imageGen/RecordRenderPinRow', () => ({ default: () => <div>render backend</div> }));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const SERIES = {
  'series-a': { id: 'series-a', name: 'Series A' },
  'series-b': { id: 'series-b', name: 'Series B' },
};
const CANDIDATES = { candidates: [{ register: 'spare', label: 'Spare', passage: 'Passage written for A.' }] };

function renderPage() {
  const router = createMemoryRouter(
    [{ path: '/pipeline/series/:seriesId', element: <PipelineSeries /> }],
    { initialEntries: ['/pipeline/series/series-a'] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const switchToSeriesB = async (router) => {
  await act(() => router.navigate('/pipeline/series/series-b'));
  await screen.findByRole('heading', { name: 'Series B' });
};

describe('Pipeline series — voice discovery across a series switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPipelineSeries.mockImplementation(async (id) => SERIES[id]);
    listPipelineIssues.mockResolvedValue([]);
    listUniverses.mockResolvedValue([]);
  });

  it('drops the previous series’ discovered passages', async () => {
    const user = userEvent.setup();
    discoverSeriesVoice.mockResolvedValue(CANDIDATES);
    const router = renderPage();
    await screen.findByRole('heading', { name: 'Series A' });
    await user.click(screen.getByRole('button', { name: 'Discover voice' }));
    expect(await screen.findByText('Passage written for A.')).toBeInTheDocument();

    await switchToSeriesB(router);
    expect(screen.queryByText('Passage written for A.')).not.toBeInTheDocument();
  });

  it('ignores a discovery that finishes after the switch', async () => {
    const user = userEvent.setup();
    let resolveDiscovery;
    discoverSeriesVoice.mockImplementation(() => new Promise((resolve) => { resolveDiscovery = resolve; }));
    const router = renderPage();
    await screen.findByRole('heading', { name: 'Series A' });
    await user.click(screen.getByRole('button', { name: 'Discover voice' }));

    await switchToSeriesB(router);
    expect(screen.getByRole('button', { name: 'Discover voice' })).toBeEnabled();
    await act(async () => { resolveDiscovery(CANDIDATES); });
    expect(screen.queryByText('Passage written for A.')).not.toBeInTheDocument();
  });
});
