/**
 * The Style guide Tone input must keep commas and interior spaces while the
 * user types, store the parsed list, and normalize on blur.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import PipelineSeries from './PipelineSeries';

const getPipelineSeries = vi.fn();

vi.mock('../services/apiPipeline.js', () => ({
  getPipelineSeries: (...args) => getPipelineSeries(...args),
  updatePipelineSeries: vi.fn(),
  listPipelineIssues: vi.fn().mockResolvedValue([]),
  generateSeriesTitleLogo: vi.fn(),
  discoverSeriesVoice: vi.fn(),
  SERIES_TITLE_LOGO_MAX: 1_000,
}));
vi.mock('../services/apiUniverseBuilder.js', () => ({
  listUniverseNames: vi.fn().mockResolvedValue([]),
  getUniverse: vi.fn().mockResolvedValue({ characters: [] }),
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
  const router = createMemoryRouter(
    [{ path: '/pipeline/series/:seriesId', element: <PipelineSeries /> }],
    { initialEntries: ['/pipeline/series/series-a'] },
  );
  render(<RouterProvider router={router} />);
}

describe('Pipeline series — style guide Tone input', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPipelineSeries.mockResolvedValue({ id: 'series-a', name: 'Series A' });
  });

  it('keeps typed commas and spaces, then normalizes on blur', async () => {
    const user = userEvent.setup();
    renderPage();
    const input = await screen.findByLabelText(/Tone \(comma-separated\)/);
    await user.type(input, 'noir, hopeful, wry');
    expect(input.value).toBe('noir, hopeful, wry');
    await user.clear(input);
    await user.type(input, 'dark humor,  dry wit');
    expect(input.value).toBe('dark humor,  dry wit');
    await user.tab();
    expect(input.value).toBe('dark humor, dry wit');
  });
});
