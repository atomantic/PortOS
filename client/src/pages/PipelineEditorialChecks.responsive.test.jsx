import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PipelineEditorialChecks from './PipelineEditorialChecks';

// The catalog loads global checks; findings load per-series. Resolve both with
// minimal data so the page renders the two-column body (#1611 responsive switch).
const getEditorialChecks = vi.fn();
const listPipelineSeries = vi.fn();
const getPipelineManuscriptReview = vi.fn();

vi.mock('../services/api', () => ({
  listPipelineSeries: (...a) => listPipelineSeries(...a),
  updatePipelineSeries: vi.fn(),
  getEditorialChecks: (...a) => getEditorialChecks(...a),
  patchEditorialCheck: vi.fn(),
  createEditorialCustomCheck: vi.fn(),
  updateEditorialCustomCheck: vi.fn(),
  deleteEditorialCustomCheck: vi.fn(),
  previewEditorialCustomCheck: vi.fn(),
  startEditorialChecksRun: vi.fn(),
  cancelEditorialChecksRun: vi.fn(),
  getEditorialChecksRunStatus: vi.fn(),
  editorialChecksRunSseUrl: () => '',
  getPipelineManuscriptReview: (...a) => getPipelineManuscriptReview(...a),
}));

vi.mock('../hooks/usePipelineProgress', () => ({
  usePipelineProgress: () => ({ latest: null, closed: true }),
}));

vi.mock('../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [],
    selectedProviderId: '',
    selectedModel: '',
    availableModels: [],
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
  }),
}));

// Child surfaces are exercised in their own suites; stub them to keep this test
// focused on the column-stacking switch.
vi.mock('../components/pipeline/editorial/EditorialCheckCard', () => ({ default: () => <div>check-card</div> }));
vi.mock('../components/pipeline/editorial/EditorialCustomCheckForm', () => ({ default: () => <div>custom-form</div> }));
vi.mock('../components/pipeline/editorial/EditorialFindingsTriage', () => ({ default: () => <div>findings-triage</div> }));
vi.mock('../components/pipeline/editorial/EditorialHealthPanel', () => ({ default: () => <div>health-panel</div> }));
vi.mock('../components/ProviderModelSelector', () => ({ default: () => <div>provider-selector</div> }));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/pipeline/editorial-checks']}>
      <PipelineEditorialChecks />
    </MemoryRouter>,
  );
}

describe('PipelineEditorialChecks responsive switch (#1611)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEditorialChecks.mockResolvedValue({ checks: [] });
    listPipelineSeries.mockResolvedValue({ series: [] });
    getPipelineManuscriptReview.mockResolvedValue({ comments: [] });
  });

  it('renders a mobile-only Catalog/Findings tablist that toggles which section is visible', async () => {
    renderPage();

    const tablist = await screen.findByRole('tablist', { name: /editorial sections/i });
    // The switch (a shared TabPills) is wrapped in an `lg:hidden` div so it only
    // appears below the breakpoint where the two columns stack.
    expect(tablist.parentElement).toHaveClass('lg:hidden');

    const catalogTab = screen.getByRole('tab', { name: 'Catalog' });
    const findingsTab = screen.getByRole('tab', { name: 'Findings' });

    // Findings is the default mobile tab (primary triage task on small screens).
    expect(findingsTab).toHaveAttribute('aria-selected', 'true');
    expect(catalogTab).toHaveAttribute('aria-selected', 'false');

    // The Catalog <section> heading is the one stacked-hidden on mobile.
    const catalogHeading = screen.getByRole('heading', { name: 'Catalog' });
    const findingsHeading = screen.getByRole('heading', { name: 'Findings' });
    const catalogSection = catalogHeading.closest('section');
    const findingsSection = findingsHeading.closest('section');

    // Both columns always reappear on lg+; only the small-screen visibility flips.
    expect(catalogSection).toHaveClass('lg:block');
    expect(findingsSection).toHaveClass('lg:block');

    // Default: findings shown, catalog hidden below lg.
    expect(findingsSection).not.toHaveClass('hidden');
    expect(catalogSection).toHaveClass('hidden');

    fireEvent.click(catalogTab);

    await waitFor(() => expect(catalogTab).toHaveAttribute('aria-selected', 'true'));
    expect(findingsTab).toHaveAttribute('aria-selected', 'false');
    expect(catalogSection).not.toHaveClass('hidden');
    expect(findingsSection).toHaveClass('hidden');
  });
});
