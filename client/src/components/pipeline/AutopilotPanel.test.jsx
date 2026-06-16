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
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
// Keep the SSE hook inert so tests don't touch EventSource.
vi.mock('../../hooks/usePipelineProgress', () => ({
  usePipelineProgress: () => ({ latest: null, frames: [] }),
}));

import {
  startPipelineAutopilot,
  getPipelineAutopilotStatus,
  getPipelineSeriesCanonReadiness,
} from '../../services/api';
import AutopilotPanel from './AutopilotPanel';

const renderPanel = (series, props = {}) =>
  render(
    <MemoryRouter>
      <AutopilotPanel series={series} onSeriesUpdate={vi.fn()} onIssuesUpdate={vi.fn()} {...props} />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  getPipelineAutopilotStatus.mockResolvedValue({ autopilot: null, active: false });
  startPipelineAutopilot.mockResolvedValue({ runId: 'r1', mode: 'execute', alreadyRunning: false });
});

describe('AutopilotPanel', () => {
  it('starts an autopilot run with the default options', async () => {
    renderPanel({ id: 's1', targetFormat: 'comic' });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /run autopilot/i }));
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
