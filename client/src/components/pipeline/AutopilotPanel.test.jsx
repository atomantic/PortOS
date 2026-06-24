import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../services/api', () => ({
  startPipelineAutopilot: vi.fn(),
  cancelPipelineAutopilot: vi.fn(),
  getPipelineAutopilotStatus: vi.fn(),
  pipelineAutopilotSseUrl: (id) => `/api/pipeline/series/${id}/autopilot/progress`,
  getPipelineSeriesCanonReadiness: vi.fn(),
  getPipelineSeries: vi.fn(),
  listPipelineIssues: vi.fn(),
  getSettings: vi.fn(),
  patchSettingsSlice: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
// Controllable SSE hook so tests don't touch EventSource. `sseLatest` lets a
// test simulate a stale terminal frame left over from a previous run.
let sseLatest = null;
let sseFrames = [];
vi.mock('../../hooks/usePipelineProgress', () => ({
  usePipelineProgress: () => ({ latest: sseLatest, frames: sseFrames }),
}));

import {
  startPipelineAutopilot,
  getPipelineAutopilotStatus,
  getPipelineSeriesCanonReadiness,
  getSettings,
  patchSettingsSlice,
} from '../../services/api';
import toast from '../ui/Toast';
import AutopilotPanel from './AutopilotPanel';

const renderPanel = (series, props = {}) =>
  render(
    <MemoryRouter>
      <AutopilotPanel series={series} onSeriesUpdate={vi.fn()} onIssuesUpdate={vi.fn()} {...props} />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  sseLatest = null;
  sseFrames = [];
  getPipelineAutopilotStatus.mockResolvedValue({ autopilot: null, active: false });
  startPipelineAutopilot.mockResolvedValue({ runId: 'r1', mode: 'execute', alreadyRunning: false });
  getSettings.mockResolvedValue({ pipelineEditorialChecks: {} });
  patchSettingsSlice.mockResolvedValue({});
});

