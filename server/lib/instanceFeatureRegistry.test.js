import { describe, expect, it } from 'vitest';
import {
  APP_FEATURE_IDS,
  INSTANCE_FEATURES,
  INSTANCE_FEATURE_IDS,
  INSTANCE_FEATURE_GROUPS,
  INSTANCE_FEATURE_GROUP_IDS,
  countConfiguredInstances,
} from './instanceFeatureRegistry.js';

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

  it('keeps health tracking enabled by default for existing installs', () => {
    expect(INSTANCE_FEATURES.find((feature) => feature.id === 'health')).toMatchObject({
      label: 'Health tracking',
      defaultEnabled: true,
    });
  });
});

describe('instance feature groups (#40)', () => {
  it('declares an id, label and description for every group, with unique ids', () => {
    for (const group of INSTANCE_FEATURE_GROUPS) {
      expect(group.id).toBeTruthy();
      expect(group.label).toBeTruthy();
      expect(group.description).toBeTruthy();
    }
    expect(INSTANCE_FEATURE_GROUP_IDS).toEqual(INSTANCE_FEATURE_GROUPS.map((g) => g.id));
    expect(new Set(INSTANCE_FEATURE_GROUP_IDS).size).toBe(INSTANCE_FEATURE_GROUP_IDS.length);
  });

  it('keeps every feature `group` reference pointed at a declared group', () => {
    const declared = new Set(INSTANCE_FEATURE_GROUP_IDS);
    for (const feature of INSTANCE_FEATURES) {
      if (feature.group === undefined) continue;
      expect(declared.has(feature.group), `feature "${feature.id}" names unregistered group "${feature.group}"`).toBe(true);
    }
  });

  it('still lists every feature in INSTANCE_FEATURE_IDS regardless of grouping', () => {
    expect(INSTANCE_FEATURE_IDS).toContain('facetime');
    expect(INSTANCE_FEATURE_IDS).toContain('imessage');
    expect(INSTANCE_FEATURE_IDS).toContain('signal');
    expect(INSTANCE_FEATURE_IDS).toContain('x');
    expect(INSTANCE_FEATURE_IDS).toContain('stacker-news');
    expect(INSTANCE_FEATURE_IDS).toContain('beeper');
  });

  it('buckets the comms group as FaceTime Audio, iMessage, Signal, X, Stacker News and Beeper', () => {
    expect(INSTANCE_FEATURE_GROUP_IDS).toContain('comms');
    const members = INSTANCE_FEATURES.filter((feature) => feature.group === 'comms').map((feature) => feature.id);
    expect(members.sort()).toEqual(['beeper', 'facetime', 'imessage', 'signal', 'stacker-news', 'x']);
  });

  it('defaults iMessage, Signal, X and Stacker News to enabled with no detector, like the existing manual toggles', () => {
    for (const id of ['imessage', 'signal', 'x', 'stacker-news']) {
      expect(INSTANCE_FEATURES.find((feature) => feature.id === id)).toMatchObject({
        defaultEnabled: true,
        group: 'comms',
      });
    }
  });

  // Beeper deliberately defaults OFF with no detector (fork issue #11): a
  // token-presence gate can't bootstrap the very screen that sets the token,
  // unlike iMessage/Signal which are always readable once enabled.
  it('defaults Beeper to disabled with no detector', () => {
    expect(INSTANCE_FEATURES.find((feature) => feature.id === 'beeper')).toMatchObject({
      defaultEnabled: false,
      group: 'comms',
    });
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
