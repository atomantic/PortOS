import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ProjectOptionsPanel from './ProjectOptionsPanel.jsx';

vi.mock('./VideoRenderSettings.jsx', () => ({ default: () => null }));
vi.mock('../imageGen/RecordRenderPinRow.jsx', () => ({ default: () => null }));
vi.mock('../../services/apiMusicVideo.js', () => ({ setMusicVideoFinishedOutside: vi.fn() }));
import { setMusicVideoFinishedOutside } from '../../services/apiMusicVideo.js';

const open = (project = {}, onSavePolicy = vi.fn(async () => {}), onProjectUpdated = vi.fn()) => {
  render(<ProjectOptionsPanel project={{ id: 'mv1', ...project }} videoSettings={{ changeFramePin: vi.fn() }}
    onMediaMode={vi.fn()} onRenderStyle={vi.fn()} onSaveAutomation={vi.fn()} onSavePolicy={onSavePolicy} onProjectUpdated={onProjectUpdated} />);
  return onSavePolicy;
};

describe('ProjectOptionsPanel', () => {
  it('states what the chosen render style means, including that footage mode drops typography', () => {
    open({ composition: { mode: 'concat' } });
    expect(screen.getByText(/Typography cues do not render/)).toBeInTheDocument();
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
    open({}, undefined, onProjectUpdated);
    fireEvent.change(screen.getByLabelText('Where it was made (optional)'), { target: { value: ' Studio ' } });
    fireEvent.click(screen.getByLabelText('Mark finished'));
    await waitFor(() => expect(onProjectUpdated).toHaveBeenCalledWith(saved));
    expect(setMusicVideoFinishedOutside).toHaveBeenCalledWith('mv1', { finished: true, note: 'Studio' });
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
