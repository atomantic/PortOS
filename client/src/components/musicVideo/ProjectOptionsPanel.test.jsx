import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ProjectOptionsPanel from './ProjectOptionsPanel.jsx';

vi.mock('./VideoRenderSettings.jsx', () => ({ default: () => null }));
vi.mock('../imageGen/RecordRenderPinRow.jsx', () => ({ default: () => null }));
vi.mock('./PlateReviewerSetting.jsx', () => ({ default: () => null }));
vi.mock('../../services/apiMusicVideo.js', () => ({ setMusicVideoFinishedOutside: vi.fn(), setMusicVideoCompletion: vi.fn() }));
import { setMusicVideoCompletion, setMusicVideoFinishedOutside } from '../../services/apiMusicVideo.js';

const open = (project = {}, onSavePolicy = vi.fn(async () => {}), onProjectUpdated = vi.fn()) => {
  render(<ProjectOptionsPanel project={{ id: 'mv1', ...project }} videoSettings={{ changeFramePin: vi.fn() }}
    onMediaMode={vi.fn()} onRenderStyle={vi.fn()} onSaveAutomation={vi.fn()} onSavePolicy={onSavePolicy} onProjectUpdated={onProjectUpdated} />);
  return onSavePolicy;
};

describe('ProjectOptionsPanel', () => {
  it('marks a project complete over a stale final and shows what Automatic would say', async () => {
    const saved = { id: 'mv1', renderHistoryId: 'r1', completion: { state: 'complete', markedAt: '2026-01-02T00:00:00.000Z' } };
    setMusicVideoCompletion.mockResolvedValueOnce(saved);
    const onProjectUpdated = vi.fn();
    open({ status: 'complete', renderHistoryId: 'r1', renderDependencyState: { status: 'stale', reasons: ['x'] } }, undefined, onProjectUpdated);
    const select = screen.getByLabelText('Status');
    expect(select).toHaveValue('auto');
    expect(screen.getByRole('option', { name: 'Automatic (in progress)' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'complete' } });
    expect(setMusicVideoCompletion).toHaveBeenCalledWith('mv1', 'complete');
    await waitFor(() => expect(onProjectUpdated).toHaveBeenCalledWith(saved));
  });

  it('will not mark a project without a final render complete', () => {
    setMusicVideoCompletion.mockClear();
    open({ status: 'draft' });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'complete' } });
    expect(setMusicVideoCompletion).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Render the final video first');
  });

  it('shows a stored mark and returns to Automatic', async () => {
    setMusicVideoCompletion.mockClear();
    setMusicVideoCompletion.mockResolvedValueOnce({ id: 'mv1' });
    const onProjectUpdated = vi.fn();
    open({ status: 'complete', renderHistoryId: 'r1', completion: { state: 'in-progress', markedAt: '2026-01-02T00:00:00.000Z' } }, undefined, onProjectUpdated);
    const select = screen.getByLabelText('Status');
    expect(select).toHaveValue('in-progress');
    expect(screen.getByRole('option', { name: 'Automatic (complete)' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'auto' } });
    expect(setMusicVideoCompletion).toHaveBeenCalledWith('mv1', 'auto');
    await waitFor(() => expect(onProjectUpdated).toHaveBeenCalledWith({ id: 'mv1' }));
  });

  it('states what the chosen render style means, including that footage mode drops typography', () => {
    open({ composition: { mode: 'concat' } });
    expect(screen.getByText(/Typography cues do not render/)).toBeInTheDocument();
  });

  it('warns which preview sources a render-style change adds or drops', () => {
    const onRenderStyle = vi.fn();
    const project = {
      id: 'mv1', trackId: 't1', scenes: [{ sceneId: 's1', startSec: 0, endSec: 4 }],
      composition: { mode: 'document', document: { directory: 'd' } },
    };
    render(<ProjectOptionsPanel project={project} videoSettings={{ changeFramePin: vi.fn() }}
      onMediaMode={vi.fn()} onRenderStyle={onRenderStyle} onSaveAutomation={vi.fn()} onSavePolicy={vi.fn()} />);
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.change(screen.getByLabelText('Render style'), { target: { value: 'composed' } });
    expect(onRenderStyle).toHaveBeenCalledWith('composed');
    expect(screen.getByRole('status')).toHaveTextContent('Preview drops Composition (live) from the composition document and adds Composition (live) from the selected takes.');
    fireEvent.change(screen.getByLabelText('Render style'), { target: { value: 'concat' } });
    expect(screen.getByRole('status')).toHaveTextContent('Preview drops Composition (live) from the composition document.');
  });

  it('saves the production strategy and generated-video allowance in place', async () => {
    const onSavePolicy = open();
    expect(screen.queryByLabelText(/Maximum generated video/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Production strategy'), { target: { value: 'code-first' } });
    await waitFor(() => expect(onSavePolicy).toHaveBeenCalledWith(expect.objectContaining({ strategy: 'code-first' })));
  });

  it('commits a valid allowance on blur and rejects an out-of-range one', async () => {
    const onSavePolicy = open({ productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 } });
    const allowance = screen.getByLabelText('Maximum generated video (% of final song time)');
    fireEvent.change(allowance, { target: { value: '12.5' } });
    fireEvent.blur(allowance);
    await waitFor(() => expect(onSavePolicy).toHaveBeenCalledWith({ strategy: 'code-first', maxGeneratedVideoPercent: 12.5 }));
    fireEvent.change(allowance, { target: { value: '150' } });
    fireEvent.blur(allowance);
    expect(await screen.findByRole('alert')).toHaveTextContent('0 to 100%');
    expect(onSavePolicy).toHaveBeenCalledTimes(1);
  });

  it('marks a project finished outside PortOS with a note, hands back the saved record, and unmarks it', async () => {
    const saved = { id: 'mv1', finishedOutside: { markedAt: '2026-10-05T00:00:00.000Z', note: 'Studio' } };
    setMusicVideoFinishedOutside.mockResolvedValueOnce(saved);
    const onProjectUpdated = vi.fn();
    open({ renderHistoryId: 'final-1' }, undefined, onProjectUpdated);
    fireEvent.change(screen.getByLabelText('Where it was made (optional)'), { target: { value: ' Studio ' } });
    fireEvent.click(screen.getByLabelText('Mark finished'));
    await waitFor(() => expect(onProjectUpdated).toHaveBeenCalledWith(saved));
    expect(setMusicVideoFinishedOutside).toHaveBeenCalledWith('mv1', { finished: true, note: 'Studio' });
  });

  it('explains that marking needs the final render first', () => {
    open({ renderHistoryId: null });
    expect(screen.queryByLabelText('Mark finished')).toBeNull();
    expect(screen.getByText(/Bring the finished video in as the final render first/)).toBeInTheDocument();
  });

  it('shows an existing marker and clears it', async () => {
    setMusicVideoFinishedOutside.mockResolvedValueOnce({ id: 'mv1', finishedOutside: null });
    open({ finishedOutside: { markedAt: '2026-10-05T12:00:00.000Z', note: 'Studio' } });
    expect(screen.getByText(/: Studio\. No approval is recorded/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Where it was made (optional)')).toBeNull();
    fireEvent.click(screen.getByLabelText('Marked finished'));
    await waitFor(() => expect(setMusicVideoFinishedOutside).toHaveBeenLastCalledWith('mv1', { finished: false, note: undefined }));
  });
});
