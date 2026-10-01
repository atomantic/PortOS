import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } }));
vi.mock('../../services/apiCodeAnimation', () => ({
  listCodeAnimationProjects: vi.fn(), createCodeAnimationProject: vi.fn(), getCodeAnimationProject: vi.fn(),
  updateCodeAnimationProject: vi.fn(), importCodeAnimationPackage: vi.fn(), acceptCodeAnimationSource: vi.fn(),
  getCodeAnimationProjectBrief: vi.fn(), getCodeAnimationRevisionPackage: vi.fn(), listCodeAnimationProjectHistory: vi.fn(),
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
  localSettings: { model: 'example-model', mode: 'cli' },
  acceptedRevisionId: null, candidateRevisionId: '00000000-0000-4000-8000-000000000002',
};
const page = (items = []) => ({ items, nextCursor: null });
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
});

describe('Production project rendered interactions', () => {
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

  it('creates an opt-in project and navigates to its durable detail URL', async () => {
    const user = userEvent.setup();
    api.createCodeAnimationProject.mockResolvedValue(project);
    renderPage('/code-animation/production');
    await user.type(screen.getByLabelText('Title'), 'Example Production');
    await user.click(screen.getByRole('button', { name: 'Create Production project' }));
    expect(await screen.findByRole('button', { name: 'Save project settings' })).toBeInTheDocument();
    expect(api.getCodeAnimationProject).toHaveBeenCalledWith(project.id, expect.objectContaining({ silent: true }));
  });
});
