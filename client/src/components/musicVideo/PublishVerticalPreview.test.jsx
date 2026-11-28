import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import PublishVerticalPreview from './PublishVerticalPreview.jsx';

afterEach(cleanup);

// Uniquely catches TikTok safe-zone toggling, theme/text controls, and master-lyrics warning in the vertical preview.
describe('PublishVerticalPreview', () => {
  const baseProject = {
    id: 'mv-test',
    renderHistoryId: 'vid-1',
    audioAnalysis: { durationSec: 180, beats: [0.5, 1.0] },
    lyricOverlayEnabled: false,
    lyricCues: [{ text: 'Example lyric line', startSec: 1, endSec: 4 }],
  };
  const baseFrame = {
    theme: 'cinema-matte',
    title: 'Example Track',
    subtitle: 'Example Artist',
    footerNote: '',
    showLyrics: true,
    showWaveform: true,
  };

  it('toggles TikTok safe zones and forwards theme, span, and text edits', () => {
    const onSpanChange = vi.fn();
    const onFrameChange = vi.fn();
    render(
      <PublishVerticalPreview
        project={baseProject}
        span="full"
        frame={baseFrame}
        onSpanChange={onSpanChange}
        onFrameChange={onFrameChange}
      />,
    );

    expect(screen.getByTestId('tiktok-safe-zones')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Show TikTok safe zones'));
    expect(screen.queryByTestId('tiktok-safe-zones')).toBeNull();

    fireEvent.change(screen.getByLabelText('Frame theme'), { target: { value: 'analog-16mm' } });
    expect(onFrameChange).toHaveBeenCalledWith({ theme: 'analog-16mm' });

    fireEvent.change(screen.getByLabelText('Vertical length'), { target: { value: 'hook' } });
    expect(onSpanChange).toHaveBeenCalledWith('hook');

    fireEvent.change(screen.getByLabelText('Header title'), { target: { value: 'New Title' } });
    expect(onFrameChange).toHaveBeenCalledWith({ title: 'New Title' });
  });

  it('warns when the 16:9 master already draws overlay lyrics', () => {
    render(
      <PublishVerticalPreview
        project={{ ...baseProject, lyricOverlayEnabled: true }}
        span="full"
        frame={{ ...baseFrame, showLyrics: false }}
        onSpanChange={vi.fn()}
        onFrameChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/16:9 master already draws overlay lyrics/i)).toBeTruthy();
  });

  it('syncs playing state with native video play and pause events', () => {
    render(
      <PublishVerticalPreview
        project={baseProject}
        span="full"
        frame={baseFrame}
        onSpanChange={vi.fn()}
        onFrameChange={vi.fn()}
      />,
    );
    const video = screen.getByLabelText('Framed vertical preview');
    expect(screen.getByLabelText('Play vertical preview')).toBeTruthy();
    fireEvent.play(video);
    expect(screen.getByLabelText('Pause vertical preview')).toBeTruthy();
    fireEvent.pause(video);
    expect(screen.getByLabelText('Play vertical preview')).toBeTruthy();
  });
});
