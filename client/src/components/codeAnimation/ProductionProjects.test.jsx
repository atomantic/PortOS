import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('../../hooks/useProviderModels', () => ({ default: () => ({ providers: [{ id: 'example-provider', name: 'Example agent', type: 'cli', command: 'claude', models: ['example-model'] }] }) }));
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } }));
vi.mock('../../services/apiCodeAnimation', () => ({
  preflightCodeAnimationProject: vi.fn(),
  getCodeAnimationExecution: vi.fn(), updateCodeAnimationExecutionTools: vi.fn(), probeCodeAnimationExecution: vi.fn(),
  listCodeAnimationProjects: vi.fn(), createCodeAnimationProject: vi.fn(), getCodeAnimationProject: vi.fn(),
  updateCodeAnimationProject: vi.fn(), importCodeAnimationPackage: vi.fn(), acceptCodeAnimationSource: vi.fn(),
  getCodeAnimationProjectBrief: vi.fn(), getCodeAnimationRevisionPackage: vi.fn(), listCodeAnimationProjectHistory: vi.fn(),
  startCodeAnimationStageRun: vi.fn(), cancelCodeAnimationStageRun: vi.fn(),
}));
import * as api from '../../services/apiCodeAnimation';
import ProductionProjects from './ProductionProjects';

const project = {
  id: '00000000-0000-4000-8000-000000000001', title: 'Example Production',
  manifest: {
    title: 'Example Production', brief: { concept: 'A cube hops.', cast: '', onScreenText: '' }, styleGuide: 'Graphic shapes',
    renderer: { kind: 'browser', version: 'example-v1', engine: null },
    format: { width: 1280, height: 720, fps: 24, durationSeconds: 10 }, seed: 7,
    audio: { kind: 'silence' }, entrypoints: [{ role: 'preview', path: 'index.html' }],
    execution: { requested: null, effective: null }, assets: [], events: [], shots: [],
  },
  budgets: { iterations: 3, timeSeconds: 123, tokens: 4321, renderSeconds: 45, diskBytes: 123456 },
  localSettings: { providerId: 'example-provider', model: 'example-model', mode: 'cli', effort: 'high' },
  acceptedRevisionId: null, candidateRevisionId: '00000000-0000-4000-8000-000000000002',
};
const page = (items = []) => ({ items, nextCursor: null });
const execution = (overrides = {}) => ({
  platform: 'darwin', mechanism: { id: 'macos-seatbelt', supported: true, reason: null }, probe: null,
  tools: { blender: { executable: null, problem: 'Not configured.' } },
  lanes: { browser: { mechanism: 'chromium-cdp-sandbox' }, blender: { ready: false, reason: 'Blender: Not configured.' } },
  ...overrides,
});
const renderPage = (entry = '/code-animation/production/' + project.id) => render(
  <MemoryRouter initialEntries={[entry]}><Routes>
    <Route path="/code-animation/production" element={<ProductionProjects />} />
    <Route path="/code-animation/production/:projectId" element={<ProductionProjects />} />
  </Routes></MemoryRouter>
);
beforeEach(() => {
  vi.resetAllMocks();
  api.listCodeAnimationProjects.mockResolvedValue(page([project]));
  api.getCodeAnimationProject.mockResolvedValue(project);
  api.listCodeAnimationProjectHistory.mockResolvedValue(page());
  api.getCodeAnimationExecution.mockResolvedValue(execution());
});

