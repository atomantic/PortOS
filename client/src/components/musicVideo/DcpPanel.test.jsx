import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import DcpPanel from './DcpPanel.jsx';
import { inspectMusicVideoDcp } from '../../services/apiMusicVideo.js';

vi.mock('../../services/apiMusicVideo.js', () => ({
  inspectMusicVideoDcp: vi.fn(), getMusicVideoDcpLocation: vi.fn(), musicVideoDcpReportUrl: () => '/report',
}));

describe('cinema package panel', () => {
  it('requires an explicit grade and binds the inspected render and source hash to the request', async () => {
    const build = vi.fn();
    inspectMusicVideoDcp.mockResolvedValue({ renderHistoryId: 'render-1', sourceSha256: 'a'.repeat(64), problems: [], tools: { create: true, encoder: true, verifier: true, ffprobe: true }, source: { width: 1280, height: 720, frameRate: '24/1', audioChannels: 2, audioLayout: 'stereo', colorPrimaries: 'bt709', colorTransfer: 'bt709', colorSpace: 'bt709', colorRange: 'tv' } });
    const project = { id: 'project-1', renderHistoryId: 'render-1', dcpExports: [{ id: 'dcp-abc', sourceRenderId: 'old', status: 'verification-failed', source: { width: 640, height: 360 }, container: { width: 1998, height: 1080 }, standard: 'SMPTE', grade: 'rec709' }] };
    const { rerender } = render(<DcpPanel project={project} dcp={{ active: false, build }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect final render and tools' }));
    const create = await screen.findByRole('button', { name: 'Create cinema package' });
    expect(create.disabled).toBe(true);
    expect(screen.getByText(/1,280 × 720 pixels/)).toBeTruthy();
    expect(screen.getByText(/Verification failed · Older render/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Source grading conversion'), { target: { value: 'rec1886' } });
    fireEvent.click(create);
    expect(build).toHaveBeenCalledWith({ grade: 'rec1886', renderHistoryId: 'render-1', sourceSha256: 'a'.repeat(64) });
    rerender(<DcpPanel project={{ ...project, renderHistoryId: 'render-2' }} dcp={{ active: false, build }} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Create cinema package' })).toBeNull());
  });
});
