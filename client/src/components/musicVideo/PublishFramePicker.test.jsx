import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PublishFramePicker from './PublishFramePicker.jsx';
import { coverArtSources } from './CoverArtPanel.jsx';
import { thumbnailSources } from './YoutubeThumbnailPanel.jsx';

describe('publish frame picker', () => {
  it('scrubs the final video, captures its chosen time, and offers persisted captures in both lists', () => {
    const project = { id: 'mv-example', renderHistoryId: 'final', publishKit: { frames: ['chosen.png'], thumbnails: ['auto.jpg'] } };
    const captureFrame = vi.fn();
    render(<PublishFramePicker project={project} publishKit={{ captureFrame }} cardId="cover" />);
    const video = screen.getByLabelText('Final video frame preview');
    Object.defineProperty(video, 'duration', { configurable: true, value: 20 });
    fireEvent.loadedMetadata(video);
    fireEvent.change(screen.getByLabelText('Frame time (seconds)'), { target: { value: '12.25' } });
    expect(video.currentTime).toBe(12.25);
    fireEvent.click(screen.getByRole('button', { name: 'Use this frame' }));
    expect(captureFrame).toHaveBeenCalledWith(12.25);
    for (const sources of [coverArtSources(project), thumbnailSources(project)]) {
      expect(sources[0]).toMatchObject({ kind: 'thumbnail', filename: 'chosen.png', src: '/data/video-thumbnails/chosen.png' });
    }
  });
});
