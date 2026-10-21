import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import PipelineEditorialChecks from './PipelineEditorialChecks';

// A failed catalog read must surface as an error with Retry, never the
// "No editorial checks are registered" copy reserved for a real empty catalog.

const listPipelineSeries = vi.fn();
const getEditorialChecks = vi.fn();
const getPipelineManuscriptReview = vi.fn();
const getEditorialHealth = vi.fn();
const getEditorialChecksRunStatus = vi.fn();
const patchEditorialCheck = vi.fn();

vi.mock('../services/api', () => ({
  listPipelineSeries: (...a) => listPipelineSeries(...a),
  updatePipelineSeries: vi.fn(),
  getEditorialChecks: (...a) => getEditorialChecks(...a),
  patchEditorialCheck: (...a) => patchEditorialCheck(...a),
  createEditorialCustomCheck: vi.fn(),
  updateEditorialCustomCheck: vi.fn(),
  deleteEditorialCustomCheck: vi.fn(),
  previewEditorialCustomCheck: vi.fn(),
  startEditorialChecksRun: vi.fn(),
  cancelEditorialChecksRun: vi.fn(),
  getEditorialChecksRunStatus: (...a) => getEditorialChecksRunStatus(...a),
  editorialChecksRunSseUrl: () => '',
  getPipelineManuscriptReview: (...a) => getPipelineManuscriptReview(...a),
  getEditorialHealth: (...a) => getEditorialHealth(...a),
  setEditorialReadinessGate: vi.fn(),
  // Touched transitively by the triage → ManuscriptCommentCard tree.
  acceptPipelineManuscriptFix: vi.fn(),
  patchPipelineManuscriptComment: vi.fn(),
  undoPipelineManuscriptFix: vi.fn(),
  generatePipelineManuscriptFix: vi.fn(),
}));

vi.mock('../hooks/usePipelineProgress', () => ({
  usePipelineProgress: () => ({ latest: null, closed: true }),
}));
vi.mock('../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [], selectedProviderId: '', selectedModel: '', availableModels: [],
    setSelectedProviderId: vi.fn(), setSelectedModel: vi.fn(),
  }),
}));

// Keep the catalog cards + provider selector out of the way; the triage and health
// panel are the surfaces under test, so they stay REAL.
vi.mock('../components/pipeline/editorial/EditorialCheckCard', () => ({ default: () => <div>check-card</div> }));
vi.mock('../components/pipeline/editorial/EditorialCustomCheckForm', () => ({ default: () => <div>custom-form</div> }));
vi.mock('../components/ProviderModelSelector', () => ({ default: () => <div>provider-selector</div> }));

const CHECK = { id: 'naming.dissimilar-names', label: 'Character name dissimilarity', scope: 'series', kind: 'deterministic', enabled: true };

function renderPage(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/pipeline/editorial-checks${search}`]}>
      <PipelineEditorialChecks />
    </MemoryRouter>,
  );
}

describe('PipelineEditorialChecks — failed catalog read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPipelineSeries.mockResolvedValue([{ id: 'ser-1', title: 'My Series' }]);
    getPipelineManuscriptReview.mockResolvedValue({ comments: [] });
    getEditorialChecksRunStatus.mockResolvedValue({ active: false });
    getEditorialHealth.mockResolvedValue(null);
  });

  it('shows a load error with Retry instead of "No editorial checks are registered", then loads the catalog', async () => {
    getEditorialChecks.mockRejectedValueOnce(new Error('Server unavailable'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the editorial check catalog — Server unavailable');
    expect(screen.queryByText(/No editorial checks are registered/)).toBeNull();

    getEditorialChecks.mockResolvedValueOnce({ checks: [CHECK] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('check-card')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('PipelineEditorialChecks — failed findings read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPipelineSeries.mockResolvedValue([{ id: 'ser-1', title: 'My Series' }]);
    getEditorialChecks.mockResolvedValue({ checks: [CHECK] });
    getEditorialChecksRunStatus.mockResolvedValue({ active: false });
    getEditorialHealth.mockResolvedValue(null);
  });

  it('shows a load error with Retry instead of the empty-findings copy, then loads the findings', async () => {
    getPipelineManuscriptReview.mockRejectedValueOnce(new Error('Review unavailable'));
    renderPage('?series=ser-1');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the findings for this series — Review unavailable');
    expect(screen.queryByText(/No findings/i)).toBeNull();

    getPipelineManuscriptReview.mockResolvedValueOnce({
      comments: [{ id: 'c1', checkId: CHECK.id, status: 'open', problem: 'Names too similar', location: 'Ch 1' }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/Names too similar/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
