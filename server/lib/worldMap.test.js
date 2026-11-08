import { describe, expect, it } from 'vitest';
import { draftWorldFromRouteMaps, worldFill, worldSkyAt } from './worldMap.js';
import { worldMapSchema } from './worldMapValidation.js';

const idMaker = () => { let n = 0; return () => `t${++n}`; };

const project = {
  concept: {
    subjects: [
      { id: 'p-home', kind: 'place', name: 'Home path', ingredientId: 'cat-home' },
      { id: 'p-mall', kind: 'place', name: 'Mall lot', ingredientId: 'cat-mall' },
      { id: 'p-field', kind: 'place', name: 'Field', ingredientId: 'cat-field' },
      { id: 'p-pond', kind: 'place', name: 'Pond', ingredientId: 'cat-pond' },
      { id: 'p-loose', kind: 'place', name: 'Unlinked lot' },
      { id: 'c-a', kind: 'character', name: 'Ana' },
    ],
  },
  routeMaps: [
    { id: 'r1', name: 'To the mall', heading: 'east', stops: [
      { id: 's1', subjectId: 'p-home', features: [{ id: 'f1', kind: 'side-street', label: 'Elm', side: 'left' }] },
      { id: 's2', subjectId: 'p-mall' },
    ] },
    { id: 'r2', name: 'To the edge', heading: 'north', stops: [{ id: 's3', subjectId: 'p-mall' }, { id: 's4', subjectId: 'p-field' }] },
  ],
};

describe('draftWorldFromRouteMaps', () => {
  it('lays each route along its heading, continues a route from a placed set, and parks unvisited places', () => {
    const { world, skipped } = draftWorldFromRouteMaps(project, { newId: idMaker() });
    expect(worldMapSchema.safeParse(world).success).toBe(true);
    const at = Object.fromEntries(world.sets.map((set) => [set.ingredientId, set.position]));
    expect(at['cat-home']).toEqual([0, 0]);
    expect(at['cat-mall']).toEqual([120, 0]);
    // The second route starts at the mall and heads north (-Z).
    expect(at['cat-field']).toEqual([120, -120]);
    expect(at['cat-pond'][1]).toBeGreaterThan(0);
    expect(skipped).toEqual(['Unlinked lot']);
    // Two route roads plus Elm, which turns left (north) off an eastbound road.
    expect(world.paths).toHaveLength(3);
    const elm = world.paths.find((path) => path.points[0][0] === 0 && path.points[1][1] < 0);
    expect(elm.points[1]).toEqual([0, -80]);
  });
});

describe('worldFill', () => {
  const world = {
    version: 1, seed: 3,
    sets: [{ id: 'set-a', ingredientId: 'cat-a', position: [100, 0], rotationDegrees: 0 }],
    paths: [
      { id: 'main', kind: 'road', sides: 'buildings', width: 9, points: [[0, 0], [200, 0]] },
      { id: 'edge', kind: 'track', sides: 'fence', width: 4, points: [[200, 0], [200, -120]] },
    ],
  };

  it('is the same on every call, lines roads with houses and lamps, and keeps clear of placed sets', () => {
    const fill = worldFill(world);
    expect(worldFill(world)).toEqual(fill);
    expect(fill.buildings.length).toBeGreaterThan(8);
    expect(fill.lamps.length).toBeGreaterThan(3);
    expect(fill.fences.length).toBeGreaterThan(0);
    expect(fill.buildings.every(({ position: [x, , z] }) => Math.hypot(x - 100, z) > 30)).toBe(true);
    // A track gets no lamps.
    expect(fill.lamps.every(({ position: [x] }) => x < 200)).toBe(true);
  });

  it('changes with the seed', () => {
    expect(worldFill({ ...world, seed: 4 }).buildings).not.toEqual(worldFill(world).buildings);
  });
});

describe('worldSkyAt', () => {
  it('lights day, darkens night with lamps on, and wraps past midnight', () => {
    expect(worldSkyAt(12 * 60)).toMatchObject({ lampsOn: false, sunIntensity: 1.4 });
    expect(worldSkyAt(23 * 60)).toMatchObject({ lampsOn: true, sunIntensity: 0 });
    expect(worldSkyAt(24 * 60 + 30)).toEqual(worldSkyAt(30));
    // A ship's interior or open space does not get a sunset.
    expect(worldSkyAt(20 * 60, 'indoor')).toEqual(worldSkyAt(12 * 60, 'indoor'));
    expect(worldSkyAt(23 * 60, 'space')).toMatchObject({ sky: '#000000', lampsOn: false });
  });
});

// Catches large sets (a long street greybox) drafted on top of each other.
it('spaces route stops by their greyboxes so big sets never overlap', () => {
  const wide = { x: -100, z: -20, w: 200, d: 40 };
  const { world } = draftWorldFromRouteMaps(project, { newId: idMaker(), footprints: { 'cat-home': wide, 'cat-mall': wide } });
  const at = Object.fromEntries(world.sets.map((set) => [set.ingredientId, set]));
  // Eastbound sets turn 90°, so their 200 m width runs north-south and the 40 m depth runs east: 120 m still clears.
  expect(at['cat-mall'].position[0] - at['cat-home'].position[0]).toBe(120);
  const deep = { x: -20, z: -150, w: 40, d: 300 };
  const spaced = draftWorldFromRouteMaps(project, { newId: idMaker(), footprints: { 'cat-home': deep, 'cat-mall': deep } }).world;
  const by = Object.fromEntries(spaced.sets.map((set) => [set.ingredientId, set.position]));
  // Now 300 m runs along the road: the next set starts 20 m past the last one's far edge.
  expect(by['cat-mall'][0] - by['cat-home'][0]).toBe(320);
});
