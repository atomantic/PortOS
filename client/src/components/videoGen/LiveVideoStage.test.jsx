import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LiveVideoStage from './LiveVideoStage';
import { resolveVideoStagePreview, VIDEO_STAGE_KIND } from '../../lib/videoStagePreview';

const stageFrame = () => screen.getByTestId('video-stage-frame');

describe('LiveVideoStage', () => {
  it('keeps conditioning media on stage instead of showing a live runner frame', () => {
    const descriptor = resolveVideoStagePreview({
      generating: true,
      currentImage: 'iVBORw0KG',
      sourceImageFile: 'start.png',
      width: 480,
      height: 832,
    });
    render(<LiveVideoStage descriptor={descriptor} generating progressPct={40} statusMsg="Rendering step 4/10" />);

    expect(screen.queryByAltText('Live frame')).not.toBeInTheDocument();
    expect(screen.getByAltText('Start frame').getAttribute('src')).toBe('/data/images/start.png');
    // Portrait geometry: an inline style, never a computed Tailwind class
    // (a `aspect-[480/832]` class name would not survive the JIT build).
    // (CSS normalizes a bare number to `<n> / 1`, hence the split.)
    const ratio = Number(stageFrame().style.aspectRatio.split('/')[0]);
    expect(ratio).toBeCloseTo(480 / 832);
    expect(ratio).toBeLessThan(1);
    // The height cap alone would override the ratio and hand a portrait render
    // a wide box; the width has to be capped by the ratio as well.
    expect(stageFrame().style.maxHeight).toBe('60vh');
    // (CSS folds the `calc(60vh * ratio)` to a single vh length.)
    const capped = stageFrame().style.maxWidth.match(/min\(100%,\s*([\d.]+)vh\)/);
    expect(capped).toBeTruthy();
    expect(Number(capped[1])).toBeCloseTo(60 * (480 / 832));
    expect(screen.getByTestId('video-stage-progress').style.width).toBe('40%');
  });

  it('leaves the aspect ratio unset when the render geometry is unknown', () => {
    const descriptor = resolveVideoStagePreview({ generating: true });
    render(<LiveVideoStage descriptor={descriptor} generating />);
    expect(stageFrame().style.aspectRatio).toBe('');
  });

  it('plays the extend source as a muted ambient loop with no controls', () => {
    const descriptor = resolveVideoStagePreview({
      generating: true, extendSource: { filename: 'clip-a.mp4', thumbnail: 'clip-a.jpg' },
    });
    render(<LiveVideoStage descriptor={descriptor} generating />);

    const video = screen.getByLabelText('Continuing from this clip');
    expect(video.tagName).toBe('VIDEO');
    expect(video.getAttribute('src')).toBe('/data/videos/clip-a.mp4');
    expect(video.getAttribute('poster')).toBe('/data/video-thumbnails/clip-a.jpg');
    expect(video.muted).toBe(true);
    expect(video.loop).toBe(true);
    expect(video.controls).toBe(false);
  });

  it('shows the spinner and status while a render has nothing to preview yet', () => {
    const descriptor = resolveVideoStagePreview({ generating: true });
    render(<LiveVideoStage descriptor={descriptor} generating statusMsg="Loading pipeline…" />);
    expect(screen.getAllByText('Loading pipeline…').length).toBeGreaterThan(0);
    expect(stageFrame().dataset.stageKind).toBe(VIDEO_STAGE_KIND.EMPTY);
  });

  it('hands off to the finished clip when the render completes', () => {
    const forming = resolveVideoStagePreview({ generating: true, sourceImageFile: 'start.png' });
    const { rerender } = render(<LiveVideoStage descriptor={forming} generating />);
    expect(stageFrame().dataset.stageKind).toBe(VIDEO_STAGE_KIND.STILL);

    const done = resolveVideoStagePreview({ result: { path: '/data/videos/done.mp4' } });
    rerender(<LiveVideoStage descriptor={done} />);
    expect(stageFrame().dataset.stageKind).toBe(VIDEO_STAGE_KIND.RESULT);
    expect(screen.getByLabelText('Latest render').getAttribute('src')).toBe('/data/videos/done.mp4');
  });

  it('holds the stage while the page reports the user is watching, then returns', () => {
    const first = resolveVideoStagePreview({ result: { path: '/data/videos/one.mp4' } });
    const { rerender } = render(<LiveVideoStage descriptor={first} held />);
    expect(screen.getByLabelText('Latest render').getAttribute('src')).toBe('/data/videos/one.mp4');

    const second = resolveVideoStagePreview({ result: { path: '/data/videos/two.mp4' } });
    rerender(<LiveVideoStage descriptor={second} held />);
    expect(screen.getByLabelText('Latest render').getAttribute('src')).toBe('/data/videos/one.mp4');
    expect(screen.getByText(/Newer preview ready/)).toBeTruthy();

    rerender(<LiveVideoStage descriptor={second} />);
    expect(screen.getByLabelText('Latest render').getAttribute('src')).toBe('/data/videos/two.mp4');
  });

  it('does not swap out a finished clip the user is playing, and swaps once it pauses', () => {
    const first = resolveVideoStagePreview({ result: { path: '/data/videos/one.mp4' } });
    const { rerender } = render(<LiveVideoStage descriptor={first} />);
    fireEvent.play(screen.getByLabelText('Latest render'));

    const forming = resolveVideoStagePreview({ generating: true, sourceImageFile: 'start.png' });
    rerender(<LiveVideoStage descriptor={forming} generating />);
    expect(stageFrame().dataset.stageKind).toBe(VIDEO_STAGE_KIND.RESULT);

    fireEvent.pause(screen.getByLabelText('Latest render'));
    rerender(<LiveVideoStage descriptor={forming} generating />);
    expect(stageFrame().dataset.stageKind).toBe(VIDEO_STAGE_KIND.STILL);
  });

  it('never holds on the ambient loop — it is chrome, not something the user chose to watch', () => {
    const loop = resolveVideoStagePreview({
      generating: true, extendSource: { filename: 'clip-a.mp4' },
    });
    const { rerender } = render(<LiveVideoStage descriptor={loop} generating />);
    fireEvent.play(screen.getByLabelText('Continuing from this clip'));

    const still = resolveVideoStagePreview({ generating: true, sourceImageFile: 'start.png' });
    rerender(<LiveVideoStage descriptor={still} generating />);
    expect(stageFrame().dataset.stageKind).toBe(VIDEO_STAGE_KIND.STILL);
  });

  it('surfaces a render failure over the stage', () => {
    const descriptor = resolveVideoStagePreview({ sourceImageFile: 'start.png' });
    render(<LiveVideoStage descriptor={descriptor} error="Runtime not installed" />);
    expect(screen.getByText('Runtime not installed')).toBeTruthy();
  });
});
