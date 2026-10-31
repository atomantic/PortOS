import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getAppDocuments: vi.fn(),
  getGsdProject: vi.fn(),
  getGsdPhases: vi.fn(),
  addCosTask: vi.fn(),
  triggerGsdPhaseAction: vi.fn(),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));

vi.mock('../../../services/api', () => api);
vi.mock('../../ui/Toast', () => ({ default: toast }));
vi.mock('../../../hooks/useInstanceFeatures.js', () => ({
  useInstanceFeatures: () => ({ isFeatureEnabled: () => false }),
}));
vi.mock('../../gsd/GsdProjectHeader', () => ({
  default: ({ onRefresh }) => <button type="button" onClick={onRefresh}>Project header refresh</button>,
}));
vi.mock('../../gsd/PhaseCardList', () => ({ default: () => <div>Phase cards</div> }));
vi.mock('../../gsd/GsdDocumentsPanel', () => ({ default: () => null }));
vi.mock('../../cos/tabs/GsdConcernsPanel', () => ({ default: () => null }));

import GsdTab from './GsdTab';

const FULL_PROJECT = { gsd: { hasCodebaseMap: true, hasProject: true, hasRoadmap: true, hasState: true } };
const UNMAPPED = { gsd: { hasCodebaseMap: false, hasProject: false, hasRoadmap: false, hasState: false } };

const renderTab = () => render(
  <MemoryRouter>
    <GsdTab appId="app-1" repoPath="/repo/example" />
  </MemoryRouter>
);

describe('GsdTab read failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getAppDocuments.mockResolvedValue(FULL_PROJECT);
    api.getGsdProject.mockResolvedValue({ phases: [] });
    api.getGsdPhases.mockResolvedValue({ pendingActions: [] });
  });

  it('shows a failed status read as an error with Retry, not as an uninitialized project', async () => {
    api.getAppDocuments.mockRejectedValueOnce(new Error('Server unavailable'));
    renderTab();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the GSD project — Server unavailable');
    expect(screen.queryByText('GSD Project Setup')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Phase cards')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not fall back to the setup guide when the project read fails', async () => {
    api.getGsdProject.mockRejectedValueOnce(new Error('Parse failed'));
    renderTab();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the GSD project — Parse failed');
    expect(screen.queryByText('GSD Project Setup')).not.toBeInTheDocument();
  });

  it('keeps the loaded project on screen when a refresh fails', async () => {
    renderTab();
    await screen.findByText('Phase cards');
    api.getAppDocuments.mockRejectedValueOnce(new Error('Server unavailable'));

    fireEvent.click(screen.getByRole('button', { name: 'Project header refresh' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the GSD project');
    expect(screen.getByText('Phase cards')).toBeInTheDocument();
  });

  it('shows the setup guide for a repo that has no GSD project', async () => {
    api.getAppDocuments.mockResolvedValue(UNMAPPED);
    renderTab();

    expect(await screen.findByText('GSD Project Setup')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not report a setup task as created when the request fails', async () => {
    api.getAppDocuments.mockResolvedValue(UNMAPPED);
    api.addCosTask.mockRejectedValueOnce(new Error('Queue unavailable'));
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: 'Run' }));

    await waitFor(() => expect(api.addCosTask).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });
});
