import { describe, it, expect } from 'vitest';
import {
  FEATURE_AREAS,
  FEATURE_AREA_IDS,
  GOAL_CATEGORY_FEATURE_MAP,
  getGoalFeatureAreas,
} from './goalFeatureMap.js';
import { NAV_COMMANDS } from './navManifest.js';
import { goalCategoryEnum } from './identityValidation.js';
import * as clientMap from '../../client/src/lib/goalFeatureMap.js';

// Every route the manifest knows about (strip query strings — a feature-area
// deep-link may point at a `?ref=…` variant of a real page path).
const NAV_PATHS = new Set(NAV_COMMANDS.map((c) => c.path.split('?')[0]));

describe('goalFeatureMap — registry shape', () => {
  it('every feature area carries a label, deep-link, and icon name', () => {
    for (const [id, area] of Object.entries(FEATURE_AREAS)) {
      expect(typeof area.label, `${id}.label`).toBe('string');
      expect(area.label.length, `${id}.label`).toBeGreaterThan(0);
      expect(area.to.startsWith('/'), `${id}.to`).toBe(true);
      expect(typeof area.icon, `${id}.icon`).toBe('string');
      expect(area.icon.length, `${id}.icon`).toBeGreaterThan(0);
    }
  });

  it('every feature-area deep-link resolves to a real NAV_COMMANDS path', () => {
    for (const [id, area] of Object.entries(FEATURE_AREAS)) {
      expect(NAV_PATHS.has(area.to.split('?')[0]), `${id} → ${area.to}`).toBe(true);
    }
  });

  it('FEATURE_AREA_IDS matches the FEATURE_AREAS keys', () => {
    expect([...FEATURE_AREA_IDS].sort()).toEqual(Object.keys(FEATURE_AREAS).sort());
  });

  it('every goal category maps to known, non-empty area ids', () => {
    for (const category of goalCategoryEnum.options) {
      const ids = GOAL_CATEGORY_FEATURE_MAP[category];
      expect(Array.isArray(ids), category).toBe(true);
      expect(ids.length, category).toBeGreaterThan(0);
      for (const id of ids) expect(FEATURE_AREAS[id], `${category} → ${id}`).toBeDefined();
    }
  });
});

describe('goalFeatureMap — getGoalFeatureAreas', () => {
  it('falls back to the category default when no override is present', () => {
    const rows = getGoalFeatureAreas({ category: 'health' });
    expect(rows.map((r) => r.area)).toEqual(GOAL_CATEGORY_FEATURE_MAP.health);
    expect(rows[0]).toMatchObject({ to: '/post/launcher', label: 'Daily POST' });
  });

  it('honors a per-goal featureAreas override over the category default', () => {
    const rows = getGoalFeatureAreas({ category: 'health', featureAreas: ['universes', 'sharing'] });
    expect(rows.map((r) => r.area)).toEqual(['universes', 'sharing']);
  });

  it('drops unknown override ids and falls back when the override is all-invalid', () => {
    expect(getGoalFeatureAreas({ category: 'family', featureAreas: ['bogus'] }).map((r) => r.area))
      .toEqual(GOAL_CATEGORY_FEATURE_MAP.family);
    expect(getGoalFeatureAreas({ category: 'family', featureAreas: ['tribe', 'bogus'] }).map((r) => r.area))
      .toEqual(['tribe']);
  });

  it('returns an empty list for an unknown category with no override', () => {
    expect(getGoalFeatureAreas({ category: 'mystery' })).toEqual([]);
  });
});

describe('goalFeatureMap — server/client mirror parity', () => {
  it('server and client maps are identical', () => {
    expect(clientMap.FEATURE_AREAS).toEqual(FEATURE_AREAS);
    expect(clientMap.GOAL_CATEGORY_FEATURE_MAP).toEqual(GOAL_CATEGORY_FEATURE_MAP);
    expect([...clientMap.FEATURE_AREA_IDS].sort()).toEqual([...FEATURE_AREA_IDS].sort());
  });
});