describe('Production project rendered interactions', () => {
  it('starts from saved settings, immediately displays revision-bound audio, and keeps older evidence visibly stale', async () => {
    const user = userEvent.setup();
    api.listCodeAnimationProjectHistory.mockResolvedValue(page([{ id: 'example-sound-run', status: 'completed', data: {
      kind: 'production-stages', stages: [], soundtrack: { revisionId: 'old-revision', packageHash: 'example-bound-hash',
        artifact: { relativePath: 'code-animations/projects/example/runs/example/artifacts/sound-example.wav' },
        measured: { durationMs: 2000, sampleRate: 48000 }, events: [{ label: 'Impact', firstSeconds: 0.5, frame: 6 }],
        unverified: [{ dimension: 'hearing', reason: 'Listening quality is unverified.' }] },
      output: { path: '/data/videos/example.mp4', audioEvidence: { decodedDurationSeconds: 2 } },
    } }]));
    api.startCodeAnimationStageRun.mockResolvedValue({ id: 'example-live-run', status: 'running', kind: 'production-stages', stages: [] });
    api.preflightCodeAnimationProject.mockResolvedValue({ capabilities: {} });
    renderPage();
    expect(await screen.findByText('Sound evidence belongs to an older revision.')).toBeInTheDocument();
    expect(screen.getByLabelText('Production soundtrack preview')).toHaveAttribute('src', '/data/code-animations/projects/example/runs/example/artifacts/sound-example.wav');
    expect(screen.getByLabelText('Production final film')).toHaveAttribute('src', '/data/videos/example.mp4');
    expect(screen.getByText(/Final MP4 audio decoded and measured/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Run production stages' }));
    await user.click(await screen.findByRole('button', { name: 'Start run' }));
    expect(api.startCodeAnimationStageRun).toHaveBeenCalledWith(project.id, {}, { silent: true });
    expect(await screen.findByRole('button', { name: 'Cancel run' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Run production stages' })).toBeDisabled();
  });

  it('opens a URL-selected detail and applies accepted-source responses immediately', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByLabelText('Film brief')).toHaveValue('A cube hops.');
    api.acceptCodeAnimationSource.mockResolvedValue({ ...project, acceptedRevisionId: project.candidateRevisionId, candidateRevisionId: null });
    await user.click(screen.getByRole('button', { name: 'Accept candidate source' }));
    expect(await screen.findByRole('button', { name: 'Export accepted package' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Accept candidate source' })).toBeNull();
    expect(api.acceptCodeAnimationSource).toHaveBeenCalledWith(project.id, project.candidateRevisionId, { silent: true });
    expect(api.getCodeAnimationProject).toHaveBeenCalledTimes(1);
  });

  it('gates imports on saved budgets and stages package responses without execution', async () => {
    const user = userEvent.setup();
    renderPage();
    const tokenInput = await screen.findByLabelText('Tokens');
    await user.clear(tokenInput); await user.type(tokenInput, '5555');
    expect(screen.getByLabelText('Import source package as a new candidate')).toBeDisabled();
    const saved = { ...project, budgets: { ...project.budgets, tokens: 5555 } };
    api.updateCodeAnimationProject.mockResolvedValue(saved);
    await user.click(screen.getByRole('button', { name: 'Save project settings' }));
    await waitFor(() => expect(screen.getByLabelText('Import source package as a new candidate')).toBeEnabled());
    expect(api.updateCodeAnimationProject).toHaveBeenCalledWith(project.id, expect.objectContaining({ budgets: saved.budgets }), { silent: true });
    const source = { schemaVersion: 1, revisionHash: 'example-hash' };
    const file = new File([JSON.stringify(source)], 'example.json', { type: 'application/json' });
    file.text = async () => JSON.stringify(source);
    api.importCodeAnimationPackage.mockResolvedValue({
      project: saved, runId: 'example-run', executed: false,
      revision: { id: saved.candidateRevisionId, packageHash: 'example-hash', totalBytes: 128, createdAt: '2026-01-01T00:00:00Z' },
    });
    await user.upload(screen.getByLabelText('Import source package as a new candidate'), file);
    expect(await screen.findByText('example-hash')).toBeInTheDocument();
    expect(screen.getByText(/Source execution: None/)).toBeInTheDocument();
    expect(api.importCodeAnimationPackage).toHaveBeenCalledWith(project.id, source, { silent: true });
  });

  it('confirms before starting a stage run, then shows live stages, unverified dimensions, cancel and resume', async () => {
    const user = userEvent.setup();
    const stage = (key, extra = {}) => ({ key, stageRunId: key + '-id', status: 'completed', ...extra });
    const runData = (overrides = {}) => ({
      kind: 'production-stages', spent: { elapsedMs: 2000, iterations: 0 }, budgets: project.budgets, resumable: false, findings: [],
      stages: [stage('style-frame', { artifacts: [{ atSeconds: 1, relativePath: 'code-animations/example/style.png' }] }), stage('inspect', { verified: ['audio'] })],
      verdict: { status: 'pass', reason: null, unverified: [{ dimension: 'semantic-visual', reason: 'No visual reviewer pass ran.' }] },
      ...overrides,
    });
    const stopped = { id: 'run-stopped', status: 'canceled', createdAt: '2026-01-01T00:00:00Z', data: runData({ resumable: true, stopReason: 'canceled' }) };
    api.listCodeAnimationProjectHistory.mockResolvedValue(page([stopped]));
    api.preflightCodeAnimationProject.mockResolvedValue({ problems: [], capabilities: { imageInputAccepted: true } });
    api.startCodeAnimationStageRun.mockResolvedValue({ id: 'run-new' });
    renderPage();
    expect(await screen.findByText(/Unverified: semantic-visual/)).toBeInTheDocument();
    expect(screen.getByText('Verified: audio')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Style frame at 1s' })).toHaveAttribute('href', '/data/code-animations/example/style.png');

    await user.click(screen.getByRole('button', { name: 'Run production stages' }));
    expect(api.startCodeAnimationStageRun).not.toHaveBeenCalled();
    expect(await screen.findByText(/A repair calls/)).toHaveTextContent('example-provider');
    await user.click(screen.getByLabelText(/visual review/));
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    await waitFor(() => expect(api.startCodeAnimationStageRun).toHaveBeenCalledWith(project.id, { visualReview: true }, { silent: true }));

    await user.click(screen.getByRole('button', { name: 'Resume run' }));
    await waitFor(() => expect(api.startCodeAnimationStageRun).toHaveBeenCalledWith(project.id, { resumeFromRunId: 'run-stopped' }, { silent: true }));
    expect(screen.queryByText(/Package import/)).toBeNull();
  });

  it('preserves the authoring pin across renderer edits and checks only saved settings', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText('Renderer');
    await user.selectOptions(screen.getByLabelText('Renderer'), 'blender');
    expect(screen.getByRole('button', { name: 'Check saved authoring settings' })).toBeDisabled();
    api.updateCodeAnimationProject.mockImplementation(async (_id, input) => ({ ...project, ...input }));
    await user.click(screen.getByRole('button', { name: 'Save project settings' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check saved authoring settings' })).toBeEnabled());
    expect(api.updateCodeAnimationProject).toHaveBeenCalledWith(project.id, expect.objectContaining({ localSettings: project.localSettings, manifest: expect.objectContaining({ renderer: expect.objectContaining({ kind: 'blender' }) }) }), { silent: true });
    api.preflightCodeAnimationProject.mockResolvedValue({ problems: ['Example unsupported effort'], resolved: null, notes: ['Settings preview only.'] });
    await user.click(screen.getByRole('button', { name: 'Check saved authoring settings' }));
    expect(await screen.findByText('Example unsupported effort')).toBeInTheDocument();
    expect(screen.getByText(/Actual execution settings remain unverified/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Renderer'), 'browser');
    expect(screen.queryByText('Example unsupported effort')).not.toBeInTheDocument();
  });

  it('creates an opt-in project and navigates to its durable detail URL', async () => {
    const user = userEvent.setup();
    api.createCodeAnimationProject.mockResolvedValue(project);
    renderPage('/code-animation/production');
    await user.type(screen.getByLabelText('Title'), 'Example Production');
    await user.click(screen.getByRole('button', { name: 'Create Production project' }));
    expect(await screen.findByRole('button', { name: 'Save project settings' })).toBeInTheDocument();
    expect(api.getCodeAnimationProject).toHaveBeenCalledWith(project.id, expect.objectContaining({ silent: true }));
  });

  it('reports refused containment and checks only a saved operator tool path', async () => {
    const user = userEvent.setup();
    renderPage('/code-animation/production');
    expect(await screen.findByText('Blender: Not configured.')).toBeInTheDocument();
    const path = '/Applications/Example.app/Contents/MacOS/Blender';
    await user.type(screen.getByLabelText('Blender executable (operator-owned)'), path);
    expect(screen.getByRole('button', { name: 'Run containment check' })).toBeDisabled();
    const saved = execution({ tools: { blender: { executable: path, problem: null } }, lanes: { browser: { mechanism: 'chromium-cdp-sandbox' }, blender: { ready: false, reason: 'Run the containment check.' } } });
    api.updateCodeAnimationExecutionTools.mockResolvedValue(saved);
    await user.click(screen.getByRole('button', { name: 'Save tool' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run containment check' })).toBeEnabled());
    expect(api.updateCodeAnimationExecutionTools).toHaveBeenCalledWith({ blender: { executable: path } }, { silent: true });
    api.probeCodeAnimationExecution.mockResolvedValue({ ...saved,
      probe: { passed: true, refused: null, checks: [{ id: 'network', passed: true, detail: 'Outbound network was refused by the sandbox.' }],
        tools: { blender: { passed: false, detail: 'Blender did not start under containment (failed: exit).' } } },
      lanes: { ...saved.lanes, blender: { ready: false, reason: 'Blender did not start under containment.' } } });
    await user.click(screen.getByRole('button', { name: 'Run containment check' }));
    expect(await screen.findByText(/Containment proven: 1 of 1 checks/)).toBeInTheDocument();
    expect(screen.getByText('Blender did not start under containment.')).toBeInTheDocument();
  });
});
