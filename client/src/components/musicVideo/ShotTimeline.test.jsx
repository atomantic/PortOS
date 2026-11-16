import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import ShotTimeline from './ShotTimeline.jsx';

const project = {
  id: 'mv-1',
  audioAnalysis: { durationSec: 20, sections: [{ label: 'Verse', startSec: 0, endSec: 10 }] },
  lyricCues: [{ id: 'c1', text: 'An example line', startSec: 1, endSec: 3 }],
  scenes: [
    { sceneId: 's2', order: 1, startSec: 4, endSec: 12 },
    { sceneId: 's1', order: 0, startSec: 0, endSec: 4, referenceImageId: 'frame-a.png' },
    { sceneId: 's3', order: 2, startSec: null, endSec: null },
  ],
};
const shotName = (scene) => `Shot ${scene.sceneId}`;
const clips = () => within(screen.getByRole('group', { name: 'Shots' })).getAllByRole('button');
const widthOf = (el) => parseFloat(el.style.width);

// The view is 400 px wide, so 20 s fits at 20 px a second.
let clientWidth;
beforeEach(() => {
  clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
});
afterEach(() => clientWidth.mockRestore());

describe('ShotTimeline', () => {
  // Uniquely catches a clip drawn out of song order or off its span, and a tap that stops opening the shot.
  it('lays the shots out in song order, as wide as they run, and opens one on tap', () => {
    const onOpenShot = vi.fn();
    render(<ShotTimeline project={project} activeSceneId="s2" shotName={shotName} onOpenShot={onOpenShot} onSeek={() => {}} />);
    const [first, second] = clips();
    expect(first).toHaveAccessibleName('Open Shot s1, 0:00.00 to 0:04.00');
    expect([first.style.left, widthOf(first)]).toEqual(['0px', 80]);
    expect([second.style.left, widthOf(second)]).toEqual(['80px', 160]);
    expect(first.style.backgroundImage).toContain('/data/images/frame-a.png');
    expect(second).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(first);
    expect(onOpenShot).toHaveBeenCalledWith(project.scenes[1]);
    // A shot with no time is still reachable, apart from the clock.
    fireEvent.click(within(screen.getByRole('group', { name: 'Shots off the timeline' })).getByRole('button', { name: 'Shot s3' }));
    expect(onOpenShot).toHaveBeenLastCalledWith(project.scenes[2]);
  });

  // Uniquely catches the ruler seeking to the wrong song time at a zoom, and a zoom that loses the playhead.
  it('seeks the player where the ruler is tapped, at the current zoom', () => {
    const onSeek = vi.fn();
    render(<ShotTimeline project={project} shotName={shotName} onOpenShot={() => {}} onSeek={onSeek} />);
    const ruler = screen.getByRole('slider', { name: 'Seek' });
    fireEvent.pointerDown(ruler, { clientX: 100, pointerId: 1, button: 0 });
    expect(onSeek).toHaveBeenLastCalledWith(5);
    fireEvent.pointerUp(ruler, { pointerId: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    // The zoom kept 0:05 under the playhead (100 px into the view), so the view now starts 50 px in.
    expect(screen.getByTestId('shot-timeline-scroller').scrollLeft).toBe(50);
    fireEvent.pointerDown(ruler, { clientX: 90, pointerId: 2, button: 0 });
    expect(onSeek).toHaveBeenLastCalledWith(4.667);
  });

  // Uniquely catches zoom not rescaling the clips, or running past its two ends.
  it('zooms in and out between the whole song and a frame per 10 px', () => {
    render(<ShotTimeline project={project} shotName={shotName} onOpenShot={() => {}} onSeek={() => {}} />);
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    const zoomOut = screen.getByRole('button', { name: 'Zoom out' });
    expect(zoomOut).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Fit the whole song' })).toBeDisabled();
    fireEvent.click(zoomIn);
    expect(widthOf(clips()[0])).toBe(120);
    fireEvent.click(zoomOut);
    expect(widthOf(clips()[0])).toBe(80);
    expect(zoomOut).toBeDisabled();
    for (let i = 0; i < 8; i += 1) fireEvent.click(zoomIn);
    expect(widthOf(clips()[0])).toBe(960);
    expect(zoomIn).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Fit the whole song' }));
    expect(widthOf(clips()[0])).toBe(80);
  });

  // Uniquely catches the playhead losing the player's clock (position, readout, the shot on screen).
  it('follows the player clock with the playhead, the readout and the shot on screen', async () => {
    let t = 0;
    render(<ShotTimeline project={project} shotName={shotName} onOpenShot={() => {}} onSeek={() => {}} songClock={() => ({ t, playing: true })} />);
    t = 6;
    await waitFor(() => expect(screen.getByTestId('shot-timeline-playhead').style.transform).toBe('translateX(120px)'));
    expect(screen.getByLabelText('Playhead time')).toHaveTextContent('0:06.00');
    await waitFor(() => expect(clips()[1]).toHaveAttribute('aria-current', 'true'));
    expect(clips()[0]).not.toHaveAttribute('aria-current');
  });
});
