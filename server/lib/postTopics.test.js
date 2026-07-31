import { describe, it, expect } from 'vitest';
import {
  POST_TOPICS,
  TOPIC_IDS,
  SESSION_TOPIC_IDS,
  resolveTopicForDrillType,
  getTopic,
  isTopicEnabled,
  enabledTopicIds,
  isMemoryItemEnabled,
} from './postTopics.js';
import { LLM_DRILL_TYPES, MATH_DRILL_TYPES, MEMORY_DRILL_TYPES, COGNITIVE_DRILL_TYPES, MORSE_DRILL_TYPES } from './postValidation.js';

describe('POST_TOPICS registry (issue #3252)', () => {
  it('has unique ids and a well-formed entry per topic', () => {
    expect(new Set(TOPIC_IDS).size).toBe(TOPIC_IDS.length);
    for (const t of POST_TOPICS) {
      expect(typeof t.id).toBe('string');
      expect(typeof t.label).toBe('string');
      expect(['session', 'standalone']).toContain(t.surface);
      expect(Array.isArray(t.drillTypes)).toBe(true);
      expect(t.drillTypes.length).toBeGreaterThan(0);
    }
  });

  it('never maps one drill type to two topics', () => {
    const all = POST_TOPICS.flatMap(t => t.drillTypes);
    expect(new Set(all).size).toBe(all.length);
  });

  it('keeps Morse standalone while Memory participates in composed sessions', () => {
    expect(getTopic('memory').surface).toBe('session');
    expect(getTopic('morse').surface).toBe('standalone');
    // Morse never posts a scored POST task, so it carries no coarse module.
    expect(getTopic('morse').module).toBeNull();
  });

  it('SESSION_TOPIC_IDS is exactly the composable subset', () => {
    expect(SESSION_TOPIC_IDS).toEqual(['math', 'memory', 'wordplay', 'verbal', 'imagination', 'cognitive']);
  });

  // The registry partitions the SAME drill types the config schema validates. If
  // it drifts, a drill type would either be ungated (no topic owns it) or the
  // Practice Plan would render a toggle the schema then rejects on save.
  it("each module's topics partition exactly that module's schema drill types", () => {
    const typesForModule = (module) => POST_TOPICS
      .filter(t => t.module === module)
      .flatMap(t => t.drillTypes)
      .sort();
    expect(typesForModule('llm-drills')).toEqual([...LLM_DRILL_TYPES].sort());
    expect(typesForModule('cognitive')).toEqual([...COGNITIVE_DRILL_TYPES].sort());
    expect(typesForModule('memory')).toEqual([...MEMORY_DRILL_TYPES].sort());
    expect(typesForModule('mental-math')).toEqual([...MATH_DRILL_TYPES].sort());
    // Morse carries a null module and its own drill-type list.
    expect(getTopic('morse').drillTypes).toEqual(MORSE_DRILL_TYPES);
  });
});

describe('resolveTopicForDrillType', () => {
  it('resolves each of the four llm-drills topics distinctly', () => {
    expect(resolveTopicForDrillType('bridge-word').id).toBe('wordplay');
    expect(resolveTopicForDrillType('wit-comeback').id).toBe('verbal');
    expect(resolveTopicForDrillType('what-if').id).toBe('imagination');
  });

  it('resolves standalone drill types', () => {
    expect(resolveTopicForDrillType('memory-element-flash').id).toBe('memory');
    expect(resolveTopicForDrillType('morse-copy').id).toBe('morse');
  });

  it('returns null for an unmapped type so callers can treat it as un-gated', () => {
    expect(resolveTopicForDrillType('some-future-drill')).toBeNull();
    expect(resolveTopicForDrillType(undefined)).toBeNull();
  });
});

describe('isTopicEnabled — absent = enabled (no migration)', () => {
  it('treats a legacy config with no topics key as everything enabled', () => {
    for (const id of TOPIC_IDS) expect(isTopicEnabled({}, id)).toBe(true);
    expect(isTopicEnabled(null, 'wordplay')).toBe(true);
    expect(isTopicEnabled(undefined, 'morse')).toBe(true);
  });

  it('only an explicit false disables', () => {
    expect(isTopicEnabled({ topics: { wordplay: {} } }, 'wordplay')).toBe(true);
    expect(isTopicEnabled({ topics: { wordplay: { enabled: true } } }, 'wordplay')).toBe(true);
    expect(isTopicEnabled({ topics: { wordplay: { enabled: false } } }, 'wordplay')).toBe(false);
  });

  it('leaves sibling topics untouched', () => {
    const config = { topics: { verbal: { enabled: false } } };
    expect(isTopicEnabled(config, 'verbal')).toBe(false);
    expect(isTopicEnabled(config, 'wordplay')).toBe(true);
  });

  it('treats an unknown topic id as enabled (forward-compat)', () => {
    expect(isTopicEnabled({ topics: {} }, 'not-a-topic')).toBe(true);
  });
});

describe('enabledTopicIds', () => {
  it('returns every topic for a legacy config', () => {
    expect(enabledTopicIds({})).toEqual(TOPIC_IDS);
  });

  it('drops only the explicitly disabled ones, in registry order', () => {
    const config = { topics: { morse: { enabled: false }, verbal: { enabled: false } } };
    expect(enabledTopicIds(config)).toEqual(['math', 'memory', 'wordplay', 'imagination', 'cognitive']);
  });
});

describe('isMemoryItemEnabled', () => {
  it('enables every item under a legacy config', () => {
    expect(isMemoryItemEnabled({}, 'elements-song')).toBe(true);
    expect(isMemoryItemEnabled({ memory: {} }, 'raven')).toBe(true);
  });

  it('honors a per-item opt-out without touching siblings', () => {
    const config = { memory: { items: { 'elements-song': { enabled: false } } } };
    expect(isMemoryItemEnabled(config, 'elements-song')).toBe(false);
    expect(isMemoryItemEnabled(config, 'raven')).toBe(true);
  });

  it('a disabled memory TOPIC disables every item under it', () => {
    const config = { topics: { memory: { enabled: false } } };
    expect(isMemoryItemEnabled(config, 'raven')).toBe(false);
  });

  it('never filters an absent item id', () => {
    expect(isMemoryItemEnabled({ memory: { items: { x: { enabled: false } } } }, null)).toBe(true);
  });
});
