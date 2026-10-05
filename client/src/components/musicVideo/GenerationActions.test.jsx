import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GenerationActions } from './ProjectActionGroups.jsx';

const scene = (order, extra = {}) => ({ sceneId: `s${order}`, order, startSec: order * 5, endSec: order * 5 + 5, prompt: 'p', ...extra });
const idleBatch = () => ({ state: null, cancel: vi.fn(), dismiss: vi.fn() });

const setup = ({ scenes, backend = 'fal', videoBatch = idleBatch(), pending } = {}) => {
  const sceneMedia = {
    genScenes: {}, genVideoScenes: {},
    frameBatch: idleBatch(), videoBatch,
    planMissingFrames: () => scenes.filter((s) => !s.referenceImageId),
    planMissingVideos: () => ({ pending: pending ?? scenes.filter((s) => s.referenceImageId && !s.videoHistoryId), skipped: 0 }),
    generateMissingFrames: vi.fn(),
    generateMissingVideos: vi.fn(),
  };
  const videoSettings = { settings: { backend }, saving: false, framePinSaving: false, videoBlockedReason: '', audioReactiveSelected: false };
  render(<GenerationActions project={{ id: 'p', scenes, audioAnalysis: { durationSec: 60 } }} videoSettings={videoSettings} sceneMedia={sceneMedia} />);
  return sceneMedia;
};

describe('GenerationActions batch confirm (#10153)', () => {
  it('submits nothing on the first click and generates only after the confirm shows count and estimate', () => {
    const media = setup({ scenes: [scene(0, { referenceImageId: 'a.png' }), scene(1, { referenceImageId: 'b.png' })] });
    fireEvent.click(screen.getByRole('button', { name: /^Videos 0\/2/ }));
    expect(media.generateMissingVideos).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Confirm clip batch' }).textContent).toMatch(/Generate 2 clips on fal .* est\. \$/);
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(media.generateMissingVideos).toHaveBeenCalledTimes(1);
  });

  it('enables Videos with a partial set of frames and names the scene still waiting', () => {
    setup({ scenes: [scene(0, { referenceImageId: 'a.png' }), scene(1, { sectionLabel: 'Bridge' })] });
    const videos = screen.getByRole('button', { name: /Videos 0\/2 \(1 waiting for a frame: Bridge\)/ });
    expect(videos.disabled).toBe(false);
  });

  it('keeps Videos disabled when no scene has a frame yet', () => {
    setup({ scenes: [scene(0), scene(1)] });
    expect(screen.getByRole('button', { name: /^Videos 0\/2/ }).disabled).toBe(true);
  });

  it('shows the running batch with Cancel remaining wired to the batch', () => {
    const videoBatch = { ...idleBatch(), state: { total: 14, done: 6, failed: 2, canceled: 0, cancelRequested: false } };
    setup({ scenes: [scene(0, { referenceImageId: 'a.png' })], videoBatch });
    expect(screen.getByRole('status').textContent).toContain('Videos: 6 of 14 done · 2 failed');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel remaining' }));
    expect(videoBatch.cancel).toHaveBeenCalledTimes(1);
  });
});
