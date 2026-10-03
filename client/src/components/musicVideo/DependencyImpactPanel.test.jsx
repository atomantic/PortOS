import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DependencyImpactPanel from './DependencyImpactPanel.jsx';
import { getMusicVideoDependencyImpact } from '../../services/apiMusicVideo.js';
vi.mock('../../services/apiMusicVideo.js', () => ({ getMusicVideoDependencyImpact: vi.fn() }));
const project = { id: 'example-project', scenes: [{ sceneId: 'a', label: 'Example shot' }], revisions: [] };
const impact = { basis: 'example-basis', shots: [{ sceneId: 'a', reasons: ['Selected plate changed'] }], evidence: [{ id: 'old-review' }], estimate: { maxGenerations: 1, outputSeconds: 5, evidenceRebuilds: 1 } };
beforeEach(() => vi.clearAllMocks());
describe('rendered stale impact', () => {
  it('shows cause, downstream impact and a bounded estimate before the explicit repair action', async () => {
    getMusicVideoDependencyImpact.mockResolvedValue(impact);
    const repair = vi.fn();
    render(<DependencyImpactPanel project={project} onRepair={repair} />);
    await screen.findByRole('region', { name: 'Stale asset impact' });
    expect(screen.getByText(/Example shot: Selected plate changed/)).toBeInTheDocument();
    expect(screen.getByText(/Up to 1 clip submissions.*5 seconds.*1 evidence/)).toBeInTheDocument();
    expect(repair).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Repair affected dependencies' }));
    expect(repair).toHaveBeenCalledWith('example-basis');
  });
  it('says no clips are needed when only review evidence is stale', async () => {
    getMusicVideoDependencyImpact.mockResolvedValue({ ...impact, shots: [], estimate: { maxGenerations: 0, outputSeconds: 0, evidenceRebuilds: 2 } });
    render(<DependencyImpactPanel project={project} onRepair={vi.fn()} />);
    expect(await screen.findByText(/No new clips needed; 2 evidence records/)).toBeInTheDocument();
    expect(screen.queryByText(/Up to 0 clip/)).not.toBeInTheDocument();
  });
  it('drops an older project response and keeps an active repair disabled', async () => {
    let resolveOld;
    getMusicVideoDependencyImpact.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValueOnce(impact);
    const { rerender } = render(<DependencyImpactPanel project={project} onRepair={vi.fn()} />);
    rerender(<DependencyImpactPanel project={{ ...project, id: 'new-project', revisions: [{ status: 'open' }] }} onRepair={vi.fn()} />);
    await screen.findByRole('region', { name: 'Stale asset impact' });
    resolveOld({ shots: [], evidence: [] });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Repair affected dependencies' })).toBeDisabled());
  });
});
