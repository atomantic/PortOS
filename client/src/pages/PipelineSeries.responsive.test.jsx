import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import PipelineSeries from './PipelineSeries';

const getPipelineSeries = vi.fn();
const listPipelineIssues = vi.fn();
const listUniverses = vi.fn();

vi.mock('../services/api', () => ({
  getPipelineSeries: (...args) => getPipelineSeries(...args),
  updatePipelineSeries: vi.fn(),
  listPipelineIssues: (...args) => listPipelineIssues(...args),
  listUniverses: (...args) => listUniverses(...args),
  generateSeriesTitleLogo: vi.fn(),
  discoverSeriesVoice: vi.fn(),
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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/pipeline/series/series-1']}>
      <Routes>
        <Route path="/pipeline/series/:seriesId" element={<PipelineSeries />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Pipeline series detail — mobile layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPipelineSeries.mockResolvedValue({ id: 'series-1', name: 'Example Series' });
    listPipelineIssues.mockResolvedValue([]);
    listUniverses.mockResolvedValue([]);
  });

  it('owns a page scroll region below lg after the bible reflows above the canvas', async () => {
    renderPage();

    const page = (await screen.findByRole('heading', { name: 'Example Series' })).closest('.h-full');
    expect(page).toHaveClass('overflow-y-auto');
    expect(page).toHaveClass('lg:overflow-hidden');
  });
});
