import { describe, expect, it } from 'vitest';
import { draftTownFromRouteMaps, townFill, townSkyAt } from './townMap.js';
import { townMapSchema } from './townMapValidation.js';

const idMaker = () => { let n = 0; return () => `t${++n}`; };

const project = {
  concept: {
    subjects: [
      { id: 'p-home', kind: 'place', name: 'Home street', ingredientId: 'cat-home' },
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

describe('draftTownFromRouteMaps', () => {
  it('lays each route along its heading, continues a route from a placed set, and parks unvisited places', () => {
    const { town, skipped } = draftTownFromRouteMaps(project, { newId: idMaker() });
    expect(townMapSchema.safeParse(town).success).toBe(true);
    const at = Object.fromEntries(town.sets.map((set) => [set.ingredientId, set.position]));
    expect(at['cat-home']).toEqual([0, 0]);
    expect(at['cat-mall']).toEqual([120, 0]);
    // The second route starts at the mall and heads north (-Z).
    expect(at['cat-field']).toEqual([120, -120]);
    expect(at['cat-pond'][1]).toBeGreaterThan(0);
    expect(skipped).toEqual(['Unlinked lot']);
    // Two route roads plus Elm, which turns left (north) off an eastbound road.
    expect(town.streets).toHaveLength(3);
    const elm = town.streets.find((street) => street.points[0][0] === 0 && street.points[1][1] < 0);
    expect(elm.points[1]).toEqual([0, -80]);
  });
});

describe('townFill', () => {
  const town = {
    version: 1, seed: 3,
    sets: [{ id: 'set-a', ingredientId: 'cat-a', position: [100, 0], rotationDegrees: 0 }],
    streets: [
      { id: 'main', kind: 'road', sides: 'houses', width: 9, points: [[0, 0], [200, 0]] },
      { id: 'edge', kind: 'track', sides: 'fence', width: 4, points: [[200, 0], [200, -120]] },
    ],
  };

  it('is the same on every call, lines roads with houses and lamps, and keeps clear of placed sets', () => {
    const fill = townFill(town);
    expect(townFill(town)).toEqual(fill);
    expect(fill.houses.length).toBeGreaterThan(8);
    expect(fill.lamps.length).toBeGreaterThan(3);
    expect(fill.fences.length).toBeGreaterThan(0);
    expect(fill.houses.every(({ position: [x, , z] }) => Math.hypot(x - 100, z) > 30)).toBe(true);
    // A track gets no lamps.
    expect(fill.lamps.every(({ position: [x] }) => x < 200)).toBe(true);
  });

  it('changes with the seed', () => {
    expect(townFill({ ...town, seed: 4 }).houses).not.toEqual(townFill(town).houses);
  });
});

describe('townSkyAt', () => {
  it('lights day, darkens night with lamps on, and wraps past midnight', () => {
    expect(townSkyAt(12 * 60)).toMatchObject({ lampsOn: false, sunIntensity: 1.4 });
    expect(townSkyAt(23 * 60)).toMatchObject({ lampsOn: true, sunIntensity: 0 });
    expect(townSkyAt(24 * 60 + 30)).toEqual(townSkyAt(30));
  });
});
