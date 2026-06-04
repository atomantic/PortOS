import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AudioPanel from './AudioPanel';

describe('AudioPanel', () => {
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
    expect(screen.getByText(/2\.00 MB/)).toBeTruthy();
    fireEvent.click(screen.getByText('Clear'));
    expect(onClear).toHaveBeenCalled();
  });

  it('warns when no ltx2-compatible model is installed', () => {
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
    expect(screen.getByText(/a2v requires an ltx2-runtime model/i)).toBeTruthy();
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
    expect(screen.queryByText(/a2v requires an ltx2-runtime model/i)).toBeNull();
  });
});
