/**
 * The Style guide Tone input must keep commas and interior spaces while the
 * user types, store the parsed list, and normalize on blur.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import PipelineSeries from './PipelineSeries';

const getPipelineSeries = vi.fn();
const updatePipelineSeries = vi.fn();

vi.mock('../services/apiPipeline.js', () => ({
  getPipelineSeries: (...args) => getPipelineSeries(...args),
  updatePipelineSeries: (...args) => updatePipelineSeries(...args),
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
  return router;
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

  it('rolls back the primary manuscript format when the PATCH fails', async () => {
    const user = userEvent.setup();
    updatePipelineSeries.mockRejectedValue(new Error('boom'));
    renderPage();
    const select = await screen.findByLabelText('Primary manuscript format');
    expect(select.value).toBe('');
    await user.selectOptions(select, 'teleplay');
    await waitFor(() => expect(screen.getByLabelText('Primary manuscript format').value).toBe(''));
    expect(updatePipelineSeries).toHaveBeenCalled();
  });

  it('hides the previous series while the next one loads', async () => {
    let resolveB;
    getPipelineSeries.mockImplementation((id) => (id === 'series-a'
      ? Promise.resolve({ id: 'series-a', name: 'Series A' })
      : new Promise((r) => { resolveB = () => r({ id: 'series-b', name: 'Series B' }); })));
    const router = renderPage();
    await screen.findByLabelText(/Tone \(comma-separated\)/);
    await act(async () => { await router.navigate('/pipeline/series/series-b'); });
    expect(screen.queryByLabelText(/Tone \(comma-separated\)/)).toBeNull();
    await act(async () => { resolveB(); });
    expect(await screen.findByLabelText(/Tone \(comma-separated\)/)).toBeTruthy();
  });
});