describe('AutopilotPanel', () => {
  it('starts an autopilot run with the default options', async () => {
    renderPanel({ id: 's1', targetFormat: 'comic' });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /run autopilot/i }));
    // Rounds are NOT sent as per-run overrides — the server resolves them from
    // the persisted setting (which start() saves first when loaded).
    await waitFor(() => expect(startPipelineAutopilot).toHaveBeenCalledWith(
      's1', { includeVisual: true, fileGaps: false }, { silent: true },
    ));
  });

  it('passes options chosen in the popover', async () => {
    renderPanel({ id: 's1', targetFormat: 'comic' });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /options/i }));
    // uncheck draft visuals, check file-gaps
    const checks = screen.getAllByRole('checkbox');
    fireEvent.click(checks[0]); // includeVisual -> false
    fireEvent.click(checks[1]); // fileGaps -> true
    fireEvent.click(screen.getByRole('button', { name: /run autopilot/i }));
    await waitFor(() => expect(startPipelineAutopilot).toHaveBeenCalledWith(
      's1', { includeVisual: false, fileGaps: true }, { silent: true },
    ));
  });

  it('sends only edited rounds as overrides AND persists them; untouched gates omitted', async () => {
    getSettings.mockResolvedValue({ pipelineEditorialChecks: { maxArcVerifyRounds: 6, maxEditorialRounds: 4 } });
    renderPanel({ id: 's1', targetFormat: 'comic' });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /options/i }));
    // Wait for the persisted setting to populate the input, then edit only arc.
    await waitFor(() => expect(screen.getByLabelText('Arc verify rounds')).toHaveValue(6));
    fireEvent.change(screen.getByLabelText('Arc verify rounds'), { target: { value: '9' } });
    fireEvent.blur(screen.getByLabelText('Arc verify rounds'));
    fireEvent.click(screen.getByRole('button', { name: /run autopilot/i }));
    // The edited value is BOTH persisted and sent as a per-run override (so it's
    // effective even if the save fails), while the untouched editorial gate is
    // sent in neither (server resolves it from the persisted setting).
    await waitFor(() => expect(startPipelineAutopilot).toHaveBeenCalledWith(
      's1', { includeVisual: true, fileGaps: false, maxArcVerifyRounds: 9 }, { silent: true },
    ));
    expect(patchSettingsSlice).toHaveBeenCalledWith(
      'pipelineEditorialChecks',
      expect.objectContaining({ maxArcVerifyRounds: 9 }),
      { silent: true },
    );
    expect(patchSettingsSlice).not.toHaveBeenCalledWith(
      'pipelineEditorialChecks',
      expect.objectContaining({ maxEditorialRounds: expect.anything() }),
      expect.anything(),
    );
  });

  it('clears to the default (not 0) when a round input is emptied', async () => {
    renderPanel({ id: 's1', targetFormat: 'comic' });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /options/i }));
    const input = screen.getByLabelText('Arc verify rounds');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    // Number('') === 0 would skip the gate — clearing must fall back to the default.
    await waitFor(() => expect(input).toHaveValue(3));
  });

  it('shows a paused banner with residual findings and a Resume action', async () => {
    renderPanel({
      id: 's1',
      targetFormat: 'comic',
      autopilot: {
        status: 'paused',
        currentStep: 'verifyArc',
        residualFindings: [{ severity: 'high', location: 'season:2', problem: 'plot hole' }],
      },
    });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    expect(screen.getByText(/Paused at Verifying arc/i)).toBeInTheDocument();
    expect(screen.getByText(/plot hole/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resume autopilot/i })).toBeInTheDocument();
  });

  it('flags a divergence pause with a "not converging" badge (#1571)', async () => {
    renderPanel({
      id: 's1',
      targetFormat: 'comic',
      autopilot: { status: 'paused', currentStep: 'verifyArc', pauseKind: 'divergence' },
    });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    expect(screen.getByText(/not converging/i)).toBeInTheDocument();
  });

  it('does not show the "not converging" badge for an ordinary maxRounds pause', async () => {
    renderPanel({
      id: 's1',
      targetFormat: 'comic',
      autopilot: { status: 'paused', currentStep: 'verifyArc', pauseKind: 'maxRounds' },
    });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    expect(screen.queryByText(/not converging/i)).not.toBeInTheDocument();
  });

  it('shows the production-ready banner for a clean done marker', async () => {
    renderPanel({ id: 's1', targetFormat: 'comic', autopilot: { status: 'done', craftGapIssues: 0 } });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    expect(screen.getByText(/draft is production-ready/i)).toBeInTheDocument();
  });

  it('qualifies a done marker that filed script-craft gaps as a caution (#1572)', async () => {
    renderPanel({ id: 's1', targetFormat: 'comic', autopilot: { status: 'done', craftGapIssues: 2, craftGapFindings: 3 } });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    expect(screen.getByText(/Completed with 2 filed script-craft gaps — resolve before rendering/i)).toBeInTheDocument();
    expect(screen.queryByText(/draft is production-ready/i)).not.toBeInTheDocument();
  });

  it('uses the singular gap label when exactly one craft gap was filed (#1572)', async () => {
    renderPanel({ id: 's1', targetFormat: 'comic', autopilot: { status: 'done', craftGapIssues: 1, craftGapFindings: 1 } });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    expect(screen.getByText(/Completed with 1 filed script-craft gap —/i)).toBeInTheDocument();
  });

  it('qualifies a done marker with errored editorial checks as a caution (#1573)', async () => {
    renderPanel({ id: 's1', targetFormat: 'comic', autopilot: { status: 'done', craftGapIssues: 0, editorialCheckErrors: 2 } });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    expect(screen.getByText(/2 editorial checks errored — review before trusting/i)).toBeInTheDocument();
    expect(screen.queryByText(/draft is production-ready/i)).not.toBeInTheDocument();
  });

  it('prefers the craft-gap caution over the editorial-check caution when both are present (#1573)', async () => {
    renderPanel({ id: 's1', targetFormat: 'comic', autopilot: { status: 'done', craftGapIssues: 1, craftGapFindings: 1, editorialCheckErrors: 1 } });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    expect(screen.getByText(/Completed with 1 filed script-craft gap —/i)).toBeInTheDocument();
    expect(screen.queryByText(/editorial check/i)).not.toBeInTheDocument();
  });

  it('ignores a stale terminal frame from a previous run when starting again', async () => {
    startPipelineAutopilot.mockResolvedValue({ runId: 'B', mode: 'execute' });
    sseLatest = { type: 'complete', runId: 'A' }; // leftover terminal frame from run A
    renderPanel({ id: 's1', targetFormat: 'comic' });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /run autopilot/i }));
    await waitFor(() => expect(startPipelineAutopilot).toHaveBeenCalled());
    // The stale complete(A) must NOT end the new run B.
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
  });

  it('shows a generic Paused label when the marker has no current step', async () => {
    renderPanel({ id: 's1', targetFormat: 'comic', autopilot: { status: 'paused', currentStep: null } });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.queryByText(/Paused at null/i)).not.toBeInTheDocument();
  });

  it('renders a dry-run plan delivered only on the terminal frame', async () => {
    sseLatest = { type: 'complete', dryRun: true, runId: 'r1', plan: [{ kind: 'verifyArc', count: 1 }, { kind: 'visualDraft', count: 2, note: 'draft' }] };
    renderPanel({ id: 's1', targetFormat: 'comic' });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    expect(await screen.findByText(/Dry-run plan/i)).toBeInTheDocument();
    expect(screen.getByText(/Verifying arc/i)).toBeInTheDocument();
  });

  it('renders canon readiness gaps with a link to the issue Nouns page', async () => {
    getPipelineSeriesCanonReadiness.mockResolvedValue({
      ready: false,
      undescribed: [{ id: 'c1', name: 'Kai', kind: 'character' }],
      blockingIssues: [{ issueId: 'iss-9', number: 3, title: 'Backdoor', none: [{ id: 'c1', name: 'Kai', kind: 'character' }] }],
    });
    renderPanel({ id: 's1', targetFormat: 'comic' });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /^check$/i }));
    await waitFor(() => expect(getPipelineSeriesCanonReadiness).toHaveBeenCalledWith('s1', { silent: true }));
    expect(await screen.findByText(/Kai \(character\)/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /#3 Backdoor/i });
    expect(link).toHaveAttribute('href', '/pipeline/issues/iss-9/nouns');
  });
});
