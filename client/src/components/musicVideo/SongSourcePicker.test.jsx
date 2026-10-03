import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';

const mockEngines = [
  { id: 'acestep', name: 'ACE-Step', ready: true, lyrics: true },
  { id: 'musicgen', name: 'MusicGen', ready: true, lyrics: false },
];

vi.mock('../../services/apiMusic.js', () => ({
  listMusicEngines: vi.fn(async () => ({ engines: mockEngines })),
}));

import SongSourcePicker from './SongSourcePicker.jsx';

afterEach(cleanup);

describe('SongSourcePicker', () => {
  it('renders Suno source without local options when fallback is off', () => {
    const onChange = vi.fn();
    render(
      <SongSourcePicker
        idPrefix="test"
        songSource="suno"
        localFallback={false}
        localMusic={null}
        onChange={onChange}
      />
    );

    expect(screen.getByLabelText('Song source').value).toBe('suno');
    expect(screen.getByLabelText('Render locally if Suno is unavailable')).toBeInTheDocument();
    expect(screen.queryByLabelText('Type')).not.toBeInTheDocument();
  });

  it('renders local music options when songSource is local', async () => {
    const onChange = vi.fn();
    render(
      <SongSourcePicker
        idPrefix="test"
        songSource="local"
        localFallback={false}
        localMusic={{ type: 'model', engine: '' }}
        onChange={onChange}
      />
    );
    await act(async () => {});

    expect(screen.getByText('Local Music Studio options')).toBeInTheDocument();
    expect(screen.getByLabelText('Type').value).toBe('model');
    await waitFor(() => expect(screen.getByLabelText('Audio engine')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Audio engine'), { target: { value: 'acestep' } });
    expect(onChange).toHaveBeenCalledWith({
      localMusic: { type: 'model', engine: 'acestep' },
    });
  });

  it('switches to code language options when Type is code', async () => {
    const onChange = vi.fn();
    render(
      <SongSourcePicker
        idPrefix="test"
        songSource="local"
        localFallback={false}
        localMusic={{ type: 'code', language: 'strudel' }}
        onChange={onChange}
      />
    );
    await act(async () => {});

    expect(screen.getByLabelText('Type').value).toBe('code');
    expect(screen.getByLabelText('Code language').value).toBe('strudel');

    fireEvent.change(screen.getByLabelText('Code language'), { target: { value: 'supercollider' } });
    expect(onChange).toHaveBeenCalledWith({
      localMusic: { type: 'code', language: 'supercollider' },
    });
  });

  it('shows fallback options when Suno has localFallback enabled', async () => {
    const onChange = vi.fn();
    render(
      <SongSourcePicker
        idPrefix="test"
        songSource="suno"
        localFallback={true}
        localMusic={{ type: 'model', engine: '' }}
        onChange={onChange}
      />
    );
    await act(async () => {});

    expect(screen.getByText('Local fallback options')).toBeInTheDocument();
    expect(screen.getByLabelText('Type')).toBeInTheDocument();
  });
});
