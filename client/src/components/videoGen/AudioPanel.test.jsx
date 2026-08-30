import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AudioPanel from './AudioPanel';

describe('AudioPanel', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:audio-preview');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it('renders the upload control when no file is picked', () => {
    render(
      <AudioPanel
        audioFile={null}
        numFrames={121}
        fps={24}
        hasCompatibleModel
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(screen.getByText(/Upload audio/i)).toBeTruthy();
    // Length hint = frames ÷ fps.
    expect(screen.getByText(/5\.0s/)).toBeTruthy();
    expect(screen.queryByText('Clear')).toBeNull();
  });

  it('shows the picked file name + size and fires onClear', () => {
    const onClear = vi.fn();
    const file = new File(['x'.repeat(2 * 1024 * 1024)], 'track.wav', { type: 'audio/wav' });
    render(
      <AudioPanel
        audioFile={file}
        numFrames={121}
        fps={24}
        hasCompatibleModel
        onPick={vi.fn()}
        onClear={onClear}
      />,
    );
    expect(screen.getByText('track.wav')).toBeTruthy();
    expect(screen.getByText(/2 MB/)).toBeTruthy();
    expect(screen.getByLabelText('Preview selected audio')).toHaveAttribute('src', 'blob:audio-preview');
    fireEvent.click(screen.getByText('Clear'));
    expect(onClear).toHaveBeenCalled();
  });

  it('loads the selected audio metadata, shows its duration, and releases the preview URL', () => {
    const file = new File(['waveform'], 'scene.wav', { type: 'audio/wav' });
    const onDurationChange = vi.fn();
    const { unmount } = render(
      <AudioPanel
        audioFile={file}
        numFrames={121}
        fps={24}
        hasCompatibleModel
        onDurationChange={onDurationChange}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    const player = screen.getByLabelText('Preview selected audio');
    Object.defineProperty(player, 'duration', { configurable: true, value: 41.04 });
    fireEvent.loadedMetadata(player);
    expect(screen.getByText('0:41')).toBeTruthy();
    expect(onDurationChange).toHaveBeenLastCalledWith(41.04);
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:audio-preview');
  });

  it('warns when no audio-to-video model is available', () => {
    render(
      <AudioPanel
        audioFile={null}
        numFrames={121}
        fps={24}
        hasCompatibleModel={false}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(screen.getByText(/No audio-to-video model is available/i)).toBeTruthy();
  });

  it('does not warn when a compatible model exists', () => {
    render(
      <AudioPanel
        audioFile={null}
        numFrames={121}
        fps={24}
        hasCompatibleModel
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(screen.queryByText(/No audio-to-video model is available/i)).toBeNull();
  });

  it('explains arbitrary-length H3 windowing without a frame-length warning', () => {
    render(
      <AudioPanel
        audioFile={null}
        numFrames={124}
        fps={24}
        hasCompatibleModel
        audioDurationDriven
        arbitraryLengthAudio
        maxReferenceAudioSeconds={15}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(screen.getByText(/continuity-linked windows of up to 15s/i)).toBeTruthy();
    expect(screen.getByText(/preserves the full source audio/i)).toBeTruthy();
    expect(screen.queryByText(/frames ÷ fps/i)).toBeNull();
  });

  it('does not claim a stale derived frame count when LTX audio exceeds the single-pass limit', () => {
    render(
      <AudioPanel
        audioFile={null}
        numFrames={985}
        fps={24}
        hasCompatibleModel
        audioDurationDriven
        maxDurationSeconds={42.375}
        durationError="This audio is too long for one LTX render."
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(screen.queryByText(/985 frames/i)).toBeNull();
    expect(screen.getByText(/snaps to the model's temporal grid/i)).toBeTruthy();
    expect(screen.getByText(/up to 42\.4s/i)).toBeTruthy();
    expect(screen.getByText(/too long for one LTX render/i)).toBeTruthy();
  });
});
