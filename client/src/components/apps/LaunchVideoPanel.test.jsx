import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import LaunchVideoPanel from './LaunchVideoPanel';
import { createAppLaunchVideo } from '../../services/apiApps';
vi.mock('../../services/apiApps', () => ({ getAppLaunchVideos: vi.fn(async () => ({ videos: [] })), createAppLaunchVideo: vi.fn() }));
vi.mock('../../services/apiPipeline', () => ({ listPipelineMusicLibrary: async () => ({ tracks: [{ filename: 'example.wav', label: 'Example track' }] }) }));
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../../lib/clipboard', () => ({ copyToClipboard: vi.fn() }));

describe('launch video drawer', () => {
  it('submits options once and leaves the run active on close', async () => {
    let finish;
    createAppLaunchVideo.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<MemoryRouter><LaunchVideoPanel app={{ id: 'example' }} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Make launch video' }));
    fireEvent.change(screen.getByLabelText('Tone'), { target: { value: 'cinematic' } });
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'vertical' } });
    fireEvent.change(screen.getByLabelText('Duration (15–25 seconds)'), { target: { value: '22' } });
    fireEvent.click(screen.getByLabelText('Include music'));
    await screen.findByRole('option', { name: 'Example track' });
    fireEvent.change(screen.getByLabelText('Music-library track'), { target: { value: 'example.wav' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue launch video' }));
    expect(screen.getByRole('button', { name: 'Queuing…' }).disabled).toBe(true);
    expect(createAppLaunchVideo).toHaveBeenCalledTimes(1);
    expect(createAppLaunchVideo).toHaveBeenCalledWith('example', { tone: 'cinematic', direction: '', format: 'vertical', targetDurationSec: 22, musicTrack: 'example.wav' }, { silent: true });
    finish({ taskId: 'task-example' });
    await waitFor(() => expect(screen.getByText('Launch video queued. Closing this drawer leaves the run active.')).toBeTruthy());
    expect(screen.getByRole('link', { name: /Open CoS agents/ }).getAttribute('href')).toBe('/cos/agents');
    fireEvent.click(screen.getByRole('button', { name: /Close/ }));
    expect(screen.queryByText('Launch video queued. Closing this drawer leaves the run active.')).toBeNull();
    expect(createAppLaunchVideo).toHaveBeenCalledTimes(1);
  });
});
