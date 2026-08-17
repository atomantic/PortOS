import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/api', () => ({
  startPipelineAutopilot: vi.fn(),
  cancelPipelineAutopilot: vi.fn(),
  pausePipelineAutopilot: vi.fn(),
  getPipelineAutopilotStatus: vi.fn(),
  getPipelineAutopilotModelMetrics: vi.fn(),
  pipelineAutopilotSseUrl: (id) => `/api/pipeline/series/${id}/autopilot/progress`,
  getPipelineSeriesCanonReadiness: vi.fn(),
  getPipelineSeries: vi.fn(),
  listPipelineIssues: vi.fn(),
  getProviders: vi.fn(),
  getSettings: vi.fn(),
  patchSettingsSlice: vi.fn(),
}));
// The default export is CALLABLE (a neutral toast) as well as carrying the
// typed helpers — the panel uses the bare call for the self-improvement line.
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}));
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
  getPipelineAutopilotModelMetrics,
  getPipelineSeriesCanonReadiness,
  getPipelineSeries,
  listPipelineIssues,
  getProviders,
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
  getPipelineAutopilotModelMetrics.mockResolvedValue({ evidenceRuns: 0, minimumQualitySamples: 2, metrics: [], recommendations: {} });
  getPipelineSeries.mockResolvedValue(null);
  listPipelineIssues.mockResolvedValue([]);
  startPipelineAutopilot.mockResolvedValue({ runId: 'r1', mode: 'execute', alreadyRunning: false });
  getSettings.mockResolvedValue({ pipelineEditorialChecks: {} });
  patchSettingsSlice.mockResolvedValue({});
  getProviders.mockResolvedValue({
    activeProvider: 'claude',
    providers: [
      { id: 'claude', name: 'Claude Code', type: 'cli', enabled: true, models: ['claude-opus-5'] },
      { id: 'codex', name: 'Codex', type: 'cli', enabled: true, models: ['gpt-5-codex'] },
    ],
  });
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
    fireEvent.click(screen.getByLabelText(/Draft cover \+ all interior pages/i));
    fireEvent.click(screen.getByLabelText(/File CoS tasks for gaps/i));
    fireEvent.click(screen.getByRole('button', { name: /run autopilot/i }));
    await waitFor(() => expect(startPipelineAutopilot).toHaveBeenCalledWith(
      's1', { includeVisual: false, fileGaps: true }, { silent: true },
    ));
  });

  it('persists and sends evidence-based model selection only after opt-in', async () => {
    getPipelineAutopilotModelMetrics.mockResolvedValue({
      evidenceRuns: 6,
      minimumQualitySamples: 2,
      metrics: [{ qualityEvaluated: 4 }],
      recommendations: {},
    });
    renderPanel({ id: 's1', targetFormat: 'comic' });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /options/i }));
    const toggle = screen.getByLabelText(/choose models from stage-specific results/i);
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(patchSettingsSlice).toHaveBeenCalledWith(
      'pipelineEditorialChecks', { autoSelectModels: true }, { silent: true },
    ));
    expect(await screen.findByText(/6 attributed runs, 4 quality-reviewed/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /run autopilot/i }));
    await waitFor(() => expect(startPipelineAutopilot).toHaveBeenCalledWith(
      's1', { includeVisual: true, fileGaps: false, autoSelectModels: true }, { silent: true },
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

  it('sends unlockForRun as a per-run override and never persists it', async () => {
    renderPanel({ id: 's1', targetFormat: 'comic' });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /options/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /unlock everything this series owns/i }));
    // The explainer only appears once armed — it carries the two guarantees.
    expect(screen.getByText(/nothing is ever deleted/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /run autopilot/i }));
    await waitFor(() => expect(startPipelineAutopilot).toHaveBeenCalledWith(
      's1', { includeVisual: true, fileGaps: false, unlockForRun: true }, { silent: true },
    ));
    // Saving it would let a scheduled unattended run inherit lock-clearing.
    expect(patchSettingsSlice).not.toHaveBeenCalledWith(
      'pipelineEditorialChecks',
      expect.objectContaining({ unlockForRun: expect.anything() }),
      expect.anything(),
    );
  });

  // The consent authorizes ONE run. It must not stay armed behind the collapsed
  // Options popover while the Run button is still on screen.
  it('clears the unlock consent after launching, so the next run does not inherit it', async () => {
    const { rerender } = renderPanel({ id: 's1', targetFormat: 'comic' });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /options/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /unlock everything this series owns/i }));
    fireEvent.click(screen.getByRole('button', { name: /run autopilot/i }));
    await waitFor(() => expect(startPipelineAutopilot).toHaveBeenCalledWith(
      's1', expect.objectContaining({ unlockForRun: true }), { silent: true },
    ));
    // Finish the run so the Run/Options controls come back, then launch again:
    // the consent was spent by the first launch and must not silently re-apply.
    // The terminal-frame effect refetches the series + issues, so give those
    // mocks a resolved value or the effect throws on `undefined.then`.
    getPipelineSeries.mockResolvedValue(null);
    listPipelineIssues.mockResolvedValue(null);
    sseLatest = { type: 'complete', runId: 'r1' };
    rerender(
      <MemoryRouter>
        <AutopilotPanel series={{ id: 's1', targetFormat: 'comic' }} onSeriesUpdate={vi.fn()} onIssuesUpdate={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /run autopilot/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /options/i }));
    expect(screen.getByRole('checkbox', { name: /unlock everything this series owns/i })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /run autopilot/i }));
    await waitFor(() => expect(startPipelineAutopilot).toHaveBeenLastCalledWith(
      's1', { includeVisual: true, fileGaps: false }, { silent: true },
    ));
  });

  // The panel is reused across seriesId changes rather than remounted, so a box
  // ticked for one series must not still be armed — invisibly — on the next.
  it('clears the unlock consent when the panel switches series', async () => {
    const { rerender } = renderPanel({ id: 's1', targetFormat: 'comic' });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /options/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /unlock everything this series owns/i }));
    expect(screen.getByRole('checkbox', { name: /unlock everything this series owns/i })).toBeChecked();
    rerender(
      <MemoryRouter>
        <AutopilotPanel series={{ id: 's2', targetFormat: 'comic' }} onSeriesUpdate={vi.fn()} onIssuesUpdate={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(
      screen.getByRole('checkbox', { name: /unlock everything this series owns/i }),
    ).not.toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: /run autopilot/i }));
    await waitFor(() => expect(startPipelineAutopilot).toHaveBeenCalledWith(
      's2', { includeVisual: true, fileGaps: false }, { silent: true },
    ));
  });

  it('starts unticked even when settings carry a stale unlockForRun value', async () => {
    getSettings.mockResolvedValue({ pipelineEditorialChecks: { unlockForRun: true } });
    renderPanel({ id: 's1', targetFormat: 'comic' });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /options/i }));
    expect(screen.getByRole('checkbox', { name: /unlock everything this series owns/i })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /run autopilot/i }));
    await waitFor(() => expect(startPipelineAutopilot).toHaveBeenCalledWith(
      's1', { includeVisual: true, fileGaps: false }, { silent: true },
    ));
  });

  it('reports what the unlock pass cleared and what it left frozen', async () => {
    sseFrames = [{ type: 'unlock:applied', arc: 1, arcFields: 0, seasons: 2, stages: 3, canon: 4, canonForeignKept: 5, worldFields: 0, worldFieldsKept: 2 }];
    sseLatest = sseFrames[0];
    getPipelineAutopilotStatus.mockResolvedValue({ autopilot: { runId: 'r1', status: 'running' }, active: true });
    renderPanel({ id: 's1', targetFormat: 'comic' });
    await waitFor(() => expect(
      screen.getAllByText(/Unlocked arc, 2 volume\(s\), 3 stage\(s\), 4 canon entries · kept 5 other series' canon \+ 2 shared world field\(s\) locked/).length,
    ).toBeGreaterThan(0));
  });

  it('reads an already-unlocked series as a no-op rather than "unlocked 0 things"', async () => {
    sseFrames = [{ type: 'unlock:applied', arc: 0, arcFields: 0, seasons: 0, stages: 0, canon: 0, canonForeignKept: 0, worldFields: 0, worldFieldsKept: 0 }];
    sseLatest = sseFrames[0];
    getPipelineAutopilotStatus.mockResolvedValue({ autopilot: { runId: 'r1', status: 'running' }, active: true });
    renderPanel({ id: 's1', targetFormat: 'comic' });
    await waitFor(() => expect(screen.getAllByText(/Unlock — nothing was locked/).length).toBeGreaterThan(0));
  });

  it('sends a chosen readiness gate as a per-run override without persisting it (#1580)', async () => {
    renderPanel({ id: 's1', targetFormat: 'comic' });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /options/i }));
    fireEvent.change(screen.getByLabelText('Readiness gate'), { target: { value: 'none' } });
    fireEvent.click(screen.getByRole('button', { name: /run autopilot/i }));
    await waitFor(() => expect(startPipelineAutopilot).toHaveBeenCalledWith(
      's1', { includeVisual: true, fileGaps: false, readinessGate: 'none' }, { silent: true },
    ));
    // Per-run only — the gate is never persisted to settings.
    expect(patchSettingsSlice).not.toHaveBeenCalledWith(
      'pipelineEditorialChecks',
      expect.objectContaining({ readinessGate: expect.anything() }),
      expect.anything(),
    );
  });

  it('omits readinessGate when left on the saved default (#1580)', async () => {
    getSettings.mockResolvedValue({ pipelineEditorialChecks: { readinessGate: 'noOpenHighOrMedium' } });
    renderPanel({ id: 's1', targetFormat: 'comic' });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /options/i }));
    // The saved default is surfaced in the "use saved default" option label.
    await waitFor(() => expect(screen.getByLabelText('Readiness gate')).toHaveValue(''));
    expect(screen.getByText(/Use saved default \(No open High or Medium/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /run autopilot/i }));
    // Nothing chosen → no readinessGate sent; server resolves from the setting.
    await waitFor(() => expect(startPipelineAutopilot).toHaveBeenCalledWith(
      's1', { includeVisual: true, fileGaps: false }, { silent: true },
    ));
  });

  it('names the provider/model the run will call — the series llm', async () => {
    renderPanel({ id: 's1', targetFormat: 'comic', llm: { provider: 'codex', model: 'gpt-5-codex' } });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /options/i }));
    const summary = await screen.findByText(/Creation and repair call/i);
    await waitFor(() => expect(summary).toHaveTextContent('Codex / gpt-5-codex'));
  });

  it('falls back to the active provider when the series pins no llm', async () => {
    renderPanel({ id: 's1', targetFormat: 'comic' });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /options/i }));
    const summary = await screen.findByText(/Creation and repair call/i);
    await waitFor(() => expect(summary).toHaveTextContent('Claude Code (provider default model)'));
  });

  it('sends a picked provider/model as a per-run override without persisting it', async () => {
    renderPanel({ id: 's1', targetFormat: 'comic', llm: { provider: 'claude', model: 'claude-opus-5' } });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /options/i }));
    const providerSelect = await screen.findByLabelText('Override provider for this run');
    fireEvent.change(providerSelect, { target: { value: 'codex' } });
    // Switching providers drops the series model — it belongs to the old provider.
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue(''));
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5-codex' } });
    fireEvent.click(screen.getByRole('button', { name: /run autopilot/i }));
    await waitFor(() => expect(startPipelineAutopilot).toHaveBeenCalledWith(
      's1',
      { includeVisual: true, fileGaps: false, providerOverride: 'codex', modelOverride: 'gpt-5-codex' },
      { silent: true },
    ));
    expect(patchSettingsSlice).not.toHaveBeenCalledWith(
      'pipelineEditorialChecks',
      expect.objectContaining({ providerOverride: expect.anything() }),
      expect.anything(),
    );
  });

  it('sends a picked reasoning effort as a per-run override and names it (#3641)', async () => {
    renderPanel({ id: 's1', targetFormat: 'comic', llm: { provider: 'codex', model: 'gpt-5-codex' } });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /options/i }));
    fireEvent.change(await screen.findByLabelText('Thinking effort'), { target: { value: 'high' } });
    const summary = await screen.findByText(/Creation and repair call/i);
    await waitFor(() => expect(summary).toHaveTextContent('high reasoning effort'));
    fireEvent.click(screen.getByRole('button', { name: /run autopilot/i }));
    await waitFor(() => expect(startPipelineAutopilot).toHaveBeenCalledWith(
      's1',
      { includeVisual: true, fileGaps: false, effortOverride: 'high' },
      { silent: true },
    ));
  });

  it('clears a picked effort when the run provider changes (#3641)', async () => {
    // Each provider has its own effort ladder, so a level picked for the old
    // provider must not ride along to the new one.
    renderPanel({ id: 's1', targetFormat: 'comic', llm: { provider: 'codex', model: 'gpt-5-codex' } });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /options/i }));
    fireEvent.change(await screen.findByLabelText('Thinking effort'), { target: { value: 'ultra' } });
    fireEvent.change(screen.getByLabelText('Override provider for this run'), { target: { value: 'claude' } });
    // This mock provider advertises no effort ladder, so the select hides itself —
    // and the cleared state means nothing stale rides along on start.
    await waitFor(() => expect(screen.queryByLabelText('Thinking effort')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /run autopilot/i }));
    await waitFor(() => expect(startPipelineAutopilot).toHaveBeenCalledWith(
      's1', { includeVisual: true, fileGaps: false, providerOverride: 'claude' }, { silent: true },
    ));
  });

  it('can split Luna/max creation from Sol/xhigh judging for one run', async () => {
    getProviders.mockResolvedValue({
      activeProvider: 'codex-tui',
      providers: [{
        id: 'codex-tui', name: 'Codex TUI', type: 'cli', enabled: true,
        models: ['gpt-5.6-luna', 'gpt-5.6-sol'],
      }],
    });
    renderPanel({ id: 's1', targetFormat: 'comic', llm: { provider: 'codex-tui', model: 'gpt-5.6-luna' } });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /options/i }));
    fireEvent.change(await screen.findByLabelText('Thinking effort'), { target: { value: 'max' } });
    fireEvent.click(screen.getByLabelText(/separate model for judging/i));
    const models = screen.getAllByLabelText('Model');
    fireEvent.change(models[1], { target: { value: 'gpt-5.6-sol' } });
    const efforts = screen.getAllByLabelText('Thinking effort');
    fireEvent.change(efforts[1], { target: { value: 'xhigh' } });
    expect(screen.getByText(/Luna\/max writing with an independent Sol\/xhigh critic/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /run autopilot/i }));
    await waitFor(() => expect(startPipelineAutopilot).toHaveBeenCalledWith(
      's1',
      {
        includeVisual: true,
        fileGaps: false,
        effortOverride: 'max',
        judgeLlm: { modelOverride: 'gpt-5.6-sol', effortOverride: 'xhigh' },
      },
      { silent: true },
    ));
  });

  it('can route one stage and role to a specialist model', async () => {
    getProviders.mockResolvedValue({
      activeProvider: 'codex-tui',
      providers: [{
        id: 'codex-tui', name: 'Codex TUI', type: 'cli', enabled: true,
        models: ['gpt-5.6-luna', 'gpt-5.6-sol'],
      }],
    });
    renderPanel({ id: 's1', targetFormat: 'comic', llm: { provider: 'codex-tui', model: 'gpt-5.6-luna' } });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /options/i }));
    fireEvent.click(screen.getByLabelText(/override a specific stage and role/i));
    expect(screen.getByLabelText('Stage override')).toHaveValue('foundationGate');
    expect(screen.getByLabelText('Role')).toHaveValue('creative');
    const models = screen.getAllByLabelText('Model');
    fireEvent.change(models[1], { target: { value: 'gpt-5.6-sol' } });
    const efforts = screen.getAllByLabelText('Thinking effort');
    fireEvent.change(efforts[1], { target: { value: 'xhigh' } });
    expect(screen.getByText(/Active: Codex TUI \/ gpt-5\.6-sol \/ xhigh/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /run autopilot/i }));
    await waitFor(() => expect(startPipelineAutopilot).toHaveBeenCalledWith(
      's1',
      {
        includeVisual: true,
        fileGaps: false,
        stageLlm: {
          foundationGate: {
            creative: { modelOverride: 'gpt-5.6-sol', effortOverride: 'xhigh' },
          },
        },
      },
      { silent: true },
    ));
  });

  it('restores split LLM routing when a paused run is resumed', async () => {
    getProviders.mockResolvedValue({
      activeProvider: 'codex-tui',
      providers: [{
        id: 'codex-tui', name: 'Codex TUI', type: 'cli', enabled: true,
        models: ['gpt-5.6-luna', 'gpt-5.6-sol'],
      }],
    });
    renderPanel({
      id: 's1',
      targetFormat: 'comic',
      autopilot: {
        status: 'paused',
        resumeOptions: {
          providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-luna', effortOverride: 'max',
          judgeLlm: { providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-sol', effortOverride: 'xhigh' },
        },
      },
    });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /options/i }));
    expect(screen.getByLabelText(/separate model for judging/i)).toBeChecked();
    expect(screen.getAllByLabelText('Model')[0]).toHaveValue('gpt-5.6-luna');
    expect(screen.getAllByLabelText('Model')[1]).toHaveValue('gpt-5.6-sol');
    fireEvent.click(screen.getByRole('button', { name: /resume autopilot/i }));
    await waitFor(() => expect(startPipelineAutopilot).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-luna', effortOverride: 'max',
        judgeLlm: { providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-sol', effortOverride: 'xhigh' },
      }),
      { silent: true },
    ));
  });

  it('omits the provider override when left on the series default', async () => {
    renderPanel({ id: 's1', targetFormat: 'comic', llm: { provider: 'codex', model: 'gpt-5-codex' } });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /options/i }));
    fireEvent.click(screen.getByRole('button', { name: /run autopilot/i }));
    // Nothing pinned → the server resolves series.llm itself.
    await waitFor(() => expect(startPipelineAutopilot).toHaveBeenCalledWith(
      's1', { includeVisual: true, fileGaps: false }, { silent: true },
    ));
  });

  it('describes an in-flight run from the status payload start frame when re-attaching', async () => {
    getPipelineAutopilotStatus.mockResolvedValue({
      autopilot: { status: 'running', runId: 'r1' },
      active: true,
      start: { type: 'start', runId: 'r1', mode: 'dry-run', provider: 'codex', model: 'gpt-5-codex' },
    });
    renderPanel({ id: 's1', targetFormat: 'comic' });
    expect(await screen.findByText(/on Codex \/ gpt-5-codex/)).toBeInTheDocument();
    // mode rides the same frame, so the dry-run badge survives a mid-run attach.
    expect(screen.getByText('dry-run')).toBeInTheDocument();
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

  it('offers the rolled-back round\'s findings alongside the preserved set on a regression pause', async () => {
    renderPanel({
      id: 's1',
      targetFormat: 'comic',
      autopilot: {
        status: 'paused',
        currentStep: 'verifyArc',
        pauseKind: 'regression',
        residualFindings: [{ severity: 'high', location: 'V1', problem: 'preserved plot hole' }],
        discardedFindings: [{ severity: 'high', location: 'V3', problem: 'mentor subplot never pays off' }],
      },
    });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    // The restored (better) set is the work queue and stays open; the rejected
    // candidate is collapsed behind a disclosure but reachable for comparison.
    expect(screen.getByText(/preserved plot hole/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/what the reverted round produced/i));
    expect(screen.getByText(/mentor subplot never pays off/i)).toBeInTheDocument();
  });

  it('omits the discarded disclosure when the pause traded nothing away', async () => {
    renderPanel({
      id: 's1',
      targetFormat: 'comic',
      autopilot: {
        status: 'paused',
        currentStep: 'verifyArc',
        pauseKind: 'maxRounds',
        residualFindings: [{ severity: 'high', location: 'V1', problem: 'plot hole' }],
        discardedFindings: [],
      },
    });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    expect(screen.queryByText(/what the reverted round produced/i)).not.toBeInTheDocument();
  });

  it('restores run-local visual and gap choices when a paused run resumes', async () => {
    renderPanel({
      id: 's1',
      targetFormat: 'comic',
      autopilot: {
        status: 'paused',
        resumeOptions: { includeVisual: false, fileGaps: true },
      },
    });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /options/i }));
    expect(screen.getByRole('checkbox', { name: /draft cover \+ all interior pages/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /file CoS tasks for gaps/i })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /resume autopilot/i }));
    await waitFor(() => expect(startPipelineAutopilot).toHaveBeenCalledWith(
      's1', { includeVisual: false, fileGaps: true }, { silent: true },
    ));
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

  it('flags a reverted auto-resolve round with a "round reverted" badge', async () => {
    // The draft is back to its pre-round state — say so, or the user has no way
    // to tell this pause apart from one that left the round's edits in place.
    renderPanel({
      id: 's1',
      targetFormat: 'comic',
      autopilot: { status: 'paused', currentStep: 'verifyArc', pauseKind: 'regression' },
    });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    expect(screen.getByText(/round reverted/i)).toBeInTheDocument();
    expect(screen.queryByText(/not converging/i)).not.toBeInTheDocument();
  });

  it('flags a failed AI repair call with a "provider failed" badge', async () => {
    // A provider timeout / dead CLI is transient and says nothing about the
    // draft — the badge has to separate it from a pause the user must edit for.
    renderPanel({
      id: 's1',
      targetFormat: 'comic',
      autopilot: { status: 'paused', currentStep: 'foundationGate', pauseKind: 'providerFailed' },
    });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    expect(screen.getByText(/provider failed/i)).toBeInTheDocument();
  });

  it('flags an unfixable dimension and a spent budget with their own badges', async () => {
    const { unmount } = renderPanel({
      id: 's1',
      targetFormat: 'comic',
      autopilot: { status: 'paused', currentStep: 'foundationGate', pauseKind: 'inapplicable' },
    });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    expect(screen.getByText(/nothing to fix/i)).toBeInTheDocument();
    unmount();

    renderPanel({
      id: 's1',
      targetFormat: 'comic',
      autopilot: { status: 'paused', currentStep: 'foundationGate', pauseKind: 'budget' },
    });
    await waitFor(() => expect(screen.getByText(/budget reached/i)).toBeInTheDocument());
  });

  it('flags an editorial-checks pause with a "high findings" badge (#1613)', async () => {
    renderPanel({
      id: 's1',
      targetFormat: 'comic',
      autopilot: {
        status: 'paused',
        currentStep: 'editorialChecks',
        pauseKind: 'checkFindings',
        residualFindings: [{ severity: 'high', location: 'ch 1', problem: 'pacing stalls' }],
      },
    });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    expect(screen.getByText(/Paused at Editorial checks/i)).toBeInTheDocument();
    expect(screen.getByText(/high findings/i)).toBeInTheDocument();
    expect(screen.getByText(/pacing stalls/i)).toBeInTheDocument();
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

  it('renders the estimated budget total from planTotals (#1576)', async () => {
    sseLatest = {
      type: 'complete', dryRun: true, runId: 'r1',
      plan: [{ kind: 'verifyArc', count: 1, estActions: 5 }, { kind: 'editorialChecks', count: 1, estActions: 1, estLlmCalls: 6 }],
      planTotals: { estActions: 6, estLlmCalls: 6 },
    };
    renderPanel({ id: 's1', targetFormat: 'comic' });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    expect(await screen.findByText(/Est\. budget/i)).toBeInTheDocument();
    expect(screen.getByText(/≈6 cos action/i)).toBeInTheDocument();
    expect(screen.getByText(/~6 editorial-check LLM call/i)).toBeInTheDocument();
  });

  // The milestone map: the plan the run projected, measured against the progress
  // snapshot, so "where are we in the story" is answerable at a glance.
  describe('milestone map', () => {
    const PLAN = [
      { kind: 'verifyArcSpine', count: 1, estActions: 4 },
      { kind: 'foundationGate', count: 1, estActions: 4 },
      { kind: 'textStages', count: 2, estActions: 2 },
    ];

    it('draws the map from the status payload when the panel attaches mid-run', async () => {
      getPipelineAutopilotStatus.mockResolvedValue({
        autopilot: { status: 'running', runId: 'r1' },
        active: true,
        start: { type: 'start', runId: 'r1', mode: 'execute', plan: PLAN },
        progress: {
          currentStep: 'foundationGate',
          completed: { verifyArcSpine: 1 },
          verified: { verifyArcSpine: { round: 2, findings: 5, blocking: 0 } },
        },
      });
      renderPanel({ id: 's1', targetFormat: 'comic' });
      expect(await screen.findByText(/Story progress/i)).toBeInTheDocument();
      // 1 of 3 milestones settled → 1 of 4 counted units.
      expect(screen.getByText(/1 of 3 milestone\(s\) · 25%/i)).toBeInTheDocument();
      expect(screen.getByRole('progressbar', { name: /story progress/i })).toHaveAttribute('aria-valuenow', '25');
      // What the finished gate actually validated, not just that it ran.
      expect(screen.getByText(/0 blocking of 5 finding\(s\)/i)).toBeInTheDocument();
    });

    it('advances the map on a live progress frame', async () => {
      getPipelineAutopilotStatus.mockResolvedValue({
        autopilot: { status: 'running', runId: 'r1' },
        active: true,
        start: { type: 'start', runId: 'r1', mode: 'execute', plan: PLAN },
        progress: { currentStep: 'verifyArcSpine', completed: {} },
      });
      sseFrames = [
        { type: 'step:complete', kind: 'foundationGate', runId: 'r1' },
        {
          type: 'progress',
          runId: 'r1',
          currentStep: 'textStages',
          completed: { verifyArcSpine: 1, foundationGate: 1, textStages: 1 },
        },
      ];
      sseLatest = sseFrames[1];
      renderPanel({ id: 's1', targetFormat: 'comic' });
      // The newest progress frame wins over the status seed: 2 settled + 1 of 2
      // text stages = 3 of 4 units.
      expect(await screen.findByText(/2 of 3 milestone\(s\) · 75%/i)).toBeInTheDocument();
      expect(screen.getByText('1/2')).toBeInTheDocument();
      // A progress frame carries no status text of its own, so the live line
      // keeps naming the last frame that did.
      // (the status line and the recent-activity log both render it)
      expect(screen.getAllByText(/Judging foundation done/i).length).toBeGreaterThan(0);
    });

    it('leaves a paused run on screen with the step it stopped on', async () => {
      getPipelineAutopilotStatus.mockResolvedValue({
        autopilot: { status: 'running', runId: 'r1' },
        active: true,
        start: { type: 'start', runId: 'r1', mode: 'execute', plan: PLAN },
        progress: { currentStep: 'foundationGate', completed: { verifyArcSpine: 1 } },
      });
      const view = renderPanel({ id: 's1', targetFormat: 'comic' });
      await screen.findByText(/Story progress/i);
      // The run pauses; the map must survive the stream closing rather than
      // vanishing and leaving only a one-line banner.
      sseLatest = { type: 'paused', runId: 'r1', reason: 'foundation gate could not converge' };
      sseFrames = [sseLatest];
      view.rerender(
        <MemoryRouter>
          <AutopilotPanel series={{ id: 's1', targetFormat: 'comic' }} onSeriesUpdate={vi.fn()} onIssuesUpdate={vi.fn()} />
        </MemoryRouter>,
      );
      await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/paused/i)));
      expect(screen.getByText(/Story progress/i)).toBeInTheDocument();
      expect(screen.getByText(/Judging foundation/i)).toBeInTheDocument();
      // The run is over — no Stop/Pause affordances, but the map is still there.
      expect(screen.getByRole('button', { name: /run autopilot/i })).toBeInTheDocument();
    });

    // #4140 — the live halves die with the run, so a reload the morning after a
    // pause has to redraw from the marker the run stamped.
    it('redraws the map from the persisted marker when no run is active', async () => {
      getPipelineAutopilotStatus.mockResolvedValue({ autopilot: { status: 'paused' }, active: false });
      renderPanel({
        id: 's1',
        targetFormat: 'comic',
        autopilot: {
          status: 'paused',
          plan: PLAN,
          progress: {
            currentStep: 'foundationGate',
            currentStepComplete: false,
            completed: { verifyArcSpine: 1 },
            verified: { verifyArcSpine: { round: 2, findings: 5, blocking: 0 } },
          },
        },
      });
      expect(await screen.findByText(/Story progress/i)).toBeInTheDocument();
      expect(screen.getByText(/1 of 3 milestone\(s\) · 25%/i)).toBeInTheDocument();
      expect(screen.getByText(/0 blocking of 5 finding\(s\)/i)).toBeInTheDocument();
      // A paused marker means the run STOPPED on that step, so the meter reads
      // as a halted run rather than one still working.
      expect(screen.getByRole('progressbar', { name: /story progress/i })).toBeInTheDocument();
      expect(screen.getByText(/Judging foundation/i)).toBeInTheDocument();
    });

    it('prefers the live run over the marker when both exist', async () => {
      getPipelineAutopilotStatus.mockResolvedValue({
        autopilot: { status: 'running', runId: 'r2' },
        active: true,
        start: { type: 'start', runId: 'r2', mode: 'execute', plan: PLAN },
        progress: { currentStep: 'textStages', completed: { verifyArcSpine: 1, foundationGate: 1 } },
      });
      // A stale marker from the PREVIOUS run must not win over the run in flight.
      renderPanel({
        id: 's1',
        targetFormat: 'comic',
        autopilot: {
          status: 'paused',
          plan: [{ kind: 'generateArc', count: 1 }],
          progress: { currentStep: 'generateArc', completed: {} },
        },
      });
      expect(await screen.findByText(/2 of 3 milestone\(s\)/i)).toBeInTheDocument();
      expect(screen.queryByText(/Generating arc/i)).not.toBeInTheDocument();
    });
  });

  // #1578 — per-check editorial telemetry forwarded up the autopilot SSE stream
  // renders as a live label with the severity breakdown, not the raw frame type.
  it('renders a forwarded per-check editorial frame with its severity breakdown', async () => {
    getPipelineAutopilotStatus.mockResolvedValue({ autopilot: { status: 'running' }, active: true });
    sseLatest = { type: 'check:complete', scope: 'editorialChecks', checkId: 'prose.info-dumping', label: 'Info dumping', count: 3, bySeverity: { high: 1, medium: 2, low: 0 } };
    renderPanel({ id: 's1', targetFormat: 'comic' });
    expect(await screen.findByText(/Editorial check: Info dumping — 3 finding\(s\) \(1H\/2M\/0L\)/i)).toBeInTheDocument();
  });

  // #1617 — a cancel:acknowledged frame switches the Stop button to a disabled
  // "Cancelling…" state with the active-step-finishing live label.
  it('shows a Cancelling… state when the server acks a cancel (#1617)', async () => {
    getPipelineAutopilotStatus.mockResolvedValue({ autopilot: { status: 'running', runId: 'r1' }, active: true });
    sseLatest = { type: 'cancel:acknowledged', runId: 'r1' };
    renderPanel({ id: 's1', targetFormat: 'comic' });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    const btn = await screen.findByRole('button', { name: /cancelling/i });
    expect(btn).toBeDisabled();
    // The original Stop affordance is gone while cancelling.
    expect(screen.queryByRole('button', { name: /^stop$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/finishing the active step/i)).toBeInTheDocument();
  });

  it('shows a non-destructive Pausing… state for a graceful pause request', async () => {
    getPipelineAutopilotStatus.mockResolvedValue({ autopilot: { status: 'running', runId: 'r1' }, active: true });
    sseLatest = { type: 'pause:acknowledged', runId: 'r1' };
    renderPanel({ id: 's1', targetFormat: 'comic' });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: /pausing/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /stop now/i })).toBeEnabled();
    expect(screen.getByText(/pausing safely.*finishing the active step/i)).toBeInTheDocument();
  });

  it('keeps Pausing… sticky when a later progress frame replaces the acknowledgment', async () => {
    getPipelineAutopilotStatus.mockResolvedValue({
      autopilot: { status: 'running', runId: 'r1' },
      active: true,
      pauseRequested: true,
    });
    sseLatest = { type: 'foundation:round', runId: 'r1', round: 2, weightedScore: 7.2 };
    renderPanel({ id: 's1', targetFormat: 'comic' });
    expect(await screen.findByRole('button', { name: /pausing/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /stop now/i })).toBeEnabled();
  });

  // Pipeline self-improvement — the opt-in that lets a run diagnose PortOS's own
  // automation and file a fix task against it.
  describe('pipeline self-improvement', () => {
    it('is off by default and persists the toggle on change', async () => {
      renderPanel({ id: 's1', targetFormat: 'comic' });
      await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
      fireEvent.click(screen.getByRole('button', { name: /options/i }));
      const toggle = screen.getByLabelText(/improve the pipeline itself/i);
      expect(toggle).not.toBeChecked();
      fireEvent.click(toggle);
      await waitFor(() => expect(patchSettingsSlice).toHaveBeenCalledWith(
        'pipelineEditorialChecks', { selfImprove: true }, { silent: true },
      ));
      // The filed task is always approval-gated — there is no auto-start knob.
      expect(await screen.findByText(/waiting in your CoS approval queue/i)).toBeInTheDocument();
    });

    it('sends the toggle as a per-run override once edited', async () => {
      renderPanel({ id: 's1', targetFormat: 'comic' });
      await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
      fireEvent.click(screen.getByRole('button', { name: /options/i }));
      fireEvent.click(screen.getByLabelText(/improve the pipeline itself/i));
      fireEvent.click(screen.getByRole('button', { name: /run autopilot/i }));
      await waitFor(() => expect(startPipelineAutopilot).toHaveBeenCalledWith(
        's1',
        { includeVisual: true, fileGaps: false, selfImprove: true },
        { silent: true },
      ));
    });

    it('announces a filed PortOS fix from the terminal frame', async () => {
      getPipelineAutopilotStatus.mockResolvedValue({ autopilot: { status: 'running', runId: 'r1' }, active: true });
      sseLatest = {
        type: 'paused', runId: 'r1', reason: 'editorial review ran out of rounds',
        selfImprove: { verdict: 'pipeline', area: 'editorial-check', title: 'Check pleasantries at beat altitude', filed: true },
      };
      renderPanel({ id: 's1', targetFormat: 'comic' });
      await waitFor(() => expect(toast).toHaveBeenCalledWith(
        expect.stringMatching(/Filed a PortOS fix task \(editorial-check\).*approve it in CoS/i),
      ));
    });

    it('shows the verdict on the persisted status banner', async () => {
      renderPanel({
        id: 's1',
        targetFormat: 'comic',
        autopilot: {
          status: 'paused', runId: 'r1', currentStep: 'editorialReview', lastError: 'ran out of rounds',
          selfImprove: { verdict: 'pipeline', area: 'runner', title: 'Retry budget is never applied', filed: true },
        },
      });
      expect(await screen.findByText(/Filed a PortOS fix task \(runner\).*approve it in CoS/i)).toBeInTheDocument();
    });

    it('says nothing when the verdict was that the story, not the code, needs work', async () => {
      renderPanel({
        id: 's1',
        targetFormat: 'comic',
        autopilot: { status: 'paused', runId: 'r1', selfImprove: { verdict: 'content', filed: false } },
      });
      await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
      expect(screen.queryByText(/PortOS fix task/i)).not.toBeInTheDocument();
    });
  });

  // Observing orchestrator — the opt-in that lets a run dispatch auto-approved
  // pipeline fixes (PR + review loop + merge, no human gate) as it progresses.
  describe('observing orchestrator', () => {
    it('is off by default and persists the toggle on change', async () => {
      renderPanel({ id: 's1', targetFormat: 'comic' });
      await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
      fireEvent.click(screen.getByRole('button', { name: /options/i }));
      const toggle = screen.getByLabelText(/observing orchestrator/i);
      expect(toggle).not.toBeChecked();
      fireEvent.click(toggle);
      await waitFor(() => expect(patchSettingsSlice).toHaveBeenCalledWith(
        'pipelineEditorialChecks', { observer: true }, { silent: true },
      ));
      // The explainer must say the quiet part out loud: fixes dispatch and
      // merge without an approval step, and enabling this is the consent.
      expect(await screen.findByText(/merges after the review loop with no approval step/i)).toBeInTheDocument();
    });

    it('sends the toggle as a per-run override once edited', async () => {
      renderPanel({ id: 's1', targetFormat: 'comic' });
      await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
      fireEvent.click(screen.getByRole('button', { name: /options/i }));
      fireEvent.click(screen.getByLabelText(/observing orchestrator/i));
      fireEvent.click(screen.getByRole('button', { name: /run autopilot/i }));
      await waitFor(() => expect(startPipelineAutopilot).toHaveBeenCalledWith(
        's1',
        { includeVisual: true, fileGaps: false, observer: true },
        { silent: true },
      ));
    });

    it('renders a live observer:filed frame with the dispatched fix', async () => {
      getPipelineAutopilotStatus.mockResolvedValue({ autopilot: { status: 'running' }, active: true });
      sseLatest = { type: 'observer:filed', runId: 'r1', area: 'editorial-check', title: 'Check pleasantries at beat altitude', filed: true };
      renderPanel({ id: 's1', targetFormat: 'comic' });
      expect(await screen.findByText(/Orchestrator dispatched a pipeline fix \(editorial-check\): Check pleasantries at beat altitude/i)).toBeInTheDocument();
    });

    it('announces the dispatched fixes from the terminal frame', async () => {
      getPipelineAutopilotStatus.mockResolvedValue({ autopilot: { status: 'running', runId: 'r1' }, active: true });
      sseLatest = {
        type: 'paused', runId: 'r1', reason: 'editorial review ran out of rounds',
        observer: { passes: 2, filed: [{ area: 'runner', title: 'Retry budget is never applied', taskId: 't1', filed: true }] },
      };
      renderPanel({ id: 's1', targetFormat: 'comic' });
      await waitFor(() => expect(toast).toHaveBeenCalledWith(
        expect.stringMatching(/Orchestrator dispatched 1 pipeline fix.*review and merge on their own/i),
      ));
    });

    it('lists the dispatched fixes on the persisted status banner', async () => {
      renderPanel({
        id: 's1',
        targetFormat: 'comic',
        autopilot: {
          status: 'done', runId: 'r1',
          observer: { passes: 1, filed: [{ area: 'pipeline-step', title: 'Verify beats before drafting text', taskId: 't1', filed: true }] },
        },
      });
      expect(await screen.findByText(/Orchestrator dispatched 1 pipeline fix/i)).toBeInTheDocument();
      expect(screen.getByText(/pipeline-step — Verify beats before drafting text/i)).toBeInTheDocument();
    });
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

  it('explains that outline-only issues are missing a visual source', async () => {
    getPipelineSeriesCanonReadiness.mockResolvedValue({
      ready: false,
      undescribed: [],
      blockingIssues: [{
        issueId: 'iss-2', number: 2, title: 'Threshold', none: [],
        blockingReason: 'missing-visual-source', missingSourceStages: ['comicScript'],
      }],
    });
    renderPanel({ id: 's1', targetFormat: 'comic' });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /^check$/i }));

    expect(await screen.findByText(/outline or prose draft cannot prove canon is ready/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /#2 Threshold/i }))
      .toHaveAttribute('href', '/pipeline/issues/iss-2/comicScript');
  });

  it('shows visual-source and canon-noun blockers for the same issue', async () => {
    getPipelineSeriesCanonReadiness.mockResolvedValue({
      ready: false,
      undescribed: [{ id: 'c1', name: 'Kai', kind: 'character' }],
      blockingIssues: [{
        issueId: 'iss-2', number: 2, title: 'Threshold',
        none: [{ id: 'c1', name: 'Kai', kind: 'character' }],
        blockingReason: 'missing-visual-source', missingSourceStages: ['teleplay'],
      }],
    });
    renderPanel({ id: 's1', targetFormat: 'hybrid' });
    await waitFor(() => expect(getPipelineAutopilotStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /^check$/i }));

    expect(await screen.findByText(/Kai \(character\)/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Threshold — visual script/i }))
      .toHaveAttribute('href', '/pipeline/issues/iss-2/teleplay');
    expect(screen.getByRole('link', { name: /Threshold — canon nouns/i }))
      .toHaveAttribute('href', '/pipeline/issues/iss-2/nouns');
  });
});
