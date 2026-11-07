import { describe, expect, it } from 'vitest';
import { draftRouteMapStops, routeMapProblems, routeMapStopShots, shotRangesText } from './musicVideoRouteMaps.js';
import { musicVideoFrameModelInput, musicVideoShotModelInput } from './musicVideoShotPrompt.js';
import { musicVideoProjectUpdateSchema } from './musicVideoValidation.js';

const places = [
  { id: 'p-curve', kind: 'place', name: 'Curving street' },
  { id: 'p-brick', kind: 'place', name: 'Straight block' },
  { id: 'p-corner', kind: 'place', name: 'Corner stop' },
];
const shot = (n, placeId) => ({ sceneId: `s${n}`, order: n - 1, startSec: n, endSec: n + 1, framePrompt: `shot ${n}`, ...(placeId ? { setReference: { subjectId: placeId } } : {}) });
const scenes = [shot(1, 'p-curve'), shot(2, 'p-curve'), shot(3, 'p-brick'), shot(4), shot(5, 'p-corner'), shot(6, 'p-curve')];
const route = {
  id: 'route-1', name: 'Opening ride', heading: 'west', travel: 'Riding bikes, the low sun ahead and to the left.',
  stops: [{ id: 'a', subjectId: 'p-curve' }, { id: 'b', subjectId: 'p-brick', note: 'older brick houses' }, { id: 'c', subjectId: 'p-corner' }],
};
const project = { concept: { subjects: places }, scenes, routeMaps: [route] };
let n = 0;
const newId = () => `stop-${++n}`;

// Uniquely catches a route that is stored but never reaches the shots on it, or reaches a shot off it.
describe('route maps in shot prompts', () => {
  it('tells a shot where it is on the route, as a labeled Route addition in its frame and clip prompts', () => {
    const frame = musicVideoFrameModelInput(project, scenes[2]);
    const route = frame.promptAdditions.find((item) => item.id === 'route-map');
    expect(route.label).toBe('Route');
    expect(route.text).toBe('This shot is on the route "Opening ride", stop 2 of 3: Straight block (older brick houses). Direction of travel: west. Riding bikes, the low sun ahead and to the left. They came from Curving street. Corner stop comes next.');
    expect(frame.prompt).toContain(route.text);
    const clip = musicVideoShotModelInput(project, scenes[0], { asTyped: true });
    expect(clip.promptAdditions.find((item) => item.id === 'route-map').text).toContain('stop 1 of 3: Curving street. Direction of travel: west.');
    expect(clip.prompt).toContain('This is where the route starts.');
  });

  // Uniquely catches a look-back shot keeping the travellers' sides, which mirrors the street against its forward neighbours.
  it('places a stretch\'s side streets and landmarks in frame for the cameras looking ahead and back', () => {
    const stops = route.stops.map((stop) => (stop.id === 'b' ? { ...stop, views: { forward: 'cam-ahead', back: 'cam-back' }, features: [
      { id: 'f1', kind: 'side-street', label: 'Elm Street', side: 'left' },
      { id: 'f2', kind: 'landmark', label: 'a derelict house', side: 'right' },
    ] } : stop));
    const mapped = { ...project, routeMaps: [{ ...route, stops }] };
    const text = (greyboxShotId) => musicVideoFrameModelInput(mapped, { ...scenes[2], setReference: { subjectId: 'p-brick', ...(greyboxShotId ? { greyboxShotId } : {}) } })
      .promptAdditions.find((item) => item.id === 'route-map').text;
    expect(text('cam-ahead')).toContain('The camera looks ahead along the route, toward Corner stop. Along this stretch: a side street (Elm Street) on the left of frame; a derelict house on the right of frame.');
    expect(text('cam-back')).toContain('The camera looks back the way they came, toward Curving street, so what is on the travellers\' left is on the right of frame. Along this stretch: a side street (Elm Street) on the right of frame; a derelict house on the left of frame.');
    expect(text(null)).toContain('Along this stretch: a side street (Elm Street) on their left; a derelict house on their right.');
  });

  it('adds nothing to a shot set in no place on a route', () => {
    expect(musicVideoFrameModelInput(project, scenes[3]).promptAdditions.map((item) => item.id)).not.toContain('route-map');
    const noRoute = { ...project, routeMaps: [] };
    expect(musicVideoFrameModelInput(noRoute, scenes[2]).prompt).not.toContain('route');
  });
});

describe('route map stops', () => {
  it('lists each stop\'s shots from where they are set, so re-planned shots move with their place', () => {
    const byStop = routeMapStopShots(project, route);
    expect(byStop).toEqual({ a: [1, 2, 6], b: [3], c: [5] });
    expect(shotRangesText(byStop.a)).toBe('1-2, 6');
  });

  it('drafts a new route from the places the shots visit, in first-visit order, within a stretch of shots', () => {
    expect(draftRouteMapStops(project, { newId }).map((stop) => stop.subjectId)).toEqual(['p-curve', 'p-brick', 'p-corner']);
    expect(draftRouteMapStops(project, { fromShot: 3, toShot: 4, newId }).map((stop) => stop.subjectId)).toEqual(['p-brick']);
  });

  it('flags a stop whose place left the video or is already an earlier stop', () => {
    const broken = { ...project, routeMaps: [{ ...route, stops: [...route.stops, { id: 'd', subjectId: 'p-gone' }, { id: 'e', subjectId: 'p-brick' }] }] };
    expect(routeMapProblems(broken)).toEqual([
      { mapId: 'route-1', stopId: 'd', problem: 'missing-place' },
      { mapId: 'route-1', stopId: 'e', problem: 'repeated-place' },
    ]);
  });

  it('accepts a route map on a project update and rejects an unknown heading', () => {
    expect(musicVideoProjectUpdateSchema.safeParse({ routeMaps: [route] }).success).toBe(true);
    expect(musicVideoProjectUpdateSchema.safeParse({ routeMaps: [{ ...route, heading: 'up' }] }).success).toBe(false);
    const withFeature = (feature) => ({ routeMaps: [{ ...route, stops: [{ id: 'a', subjectId: 'p-curve', features: [feature], views: { back: 'cam-back' } }] }] });
    expect(musicVideoProjectUpdateSchema.safeParse(withFeature({ id: 'f', kind: 'landmark', label: 'derelict house', side: 'right' })).success).toBe(true);
    expect(musicVideoProjectUpdateSchema.safeParse(withFeature({ id: 'f', kind: 'landmark', side: 'behind' })).success).toBe(false);
  });
});
