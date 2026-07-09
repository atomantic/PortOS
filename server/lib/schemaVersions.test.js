import { describe, it, expect } from 'vitest';
import {
  PORTOS_SCHEMA_VERSIONS,
  RECORD_KIND_SCHEMA_CATEGORIES,
  compareSchemaVersions,
  scopeVersionDiff,
  formatVersionGap,
  buildPortosMeta,
} from './schemaVersions.js';

describe('PORTOS_SCHEMA_VERSIONS', () => {
  it('is a frozen object', () => {
    expect(Object.isFrozen(PORTOS_SCHEMA_VERSIONS)).toBe(true);
    expect(() => { PORTOS_SCHEMA_VERSIONS.universes = 999; }).toThrow();
  });

  it('declares universes at the post-split layout version', () => {
    // If this changes, the corresponding migration in scripts/migrations/
    // must ship alongside it. The test exists to make a layout bump a
    // deliberate two-file edit.
    // v6 = canon characters gained relationshipLinks[] (#1287); v7 = canon
    // objects gained attachments[] (#1288). Both additive + version-gated so an
    // older peer can't strip-then-LWW the field back.
    expect(PORTOS_SCHEMA_VERSIONS.universes).toBe(7);
  });

  it('declares pipeline collection layout versions', () => {
    // pipelineIssues bumped to 2 when stages.audio.audioMode + cues[] were added.
    expect(PORTOS_SCHEMA_VERSIONS.pipelineIssues).toBe(2);
    // pipelineSeries bumped to 12 when series.exportSettings was added (#2181)
    // (v2 = readerMap, v3 = tickingClock, v4 = styleGuide, v5 = coverImage,
    // v6 = characterArcs, v7 = factCritical + factReference,
    // v8 = editorialCheckConfig, v9 = severityWeights + blockingSeverities,
    // v10 = arc.foreshadowing, v11 = styleGuide.voiceExemplars +
    // voiceAntiExemplars).
    expect(PORTOS_SCHEMA_VERSIONS.pipelineSeries).toBe(12);
  });

  it('declares mediaCollections layout version', () => {
    expect(PORTOS_SCHEMA_VERSIONS.mediaCollections).toBe(1);
  });
});

