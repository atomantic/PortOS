import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import socket from '../../../services/socket';
import CleanupStage from './CleanupStage.jsx';
import { cleanupMusicVideoRenders, getMusicVideoRenderCleanup } from '../../../services/apiMusicVideo.js';

vi.mock('../../../services/apiMusicVideo.js', () => ({ getMusicVideoRenderCleanup: vi.fn(), cleanupMusicVideoRenders: vi.fn() }));
vi.mock('../../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
const inventory = () => ({ finals: [
  { id: 'old', bytes: 1000, reason: null }, { id: 'held', bytes: 4000, reason: 'Referenced by saved media or production records' },
], segments: { stale: [{ name: 'old-shot.mp4', bytes: 2000 }], unusedLooks: [{ name: 'old-look.mp4', bytes: 3000 }] } });
beforeEach(() => {
  vi.clearAllMocks();
  getMusicVideoRenderCleanup.mockResolvedValue(inventory());
  cleanupMusicVideoRenders.mockResolvedValue({ finals: [inventory().finals[1]], segments: { stale: [], unusedLooks: inventory().segments.unusedLooks } });
});

describe('production cleanup', () => {
  it('removes derived renders while keeping comparisons by default, then offers explicit look purging', async () => {
    render(<CleanupStage board={{ project: { id: 'example-project' } }} />);
    const cleanup = await screen.findByRole('button', { name: 'Remove superseded renders' });
    const onShot = socket.on.mock.calls.find(([event]) => event === 'music-video:shot-render')[1];
    await act(async () => { onShot({ projectId: 'example-project', state: 'rendering', progress: 0.5 }); });
    expect(getMusicVideoRenderCleanup).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Source takes, stills, and cutting-room content stay in Assets/)).toBeInTheDocument();
    expect(screen.getByText(/Kept: Referenced/)).toBeInTheDocument();
    fireEvent.click(cleanup);
    await waitFor(() => expect(cleanupMusicVideoRenders).toHaveBeenCalledWith('example-project', { unusedLooks: false }, { silent: true }));
    await waitFor(() => expect(cleanup).toBeDisabled());
    await waitFor(() => expect(screen.queryByText('Superseded — safe to remove')).not.toBeInTheDocument());
    expect(screen.getByRole('list', { name: 'Older final renders' })).toBeInTheDocument();
    const purge = screen.getByRole('button', { name: 'Remove superseded renders and unused looks' });
    expect(purge).toBeEnabled();
    fireEvent.click(purge);
    await waitFor(() => expect(cleanupMusicVideoRenders).toHaveBeenLastCalledWith('example-project', { unusedLooks: true }, { silent: true }));
  });

  it('shows a cleanup refusal without clearing the inventory', async () => {
    cleanupMusicVideoRenders.mockRejectedValue(new Error('Wait for shot renders to finish'));
    render(<CleanupStage board={{ project: { id: 'example-project' } }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove superseded renders' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wait for shot renders to finish');
    expect(screen.getByText('Superseded — safe to remove')).toBeInTheDocument();
  });

  it('keeps mutation failures visible when cleanup socket events refresh the inventory', async () => {
    let rejectCleanup;
    cleanupMusicVideoRenders.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectCleanup = reject; }));
    render(<CleanupStage board={{ project: { id: 'example-project' } }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove superseded renders' }));
    const onCleanup = socket.on.mock.calls.find(([event]) => event === 'music-video:render-cleanup')[1];
    await act(async () => { onCleanup({ projectId: 'example-project' }); });
    await act(async () => { rejectCleanup(new Error('Segment removal failed')); });
    expect(screen.getByRole('alert')).toHaveTextContent('Segment removal failed');
    await act(async () => { onCleanup({ projectId: 'example-project' }); });
    expect(screen.getByRole('alert')).toHaveTextContent('Segment removal failed');
  });

  it('drops a cleanup failure after switching to another project', async () => {
    let rejectCleanup;
    cleanupMusicVideoRenders.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectCleanup = reject; }));
    const { rerender } = render(<CleanupStage board={{ project: { id: 'old-project' } }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove superseded renders' }));
    rerender(<CleanupStage board={{ project: { id: 'new-project' } }} />);
    await screen.findByText('Superseded — safe to remove');
    await act(async () => { rejectCleanup(new Error('Old project failure')); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('drops a previous project inventory response after switching projects', async () => {
    let resolveOld;
    getMusicVideoRenderCleanup.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
    const { rerender } = render(<CleanupStage board={{ project: { id: 'old-project' } }} />);
    rerender(<CleanupStage board={{ project: { id: 'new-project' } }} />);
    await screen.findByText('Superseded — safe to remove');
    resolveOld({ finals: [{ id: 'wrong', bytes: 100, reason: 'Old project' }], segments: { stale: [], unusedLooks: [] } });
    await waitFor(() => expect(screen.queryByText('Kept: Old project')).not.toBeInTheDocument());
  });
});
