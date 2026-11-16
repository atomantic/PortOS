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

  // Uniquely catches a dragged cut saving the wrong shot, edge or time, or snapping back before its save lands.
  it('drags a cut to a frame, shows both shots meeting there, and saves it', async () => {
    let settle;
    const onMoveCut = vi.fn(() => new Promise((resolve) => { settle = resolve; }));
    const onSeek = vi.fn();
    render(<ShotTimeline project={project} shotName={shotName} onOpenShot={() => {}} onSeek={onSeek} onMoveCut={onMoveCut} />);
    // At the fit zoom (20 px a second) both shots are wide enough to grab the cut between them.
    const cut = screen.getByRole('slider', { name: 'Cut after Shot s1' });
    expect(cut).toHaveAttribute('aria-valuenow', '4');
    fireEvent.pointerDown(cut, { clientX: 80, pointerId: 1, button: 0 });
    fireEvent.pointerMove(cut, { clientX: 101, pointerId: 1 });
    expect(screen.getByText('Cut 0:05.04 (+1.04s)')).toBeInTheDocument();
    expect(clips().map(widthOf)).toEqual([100.84, 139.16]);
    fireEvent.pointerUp(cut, { pointerId: 1 });
    expect(onMoveCut).toHaveBeenCalledWith('s1', 'end', 5.042);
    expect(onSeek).toHaveBeenLastCalledWith(5.042);
    // Until the save lands the cut stays where it was dropped.
    expect(widthOf(clips()[0])).toBe(100.84);
    settle();
    await waitFor(() => expect(widthOf(clips()[0])).toBe(80));
  });

  it('nudges a focused cut a frame with the arrow keys, and offers no cut handles without a save action', () => {
    const onMoveCut = vi.fn(() => Promise.resolve());
    const { unmount } = render(<ShotTimeline project={project} shotName={shotName} onOpenShot={() => {}} onSeek={() => {}} onMoveCut={onMoveCut} />);
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Cut after Shot s1' }), { key: 'ArrowLeft' });
    expect(onMoveCut).toHaveBeenCalledWith('s1', 'end', 3.958);
    unmount();
    render(<ShotTimeline project={project} shotName={shotName} onOpenShot={() => {}} onSeek={() => {}} />);
    expect(screen.queryByRole('slider', { name: /^Cut after/ })).not.toBeInTheDocument();
  });

  // Uniquely catches reorder sending the wrong song-order indexes, and a drag's release opening the clip.
  it('moves the open shot earlier or later, and a clip dragged onto another with a mouse', () => {
    const onReorder = vi.fn();
    const onOpenShot = vi.fn();
    render(<ShotTimeline project={project} activeSceneId="s2" shotName={shotName} onOpenShot={onOpenShot} onSeek={() => {}} onReorder={onReorder} />);
    expect(screen.getByRole('button', { name: 'Move shot later' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Move shot earlier' }));
    expect(onReorder).toHaveBeenLastCalledWith(1, 0);
    const [first] = clips();
    fireEvent.pointerDown(first, { clientX: 40, pointerId: 3, button: 0, pointerType: 'mouse' });
    fireEvent.pointerMove(first, { clientX: 200, pointerId: 3, pointerType: 'mouse' });
    fireEvent.pointerUp(first, { clientX: 200, pointerId: 3, pointerType: 'mouse' });
    fireEvent.click(first);
    expect(onReorder).toHaveBeenLastCalledWith(0, 1);
    expect(onOpenShot).not.toHaveBeenCalled();
    // A touch press never starts a reorder: it pans the view, and a tap still opens the shot.
    fireEvent.pointerDown(first, { clientX: 40, pointerId: 4, button: 0, pointerType: 'touch' });
    fireEvent.pointerMove(first, { clientX: 200, pointerId: 4, pointerType: 'touch' });
    fireEvent.pointerUp(first, { clientX: 200, pointerId: 4, pointerType: 'touch' });
    expect(onReorder).toHaveBeenCalledTimes(2);
  });

  // Uniquely catches an effect drawn off its moment, a drag saving song seconds or losing the shot's other effects, and a tap that stops opening the controls.
  it('shows each shot\'s effects on a track, drags an in-shot effect along its shot, and configures them in place', () => {
    const onEditShot = vi.fn();
    const withEffects = { ...project, scenes: project.scenes.map((scene) => (scene.sceneId === 's2'
      ? { ...scene, transitionIn: 'light-leak', glitches: [{ atSec: 2, style: 'gate-jump' }, { atSec: 6, style: 'color-block', strength: 0.5 }] } : scene)) };
    render(<ShotTimeline project={withEffects} shotName={shotName} onOpenShot={() => {}} onSeek={() => {}} effectOptions={{}} onEditShot={onEditShot} />);
    const track = screen.getByRole('group', { name: 'In-shot effects' });
    expect(within(track).getByRole('button', { name: 'In-shot effects of Shot s1: none' })).toBeInTheDocument();
    const lane = within(track).getByRole('button', { name: /^In-shot effects of Shot s2: .+, .+$/ });
    // Each kind of effect has its own labeled row; a kind the video never uses has none.
    expect(within(screen.getByRole('group', { name: 'Transitions' })).getByRole('button', { name: /into Shot s2$/ })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Cut effects' })).not.toBeInTheDocument();
    const [first] = within(track).getAllByRole('slider');
    // Shot s2 starts at 0:04, so its effect 2 s in sits at 0:06: 120 px at 20 px a second.
    expect(first.style.left).toBe('120px');
    fireEvent.pointerDown(first, { clientX: 120, pointerId: 1, button: 0 });
    fireEvent.pointerMove(first, { clientX: 150, pointerId: 1 });
    expect(first.style.left).toBe('150px');
    fireEvent.pointerUp(first, { clientX: 150, pointerId: 1 });
    expect(onEditShot).toHaveBeenLastCalledWith('s2', { glitches: [{ atSec: 3.5, style: 'gate-jump' }, { atSec: 6, style: 'color-block', strength: 0.5 }] });
    expect(screen.queryByRole('region', { name: 'Effects of Shot s2' })).not.toBeInTheDocument();
    // A press that never moves is a tap: it opens the shot's effect controls under the timeline.
    fireEvent.pointerDown(first, { clientX: 120, pointerId: 2, button: 0 });
    fireEvent.pointerUp(first, { clientX: 120, pointerId: 2 });
    // Tapping a marker again keeps them open; only the lane closes them.
    fireEvent.pointerDown(first, { clientX: 120, pointerId: 3, button: 0 });
    fireEvent.pointerUp(first, { clientX: 120, pointerId: 3 });
    const panel = screen.getByRole('region', { name: 'Effects of Shot s2' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Remove effect 1' }));
    expect(onEditShot).toHaveBeenLastCalledWith('s2', { glitches: [{ atSec: 6, style: 'color-block', strength: 0.5 }] });
    fireEvent.click(lane);
    expect(screen.queryByRole('region', { name: 'Effects of Shot s2' })).not.toBeInTheDocument();
  });

  // Uniquely catches a new effect landing on the wrong shot or at song time instead of shot time.
  it('adds an effect at the playhead to the shot on screen', async () => {
    const onEditShot = vi.fn();
    render(<ShotTimeline project={project} shotName={shotName} onOpenShot={() => {}} onSeek={() => {}} effectOptions={{}} onEditShot={onEditShot}
      songClock={() => ({ t: 7, playing: false })} />);
    const add = screen.getByRole('button', { name: 'Add an effect at the playhead' });
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    expect(onEditShot).toHaveBeenCalledWith('s2', { glitches: [{ atSec: 3, style: 'color-block' }] });
    expect(screen.getByRole('region', { name: 'Effects of Shot s2' })).toBeInTheDocument();
  });
});
