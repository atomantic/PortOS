import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AudioTimingPanel from './AudioTimingPanel.jsx';
import { previewMusicVideoAudioTiming, applyMusicVideoAudioTiming } from '../../services/apiMusicVideo.js';
vi.mock('../../services/apiMusicVideo.js', () => ({ previewMusicVideoAudioTiming: vi.fn(), applyMusicVideoAudioTiming: vi.fn() }));
const project = { id: 'example', audioAnalysis: { durationSec: 10 } };
const preview = { basis: 'basis', canApply: true, intervals: [{ oldStartSec: 0, oldEndSec: 4, newStartSec: 0, newEndSec: 4, status: 'unchanged' }], gaps: [{ newStartSec: 4, newEndSec: 8, status: 'inserted' }],
  affectedShots: [{ sceneId: 'shot', label: 'Chorus', status: 'moved', oldStartSec: 6, oldEndSec: 8, newStartSec: 10, newEndSec: 12, takeIds: ['take'], repairRequired: true }],
  blockers: [], estimate: { minGenerations: 0, maxGenerations: 1, maxSeconds: 2 } };
beforeEach(() => { vi.clearAllMocks(); previewMusicVideoAudioTiming.mockResolvedValue(preview); });
async function open(onApplied = vi.fn()) {
  render(<AudioTimingPanel project={project} tracks={[{ id: 'edited', title: 'Edited song', audioFilename: 'edited.wav' }]} onApplied={onApplied} />);
  fireEvent.click(screen.getByText('Preview audio timing revision'));
  fireEvent.change(screen.getByLabelText('Edited track'), { target: { value: 'edited' } });
  fireEvent.click(screen.getByText('Preview mapping'));
  await screen.findByLabelText('Timing map preview');
}
describe('audio timing timeline preview', () => {
  it('renders intervals, affected take and bounded repair estimate, then cancels without applying', async () => {
    await open();
    expect(screen.getByText(/inserted:.*4.00s.*8.00s/)).toBeTruthy();
    expect(screen.getByText(/Chorus: moved.*6.00s.*10.00s/)).toBeTruthy();
    expect(screen.getByText(/1 historical takes retained.*performance repair required/)).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel timing revision'));
    expect(screen.queryByLabelText('Timing map preview')).toBeNull();
    expect(applyMusicVideoAudioTiming).not.toHaveBeenCalled();
  });
  it('applies the reviewed basis and immediately updates the board, invalidating a preview on input changes', async () => {
    const onApplied = vi.fn();
    applyMusicVideoAudioTiming.mockResolvedValue({ project: { ...project, trackId: 'edited' } });
    await open(onApplied);
    fireEvent.change(screen.getByLabelText('Old end 1'), { target: { value: '8' } });
    expect(screen.queryByText('Apply timing revision')).toBeNull();
    fireEvent.click(screen.getByText('Preview mapping'));
    fireEvent.click(await screen.findByText('Apply timing revision'));
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith({ ...project, trackId: 'edited' }));
    expect(applyMusicVideoAudioTiming).toHaveBeenCalledWith('example', { targetTrackId: 'edited', intervals: [{ oldStartSec: 0, oldEndSec: 8, newStartSec: 0 }], basis: 'basis' }, { silent: true });
  });
  it('shows ambiguous window refusals with Apply disabled', async () => {
    previewMusicVideoAudioTiming.mockResolvedValue({ ...preview, canApply: false, blockers: ['Split the shot crossing this edit.'] });
    await open();
    expect(screen.getByRole('alert').textContent).toContain('Split the shot');
    expect(screen.getByText('Apply timing revision').disabled).toBe(true);
  });
});
