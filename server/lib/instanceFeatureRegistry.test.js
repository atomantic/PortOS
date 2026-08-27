import { describe, expect, it } from 'vitest';
import { APP_FEATURE_IDS, INSTANCE_FEATURES, INSTANCE_FEATURE_IDS, countConfiguredInstances } from './instanceFeatureRegistry.js';

describe('instance feature registry', () => {
  it('declares an id, label, description and default for every feature', () => {
    for (const feature of INSTANCE_FEATURES) {
      expect(feature.id).toBeTruthy();
      expect(feature.label).toBeTruthy();
      expect(feature.description).toBeTruthy();
      expect(typeof feature.defaultEnabled).toBe('boolean');
    }
    expect(INSTANCE_FEATURE_IDS).toEqual(INSTANCE_FEATURES.map((f) => f.id));
    expect(new Set(INSTANCE_FEATURE_IDS).size).toBe(INSTANCE_FEATURE_IDS.length);
  });

  it('keeps managed-app feature overrides inside the registered catalog', () => {
    expect(APP_FEATURE_IDS).toEqual(['datadog', 'jira', 'gsd']);
    expect(APP_FEATURE_IDS.every((id) => INSTANCE_FEATURE_IDS.includes(id))).toBe(true);
    expect(new Set(APP_FEATURE_IDS).size).toBe(APP_FEATURE_IDS.length);
  });
});

describe('countConfiguredInstances', () => {
  it('counts the declared instances', () => {
    expect(countConfiguredInstances({ instances: {} })).toBe(0);
    expect(countConfiguredInstances({ instances: { a: {}, b: {} } })).toBe(2);
  });

  // Every one of these would otherwise produce a CONFIDENT wrong answer that
  // silently shows or hides navigation, so each must read as detection failure.
  it('throws on a shape it cannot trust rather than guessing a count', () => {
    // The dangerous one: Object.keys('bad') is ['0','1','2'] — three "instances".
    expect(() => countConfiguredInstances({ instances: 'bad' })).toThrow(/Malformed/);
    // These would each report a confident zero.
    expect(() => countConfiguredInstances({ instances: [] })).toThrow(/Malformed/);
    expect(() => countConfiguredInstances({ instances: null })).toThrow(/Malformed/);
    expect(() => countConfiguredInstances({})).toThrow(/Malformed/);
    expect(() => countConfiguredInstances(null)).toThrow(/Malformed/);
  });

  it('names the file in the error so a corrupt config is findable', () => {
    expect(() => countConfiguredInstances({ instances: [] }, 'jira.json')).toThrow(/jira\.json/);
  });
});
