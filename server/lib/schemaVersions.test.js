import { readdirSync, readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';
import { IMAGE_GEN_MODES, VIDEO_GEN_MODES } from './generationModes.js';
import { CREATIVE_MEDIA_SCHEMA_VERSIONS, RENDER_PIN_SENDER_VERSIONS } from './schemaVersions/creativeMedia.js';
import { MUSIC_SCHEMA_VERSIONS } from './schemaVersions/music.js';
import { PLATFORM_SCHEMA_VERSIONS } from './schemaVersions/platform.js';
import { STORY_CANON_SCHEMA_VERSIONS } from './schemaVersions/storyCanon.js';
import {
  PORTOS_SCHEMA_VERSIONS,
  RECORD_KIND_SCHEMA_CATEGORIES,
  compareSchemaVersions,
  scopeVersionDiff,
  formatVersionGap,
  buildPortosMeta,
} from './schemaVersions.js';

const SLICES = {
  'creativeMedia.js': CREATIVE_MEDIA_SCHEMA_VERSIONS,
  'music.js': MUSIC_SCHEMA_VERSIONS,
  'platform.js': PLATFORM_SCHEMA_VERSIONS,
  'storyCanon.js': STORY_CANON_SCHEMA_VERSIONS,
};
const SLICE_FILES = Object.keys(SLICES);

describe('PORTOS_SCHEMA_VERSIONS', () => {
  it('is a frozen object', () => {
    expect(Object.isFrozen(PORTOS_SCHEMA_VERSIONS)).toBe(true);
    expect(() => { PORTOS_SCHEMA_VERSIONS.universes = 999; }).toThrow();
  });

  it('holds only positive integers, since a non-integer silently reads as 0 and skips the gate', () => {
    for (const [category, version] of Object.entries(PORTOS_SCHEMA_VERSIONS)) {
      expect(Number.isInteger(version), category).toBe(true);
      expect(version, category).toBeGreaterThan(0);
    }
  });

  it('requires a supported sender version for every pinnable backend in both record kinds', () => {
    for (const category of ['creativeCommissions', 'fableLoom']) {
      const modes = RENDER_PIN_SENDER_VERSIONS[category];
      // External images cannot be queued or pinned.
      expect(Object.keys(modes.image).sort()).toEqual(IMAGE_GEN_MODES.filter((mode) => mode !== 'external').sort());
      expect(Object.keys(modes.video).sort()).toEqual([...VIDEO_GEN_MODES].sort());
      for (const version of [...Object.values(modes.image), ...Object.values(modes.video)]) {
        expect(Number.isInteger(version)).toBe(true);
        expect(version).toBeGreaterThan(0);
        expect(version).toBeLessThanOrEqual(PORTOS_SCHEMA_VERSIONS[category]);
      }
    }
  });

  it('caps each entry\'s comment block at 6 lines so no slice can regrow history', () => {
    const offenders = [];
    for (const file of SLICE_FILES) {
      const lines = readFileSync(new URL(`./schemaVersions/${file}`, import.meta.url), 'utf8').split('\n');
      const start = lines.findIndex((l) => /^export const \w+_SCHEMA_VERSIONS = Object\.freeze\(\{$/.test(l));
      const end = lines.findIndex((l, i) => i > start && l === '});');
      expect(start, file).toBeGreaterThan(-1);
      expect(end, file).toBeGreaterThan(start);
      let commentLines = 0;
      for (const line of lines.slice(start + 1, end)) {
        if (line.trimStart().startsWith('//')) { commentLines += 1; continue; }
        const entry = line.match(/^ {2}(\w+):/);
        if (entry && commentLines > 6) offenders.push(`${file} ${entry[1]} (${commentLines} lines)`);
        commentLines = 0;
      }
    }
    expect(offenders).toEqual([]);
  });

  // Peers compare the composed map, and syncOrchestrator compares a stored copy by JSON.stringify, so the
  // split (#17460) must keep the shipped keys in their shipped order. A new category appends here on purpose.
  it('composes exactly the shipped categories, in shipped order', () => {
    expect(Object.keys(PORTOS_SCHEMA_VERSIONS)).toEqual([
      'appQuality', 'memoryHistory', 'universes', 'pipelineIssues', 'pipelineSeries', 'mediaCollections', 'videoHistory',
      'decks', 'storyboards', 'authors', 'artists', 'albums', 'tracks', 'catalog', 'storyBuilder', 'fableLoom',
      'creativeDirectorProjects', 'moodBoards', 'writersRoomWorks', 'writersRoomFolders', 'writersRoomExercises',
      'musicVideoProjects', 'commissionFeedback', 'creativeCommissions', 'mediaLibrary', 'cosHistory', 'cosTasks',
      'eidoverseFoundations', 'meatspace', 'peerAuth', 'peerAssetStamps',
    ]);
  });

  it('takes every value from exactly one domain slice, and every slice category is composed', () => {
    const onDisk = readdirSync(new URL('./schemaVersions/', import.meta.url)).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
    expect(onDisk.sort(), 'list a new slice file in SLICES').toEqual([...SLICE_FILES].sort());
    const owners = new Map();
    for (const [file, slice] of Object.entries(SLICES)) {
      expect(Object.isFrozen(slice), file).toBe(true);
      for (const [category, version] of Object.entries(slice)) {
        expect(owners.has(category), `${category} is declared by ${owners.get(category)} and ${file}`).toBe(false);
        owners.set(category, file);
        expect(PORTOS_SCHEMA_VERSIONS[category], `${file} ${category}`).toBe(version);
      }
    }
    expect([...owners.keys()].sort()).toEqual(Object.keys(PORTOS_SCHEMA_VERSIONS).sort());
  });
});

describe('per-category gates against the live registry', () => {
  it('gates a mediaCollections v1 receiver so removal records are refused, not stripped (#12433)', () => {
    const current = PORTOS_SCHEMA_VERSIONS.mediaCollections;
    // A v1 receiver would strip `removedItems` and union the removed item back.
    const v1Receiver = { ...PORTOS_SCHEMA_VERSIONS, mediaCollections: current - 1 };
    const diff = scopeVersionDiff(
      compareSchemaVersions(PORTOS_SCHEMA_VERSIONS, v1Receiver),
      RECORD_KIND_SCHEMA_CATEGORIES.mediaCollection,
    );
    expect(diff.ahead).toEqual([{ category: 'mediaCollections', senderV: current, receiverV: current - 1 }]);
  });

  it('pauses only fableLoom when an older peer is one version behind', () => {
    const current = PORTOS_SCHEMA_VERSIONS.fableLoom;
    const olderPeer = { ...PORTOS_SCHEMA_VERSIONS, fableLoom: current - 1 };
    const diff = compareSchemaVersions(PORTOS_SCHEMA_VERSIONS, olderPeer);
    expect(scopeVersionDiff(diff, RECORD_KIND_SCHEMA_CATEGORIES.fableLoom)).toEqual({
      compatible: false,
      ahead: [{ category: 'fableLoom', senderV: current, receiverV: current - 1 }],
      behind: [],
    });
    expect(scopeVersionDiff(diff, RECORD_KIND_SCHEMA_CATEGORIES.artist).compatible).toBe(true);
  });
});

describe('buildPortosMeta', () => {
  it('gates an older peer on music-video projects, since older builds re-normalize newer fields away', async () => {
    const meta = await buildPortosMeta();
    const current = meta.schemaVersions.musicVideoProjects;
    const olderPeer = { ...meta.schemaVersions, musicVideoProjects: current - 1 };
    expect(scopeVersionDiff(compareSchemaVersions(meta.schemaVersions, olderPeer), RECORD_KIND_SCHEMA_CATEGORIES.musicVideoProject))
      .toMatchObject({ compatible: false, ahead: [{ category: 'musicVideoProjects', senderV: current, receiverV: current - 1 }] });
  });

  it('advertises the Suno song id so an older peer does not strip it from a take', async () => {
    const meta = await buildPortosMeta();
    const current = meta.schemaVersions.tracks;
    const olderPeer = { ...meta.schemaVersions, tracks: current - 1 };
    const diff = compareSchemaVersions(meta.schemaVersions, olderPeer);
    expect(scopeVersionDiff(diff, RECORD_KIND_SCHEMA_CATEGORIES.track)).toEqual({
      compatible: false,
      ahead: [{ category: 'tracks', senderV: current, receiverV: current - 1 }],
      behind: [],
    });
    // This upgrade pauses only tracks; unrelated artist/album sync still works.
    expect(scopeVersionDiff(diff, RECORD_KIND_SCHEMA_CATEGORIES.artist).compatible).toBe(true);
    expect(scopeVersionDiff(diff, RECORD_KIND_SCHEMA_CATEGORIES.album).compatible).toBe(true);
  });

  it('returns { portosVersion, schemaVersions } with the live registry', async () => {
    const meta = await buildPortosMeta();
    expect(meta.portosVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(meta.schemaVersions).toEqual(PORTOS_SCHEMA_VERSIONS);
  });

  it('overrides merge into schemaVersions', async () => {
    const meta = await buildPortosMeta({ schemaVersions: { future: 1 } });
    expect(meta.schemaVersions.universes).toBe(PORTOS_SCHEMA_VERSIONS.universes);
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
      {
        universes: PORTOS_SCHEMA_VERSIONS.universes,
        pipelineSeries: 2,
        pipelineIssues: 3,
        mediaCollections: PORTOS_SCHEMA_VERSIONS.mediaCollections + 1,
      },
      PORTOS_SCHEMA_VERSIONS,
    );
    expect(union.compatible).toBe(false);
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