describe('buildPortosMeta', () => {
  it('returns { portosVersion, schemaVersions } with the live registry', async () => {
    const meta = await buildPortosMeta();
    expect(meta.portosVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(meta.schemaVersions.universes).toBe(7);
    expect(meta.schemaVersions.pipelineIssues).toBe(2);
    expect(meta.schemaVersions.pipelineSeries).toBe(12);
  });

  it('overrides merge into schemaVersions', async () => {
    const meta = await buildPortosMeta({ schemaVersions: { future: 1 } });
    expect(meta.schemaVersions.universes).toBe(7);
    expect(meta.schemaVersions.future).toBe(1);
  });
});

describe('compareSchemaVersions', () => {
  it('compatible when both sides match exactly', () => {
    const r = compareSchemaVersions({ universes: 5 }, { universes: 5 });
    expect(r.compatible).toBe(true);
    expect(r.ahead).toEqual([]);
    expect(r.behind).toEqual([]);
  });

  it('flags ahead when sender is newer', () => {
    const r = compareSchemaVersions({ universes: 6 }, { universes: 5 });
    expect(r.compatible).toBe(false);
    expect(r.ahead).toEqual([{ category: 'universes', senderV: 6, receiverV: 5 }]);
    expect(r.behind).toEqual([]);
  });

  it('flags behind when sender is older', () => {
    const r = compareSchemaVersions({ universes: 4 }, { universes: 5 });
    expect(r.compatible).toBe(false);
    expect(r.ahead).toEqual([]);
    expect(r.behind).toEqual([{ category: 'universes', senderV: 4, receiverV: 5 }]);
  });

  it('handles mixed ahead + behind across categories', () => {
    const r = compareSchemaVersions(
      { universes: 6, series: 1 },
      { universes: 5, series: 3 },
    );
    expect(r.ahead).toEqual([{ category: 'universes', senderV: 6, receiverV: 5 }]);
    expect(r.behind).toEqual([{ category: 'series', senderV: 1, receiverV: 3 }]);
    expect(r.compatible).toBe(false);
  });

  it('treats a missing sender field as 0 (sender behind)', () => {
    const r = compareSchemaVersions({}, { universes: 5 });
    expect(r.behind).toEqual([{ category: 'universes', senderV: 0, receiverV: 5 }]);
    expect(r.ahead).toEqual([]);
  });

  it('treats a missing receiver field as 0 (sender ahead)', () => {
    const r = compareSchemaVersions({ universes: 5 }, {});
    expect(r.ahead).toEqual([{ category: 'universes', senderV: 5, receiverV: 0 }]);
    expect(r.behind).toEqual([]);
  });

  it('silently passes legacy peer with no portosMeta at all (sender = {}) when receiver has no version either', () => {
    const r = compareSchemaVersions({}, {});
    expect(r.compatible).toBe(true);
  });

  it('ignores categories where both sides are 0/absent', () => {
    const r = compareSchemaVersions(
      { universes: 5, future: 0 },
      { universes: 5, somethingElse: 0 },
    );
    expect(r.compatible).toBe(true);
  });

  it('treats non-integer entries as 0', () => {
    const r = compareSchemaVersions(
      { universes: 'five', series: 1.5 },
      { universes: 5 },
    );
    // 'five' → 0 → sender behind v5 ; 1.5 → 0 ; receiver has no series → both 0 → skip
    expect(r.behind).toEqual([{ category: 'universes', senderV: 0, receiverV: 5 }]);
    expect(r.ahead).toEqual([]);
  });

  it('handles null/undefined inputs gracefully', () => {
    expect(compareSchemaVersions(null, { universes: 5 }).behind).toHaveLength(1);
    expect(compareSchemaVersions(undefined, { universes: 5 }).behind).toHaveLength(1);
    // Default receiver is PORTOS_SCHEMA_VERSIONS (live).
    expect(compareSchemaVersions(null).behind).toHaveLength(Object.keys(PORTOS_SCHEMA_VERSIONS).length);
  });
});

describe('RECORD_KIND_SCHEMA_CATEGORIES', () => {
  it('maps each federated record kind to its versioned storage categories', () => {
    expect(RECORD_KIND_SCHEMA_CATEGORIES.universe).toEqual(['universes']);
    expect(RECORD_KIND_SCHEMA_CATEGORIES.series).toEqual(['pipelineSeries']);
    expect(RECORD_KIND_SCHEMA_CATEGORIES.issue).toEqual(['pipelineIssues']);
    expect(RECORD_KIND_SCHEMA_CATEGORIES.mediaCollection).toEqual(['mediaCollections']);
  });

  it('only references keys that exist in PORTOS_SCHEMA_VERSIONS', () => {
    for (const keys of Object.values(RECORD_KIND_SCHEMA_CATEGORIES)) {
      for (const k of keys) {
        expect(PORTOS_SCHEMA_VERSIONS[k]).toBeDefined();
      }
    }
  });

  it('is frozen so a kind→category mapping change is deliberate', () => {
    expect(Object.isFrozen(RECORD_KIND_SCHEMA_CATEGORIES)).toBe(true);
  });
});

describe('scopeVersionDiff', () => {
  const diff = {
    ahead: [
      { category: 'universes', senderV: 6, receiverV: 5 },
      { category: 'mediaCollections', senderV: 2, receiverV: 1 },
    ],
    behind: [{ category: 'pipelineSeries', senderV: 1, receiverV: 2 }],
    compatible: false,
  };

  it('keeps only ahead/behind entries within the allowed categories', () => {
    const scoped = scopeVersionDiff(diff, ['universes']);
    expect(scoped.ahead).toEqual([{ category: 'universes', senderV: 6, receiverV: 5 }]);
    expect(scoped.behind).toEqual([]);
    expect(scoped.compatible).toBe(false);
  });

  it('drops an unrelated ahead category so it no longer blocks', () => {
    // The crux of the per-category gate: a transfer that only touches
    // `pipelineSeries` is NOT blocked by a sender that bumped `mediaCollections`.
    const scoped = scopeVersionDiff(diff, ['pipelineSeries']);
    expect(scoped.ahead).toEqual([]); // mediaCollections + universes filtered out
    expect(scoped.behind).toEqual([{ category: 'pipelineSeries', senderV: 1, receiverV: 2 }]);
    expect(scoped.compatible).toBe(false);
  });

  it('an empty allow-list makes the scoped diff compatible (no versioned category touched)', () => {
    const scoped = scopeVersionDiff(diff, []);
    expect(scoped.ahead).toEqual([]);
    expect(scoped.behind).toEqual([]);
    expect(scoped.compatible).toBe(true);
  });

  it('a non-array categories arg returns the diff unchanged (whole-payload gate)', () => {
    expect(scopeVersionDiff(diff, null)).toBe(diff);
    expect(scopeVersionDiff(diff, undefined)).toBe(diff);
  });

  it('tolerates a malformed diff (missing ahead/behind arrays)', () => {
    const scoped = scopeVersionDiff({}, ['universes']);
    expect(scoped).toEqual({ ahead: [], behind: [], compatible: true });
  });

  it('composes with compareSchemaVersions for a realistic cross-key scenario', () => {
    // Sender is ahead on mediaCollections only; a universe transfer scopes to
    // ['universes'] and stays compatible even though the union diff is not.
    const union = compareSchemaVersions(
      { universes: 7, pipelineSeries: 2, pipelineIssues: 2, mediaCollections: 2 },
      PORTOS_SCHEMA_VERSIONS,
    );
    expect(union.compatible).toBe(false); // mediaCollections 2 > 1
    expect(scopeVersionDiff(union, RECORD_KIND_SCHEMA_CATEGORIES.universe).compatible).toBe(true);
    expect(scopeVersionDiff(union, RECORD_KIND_SCHEMA_CATEGORIES.mediaCollection).compatible).toBe(false);
  });
});

describe('formatVersionGap', () => {
  it('describes a single ahead gap', () => {
    expect(formatVersionGap({ ahead: [{ category: 'universes', senderV: 5, receiverV: 4 }] }))
      .toBe('sender ahead of receiver on universes (v5 vs v4)');
  });

  it('describes a single behind gap', () => {
    expect(formatVersionGap({ behind: [{ category: 'universes', senderV: 4, receiverV: 5 }] }))
      .toBe('sender behind receiver on universes (v4 vs v5)');
  });

  it('combines ahead + behind across categories', () => {
    expect(formatVersionGap({
      ahead: [{ category: 'universes', senderV: 6, receiverV: 5 }],
      behind: [{ category: 'series', senderV: 1, receiverV: 3 }],
    })).toBe('sender ahead of receiver on universes (v6 vs v5); sender behind receiver on series (v1 vs v3)');
  });

  it('returns "compatible" for an empty diff', () => {
    expect(formatVersionGap({ ahead: [], behind: [] })).toBe('compatible');
    expect(formatVersionGap({})).toBe('compatible');
    expect(formatVersionGap()).toBe('compatible');
  });
});
