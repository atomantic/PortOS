import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import CreateProjectDrawer from './CreateProjectDrawer.jsx';
import TrackPanel from './TrackPanel.jsx';
import AudioTimingPanel from './AudioTimingPanel.jsx';
import SoundBedControl from './SoundBedControl.jsx';
import * as api from '../../services/apiMusicVideo.js';

vi.mock('../../services/apiMusicVideo.js', () => ({
  previewMusicVideoAudioTiming: vi.fn(),
  applyMusicVideoAudioTiming: vi.fn(),
  updateMusicVideoProject: vi.fn(),
}));
vi.mock('../moodBoard/MoodBoardReferenceStrip.jsx', () => ({ default: () => null }));
vi.mock('./VocalStemControl.jsx', () => ({ default: () => null }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const common = { title: 'Example Song', artist: 'Example Artist', durationSec: 75, createdAt: '2026-01-02T12:00:00Z' };
const tracks = [
  { ...common, id: 'example-a-123456', audioFilename: 'example-a.wav', lyrics: 'One line', renders: [{ audioFilename: 'example-a.wav', source: 'suno' }] },
  { ...common, id: 'example-b-123456', audioFilename: 'example-b.wav', lyrics: 'First line\nSecond line', renders: [{ audioFilename: 'example-b.wav', source: 'youtube' }] },
  { ...common, id: 'example-long', durationSec: 90, createdAt: '2025-01-02T12:00:00Z', audioFilename: 'example-long.wav' },
  { id: 'example-missing', title: '  ', durationSec: null, createdAt: 'invalid' },
];
const project = { id: 'example-project', trackId: tracks[0].id, audioAnalysis: { durationSec: 75 } };
const youtube = {
  createJob: { active: false }, editJob: { active: false }, createUrl: '', editUrl: '',
  setCreateUrl: vi.fn(), setEditUrl: vi.fn(), startCreate: vi.fn(), startEdit: vi.fn(),
};
const trackName = (id) => tracks.find((track) => track.id === id)?.title || id;

beforeEach(() => vi.clearAllMocks());

// Uniquely catches inaccessible duplicate choices, wrong-record selection,
// and eligibility drift at the rendered selectors rather than helper internals.
describe('Music Video track choices', () => {
  it('distinguishes colliding records and shows metadata for the chosen ID without submitting or importing', () => {
    const onSubmit = vi.fn();
    function NewProject() {
      const [form, setForm] = useState({ mode: 'director', mediaMode: 'code-images-video', name: '', trackId: '', universeId: '' });
      return <CreateProjectDrawer open form={form} onFormChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
        tracks={tracks} universes={[]} trackName={trackName} youtube={youtube} onSubmit={onSubmit} onClose={vi.fn()} />;
    }
    render(<NewProject />);
    const select = screen.getByRole('combobox', { name: /Track \(music audio source\)/ });
    const first = within(select).getByRole('option', { name: /Example Song · Example Artist · 1:15 · Created .*2026 \[a-123456\]/ });
    const second = within(select).getByRole('option', { name: /Example Song · Example Artist · 1:15 · Created .*2026 \[b-123456\]/ });
    expect(first.value).toBe(tracks[0].id);
    expect(second.value).toBe(tracks[1].id);
    expect(within(select).getByRole('option', { name: /1:30 · Created .*2025$/ })).toHaveValue('example-long');
    expect(within(select).getByRole('option', { name: 'Untitled track · Duration unknown · Created unknown · No audio' })).toHaveValue('example-missing');
    select.focus();
    fireEvent.change(select, { target: { value: second.value } });
    expect(select).toHaveFocus();
    expect(select).toHaveValue(tracks[1].id);
    expect(screen.getByText('YouTube')).toBeInTheDocument();
    expect(screen.getByText('2 lyric lines loaded')).toBeInTheDocument();
    expect(screen.queryByText('Suno')).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(youtube.startCreate).not.toHaveBeenCalled();
  });

  it('uses the same stable labels after reordering and relinks the exact ID while preserving render locks', () => {
    const onChangeTrack = vi.fn();
    const props = { project, tracks, trackName, youtube, onChangeTrack, onProjectUpdated: vi.fn() };
    const { rerender } = render(<TrackPanel {...props} />);
    const select = screen.getByRole('combobox', { name: 'Change track' });
    const labels = Array.from(select.options, (option) => [option.value, option.textContent]);
    expect(within(select).getByRole('option', { name: /\[b-123456\]$/ })).toHaveValue(tracks[1].id);
    expect(within(select).getByRole('option', { name: /No audio$/ })).toHaveValue('example-missing');
    fireEvent.change(select, { target: { value: tracks[1].id } });
    fireEvent.click(screen.getByRole('button', { name: 'Change track' }));
    expect(onChangeTrack).toHaveBeenCalledWith(tracks[1].id, { cleared: ['beat/tempo analysis'] });
    expect(api.updateMusicVideoProject).not.toHaveBeenCalled();
    expect(youtube.startEdit).not.toHaveBeenCalled();
    rerender(<TrackPanel {...props} tracks={[...tracks].reverse()} renderBound />);
    expect(select).toBeDisabled();
    for (const [id, label] of labels) expect(Array.from(select.options).find((option) => option.value === id)?.textContent).toBe(label);
  });

  // Uniquely catches a track pick silently wiping analysis/alignment/MIDI/stem.
  it('confirms before a track change that would clear timed data, and lets the user fork or cancel', () => {
    const onChangeTrack = vi.fn();
    const rich = { ...project, midiTranscription: { filename: 'x.mid' }, vocalStemFilename: 's.wav',
      lyricCues: [{ text: 'a', startSec: 1, endSec: 2 }] };
    const props = { project: rich, tracks, trackName, youtube, onChangeTrack, onProjectUpdated: vi.fn() };
    const { rerender } = render(<TrackPanel {...props} />);
    const select = screen.getByRole('combobox', { name: 'Change track' });
    fireEvent.change(select, { target: { value: tracks[1].id } });
    expect(onChangeTrack).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    for (const t of ['beat/tempo analysis', 'lyric and phrase timing', 'MIDI transcription', 'vocal stem']) {
      expect(dialog.textContent).toContain(t);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onChangeTrack).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: tracks[1].id } });
    fireEvent.click(screen.getByRole('button', { name: /Fork & change track/ }));
    expect(onChangeTrack).toHaveBeenCalledWith(tracks[1].id, expect.objectContaining({ fork: true }));
    rerender(<TrackPanel {...props} project={{ id: 'p', trackId: tracks[0].id }} />);
    fireEvent.change(select, { target: { value: tracks[1].id } });
    expect(onChangeTrack).toHaveBeenLastCalledWith(tracks[1].id, { cleared: [] });
  });

  it('keeps timing revisions audio-only, excludes the current track, and waits for explicit preview', () => {
    render(<AudioTimingPanel project={project} tracks={tracks} onApplied={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview audio timing revision' }));
    const select = screen.getByRole('combobox', { name: 'Edited track' });
    expect(Array.from(select.options, (option) => option.value)).toEqual(['', tracks[1].id, 'example-long']);
    const second = within(select).getByRole('option', { name: /\[b-123456\]$/ });
    fireEvent.change(select, { target: { value: second.value } });
    expect(select).toHaveValue(tracks[1].id);
    expect(api.previewMusicVideoAudioTiming).not.toHaveBeenCalled();
    expect(api.applyMusicVideoAudioTiming).not.toHaveBeenCalled();
  });

  it('keeps sound-bed eligibility and saves the intended duplicate ID without media processing', async () => {
    const onUpdated = vi.fn();
    const updated = { ...project, soundBed: { trackId: tracks[1].id, volume: 0.3 } };
    api.updateMusicVideoProject.mockResolvedValue(updated);
    render(<SoundBedControl project={project} tracks={tracks} onUpdated={onUpdated} />);
    const select = screen.getByRole('combobox', { name: 'Sound-design bed' });
    expect(Array.from(select.options, (option) => option.value)).toEqual(['', tracks[1].id, 'example-long', 'example-missing']);
    fireEvent.change(select, { target: { value: within(select).getByRole('option', { name: /\[b-123456\]$/ }).value } });
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(updated));
    expect(api.updateMusicVideoProject).toHaveBeenCalledWith(project.id, { soundBed: { trackId: tracks[1].id, volume: 0.3 } }, { silent: true });
    expect(api.previewMusicVideoAudioTiming).not.toHaveBeenCalled();
    expect(api.applyMusicVideoAudioTiming).not.toHaveBeenCalled();
  });
});
