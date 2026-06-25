import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PipelineEditorialChecks from './PipelineEditorialChecks';
import { Toaster, toast } from '../components/ui/Toast';

// #1697 — the triage's session-local check mute must flow into the health panel's
// filterable sets so a muted check's deep-link row stops advertising itself as
// clickable (clicking it would scroll to an empty filtered triage view). The mute
// state was lifted to this page, so this suite renders the REAL triage + health
// panel together and exercises the cross-component handshake.

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

const CHECK_ID = 'naming.dissimilar-names';
const CHECK_LABEL = 'Character name dissimilarity';
const CHECK = { id: CHECK_ID, label: CHECK_LABEL, scope: 'series', kind: 'deterministic', enabled: true };

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/pipeline/editorial-checks?series=ser-1`]}>
      <PipelineEditorialChecks />
      <Toaster />
    </MemoryRouter>,
  );
}

describe('PipelineEditorialChecks — muted checks drop out of the health-panel filterable sets (#1697)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toast.dismiss();
    listPipelineSeries.mockResolvedValue([{ id: 'ser-1', title: 'My Series' }]);
    getEditorialChecks.mockResolvedValue({ checks: [CHECK] });
    getPipelineManuscriptReview.mockResolvedValue({
      comments: [{ id: 'c1', checkId: CHECK_ID, status: 'open', severity: 'high', problem: 'Noisy finding', category: 'naming' }],
    });
    getEditorialHealth.mockResolvedValue({
      score: 50, gate: 'noOpenHigh', ready: false,
      openBySeverity: { high: 1, medium: 0, low: 0 },
      openByCategory: { naming: 1 },
      openByCheck: { [CHECK_ID]: 1 },
      perIssue: [],
      trend: { points: [], regressions: [], checkRegressions: [] },
    });
    getEditorialChecksRunStatus.mockResolvedValue({ active: false });
    patchEditorialCheck.mockImplementation((id, body) => Promise.resolve({ ...CHECK, ...body }));
  });

  it('makes the health-panel check + category rows non-interactive after the check is muted in the triage', async () => {
    renderPage();

    // Before muting: both the check row and its category row deep-link the triage.
    expect(await screen.findByTitle(`Filter findings to ${CHECK_LABEL}`)).toBeTruthy();
    expect(screen.getByTitle('Filter findings to naming')).toBeTruthy();

    // Mute the check from the triage's in-situ Disable affordance.
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Disable check: ${CHECK_LABEL}`, 'i') }));

    // The deep-link rows survive (the findings still exist) but stop advertising as
    // clickable — the only finding behind each is now hidden in the triage.
    await screen.findByTitle(`${CHECK_LABEL} findings aren't in the triage filter`);
    expect(screen.queryByTitle(`Filter findings to ${CHECK_LABEL}`)).toBeNull();
    expect(screen.getByTitle("naming findings aren't in the triage filter")).toBeTruthy();
    expect(screen.queryByTitle('Filter findings to naming')).toBeNull();

    // It also persisted the disable server-side.
    expect(patchEditorialCheck).toHaveBeenCalledWith(CHECK_ID, { enabled: false }, { silent: true });
  });

  it('re-arms the health-panel rows when the mute is undone', async () => {
    renderPage();
    await screen.findByTitle(`Filter findings to ${CHECK_LABEL}`);

    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Disable check: ${CHECK_LABEL}`, 'i') }));
    await screen.findByTitle(`${CHECK_LABEL} findings aren't in the triage filter`);

    // The undo toast re-enables the check and restores the deep-link.
    fireEvent.click(await screen.findByRole('button', { name: /undo/i }));
    // handleToggle chains the PATCH onto a per-check tail (a microtask), so the
    // re-enable call lands asynchronously after the click.
    await waitFor(() => expect(patchEditorialCheck).toHaveBeenCalledWith(CHECK_ID, { enabled: true }, { silent: true }));
    await screen.findByTitle(`Filter findings to ${CHECK_LABEL}`);
  });

  it('reconciles the health-panel rows back when the disable PATCH fails', async () => {
    patchEditorialCheck.mockImplementation((id, body) => (
      body.enabled === false ? Promise.reject(new Error('nope')) : Promise.resolve({ ...CHECK, ...body })
    ));
    renderPage();
    await screen.findByTitle(`Filter findings to ${CHECK_LABEL}`);

    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Disable check: ${CHECK_LABEL}`, 'i') }));

    // Optimistically hidden, then un-hidden once the PATCH rejects — the deep-link
    // comes back rather than stranding the row as permanently non-clickable.
    await waitFor(() => expect(screen.queryByTitle(`${CHECK_LABEL} findings aren't in the triage filter`)).toBeNull());
    expect(screen.getByTitle(`Filter findings to ${CHECK_LABEL}`)).toBeTruthy();
  });
});
