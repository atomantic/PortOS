/**
 * Vocal stem control (#8977): choosing a file uploads it and applies the
 * project the server returns, a refused stem leaves the project as it was and
 * says why, and removal applies the cleared project.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../services/apiMusicVideo.js', () => ({
  uploadMusicVideoVocalStem: vi.fn(),
  removeMusicVideoVocalStem: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import * as api from '../../services/apiMusicVideo.js';
import toast from '../ui/Toast';
import VocalStemControl from './VocalStemControl.jsx';

const project = { id: 'mv-1', uploadedAudioFilename: 'song.wav' };
const file = () => new File(['x'], 'vocals.wav', { type: 'audio/wav' });

beforeEach(() => vi.clearAllMocks());

describe('VocalStemControl', () => {
  it('uploads a chosen stem, and on refusal keeps the project and shows the reason', async () => {
    const onUpdated = vi.fn();
    api.uploadMusicVideoVocalStem.mockResolvedValueOnce({ ...project, vocalStemFilename: 'vocals-1.wav' });
    render(<VocalStemControl project={project} hasAudio onUpdated={onUpdated} />);
    expect(screen.getByText('Lip-sync uses the full mix')).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Add vocal stem/), { target: { files: [file()] } });
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith({ ...project, vocalStemFilename: 'vocals-1.wav' }));
    expect(api.uploadMusicVideoVocalStem).toHaveBeenCalledWith('mv-1', expect.any(File), { silent: true });

    api.uploadMusicVideoVocalStem.mockRejectedValueOnce(new Error('The vocal stem is 5.000s but the song is 6.000s.'));
    fireEvent.change(screen.getByLabelText(/Add vocal stem/), { target: { files: [file()] } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The vocal stem is 5.000s but the song is 6.000s.'));
    expect(onUpdated).toHaveBeenCalledTimes(1);
  });

  it('removes an attached stem', async () => {
    const onUpdated = vi.fn();
    api.removeMusicVideoVocalStem.mockResolvedValueOnce({ ...project, vocalStemFilename: null });
    render(<VocalStemControl project={{ ...project, vocalStemFilename: 'vocals-1.wav' }} hasAudio onUpdated={onUpdated} />);
    expect(screen.getByText('Lip-sync uses vocals-1.wav')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove vocal stem' }));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith({ ...project, vocalStemFilename: null }));
  });

  it('is unavailable until the project has a song to match a stem against', () => {
    render(<VocalStemControl project={{ id: 'mv-2' }} hasAudio={false} onUpdated={vi.fn()} />);
    expect(screen.getByLabelText(/Add vocal stem/).disabled).toBe(true);
  });
});
