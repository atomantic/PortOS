import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const renderMusicVideoSequence = vi.fn(async () => ({ jobId: 'job-1' }));
vi.mock('../../services/apiMusicVideo.js', () => ({ renderMusicVideoSequence }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const { default: SceneSequenceCoverage } = await import('./SceneSequenceCoverage.jsx');

const shot = (sceneId, startSec, endSec, extra = {}) => ({
  sceneId, label: `Shot ${sceneId}`, sectionIndex: 0, coverage: 'sequence', startSec, endSec, shotMode: 'cutaway', visualLayer: 'footage',
  set: { id: 'attic' }, protagonist: 'mara', prompt: `shot ${sceneId}`, referenceImageId: `${sceneId}.png`, ...extra,
});
const project = (scenes) => ({ id: 'p1', videoSettings: { backend: 'fal', falModelId: 'minimax/h3-max/reference-to-video' }, scenes });

describe('SceneSequenceCoverage', () => {
  // Uniquely catches a card that hides the timed prompt or the disabled-expansion
  // value, or renders the run from a shot other than its first.
  it('shows the run\'s exact prompt with prompt expansion disabled and queues it from the first shot', async () => {
    const p = project([shot('a', 0, 4), shot('b', 4, 8), shot('c', 8, 12), shot('perf', 12, 18, { shotMode: 'performance' })]);
    render(<SceneSequenceCoverage project={p} scene={p.scenes[0]} />);
    expect(screen.getByText(/shot 1 of 3 in one 12s request/)).toBeTruthy();
    expect(screen.getByText(/0-4s: Image 1\. shot a/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Prompt expansion/ }));
    expect(screen.getByText(/Prompt expansion: disabled/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Render sequence/ })); });
    expect(renderMusicVideoSequence).toHaveBeenCalledWith('p1', ['a', 'b', 'c'], { silent: true });
  });

  it('offers no render on a later shot and says why a shot stays per-shot', () => {
    const p = project([shot('a', 0, 4), shot('b', 4, 8), shot('perf', 8, 14, { shotMode: 'performance' })]);
    const { rerender } = render(<SceneSequenceCoverage project={p} scene={p.scenes[1]} />);
    expect(screen.queryByRole('button', { name: /Render sequence/ })).toBeNull();
    rerender(<SceneSequenceCoverage project={p} scene={p.scenes[2]} />);
    expect(screen.getByText(/renders on its own \(performance shots/)).toBeTruthy();
  });
});
