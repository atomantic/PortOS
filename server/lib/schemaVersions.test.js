import { describe, it, expect } from 'vitest';
import {
  PORTOS_SCHEMA_VERSIONS,
  compareSchemaVersions,
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
    expect(PORTOS_SCHEMA_VERSIONS.universes).toBe(5);
  });

  it('declares pipeline collection layout versions', () => {
    expect(PORTOS_SCHEMA_VERSIONS.pipelineIssues).toBe(1);
    expect(PORTOS_SCHEMA_VERSIONS.pipelineSeries).toBe(1);
  });

  it('declares mediaCollections layout version', () => {
    expect(PORTOS_SCHEMA_VERSIONS.mediaCollections).toBe(1);
  });
});

describe('buildPortosMeta', () => {
  it('returns { portosVersion, schemaVersions } with the live registry', async () => {
    const meta = await buildPortosMeta();
    expect(meta.portosVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(meta.schemaVersions.universes).toBe(5);
    expect(meta.schemaVersions.pipelineIssues).toBe(1);
    expect(meta.schemaVersions.pipelineSeries).toBe(1);
  });

  it('overrides merge into schemaVersions', async () => {
    const meta = await buildPortosMeta({ schemaVersions: { future: 1 } });
    expect(meta.schemaVersions.universes).toBe(5);
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
