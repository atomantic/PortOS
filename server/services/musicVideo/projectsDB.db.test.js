/**
 * PostgreSQL-backed round-trip for the Music Video project store.
 *
 * This suite runs only through the dedicated test database config. It keeps the
 * fixture ids isolated and uses a temporary data root so the prune assertion
 * can verify the conflict-journal side-store write without touching a live
 * install's files.
 */

import { describe, it, expect, vi, afterAll, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'path';
import { captureClipReferenceDependency, captureMusicVideoEvidence, musicVideoDependencyImpact } from '../../lib/musicVideo/musicVideoDependencies.js';
import { musicVideoClipReferenceChoices } from '../../lib/musicVideo/musicVideoConditioning.js';
import { checkHealth, ensureSchema, query, close } from '../../lib/db.js';
import * as database from '../../lib/db.js';
import { toPgJson } from '../../lib/pgJson.js';
import { compareMusicVideoProjectsNewestFirst } from '../../lib/musicVideo/musicVideoSummary.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { getSyncBaseHash, __resetBaseHashCacheForTests } from '../../lib/conflictJournal.js';

const testState = vi.hoisted(() => ({ dataRoot: null, writeCounter: { baseHash: 0 } }));

vi.mock('../../lib/paths.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  testState.dataRoot ??= mkdtempSync(join(tmpdir(), 'music-video-projects-db-test-'));
  return {
    ...actual,
    PATHS: { ...actual.PATHS, data: testState.dataRoot, images: join(testState.dataRoot, 'images') },
  };
});

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    atomicWrite: async (path, data) => {
      if (typeof path === 'string' && path.endsWith('sync_base_hashes.json')) testState.writeCounter.baseHash += 1;
      return actual.atomicWrite(path, data);
    },
  };
});

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    const probe = await query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'music_video_projects') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'music_video_projects table not present';
  }
}

const runDb = requireDbOrSkip('services/musicVideo/projectsDB.db.test', dbReady, skipReason);
const { applySceneUpdate } = await import('./projectsLogic.js');
const { appendSceneTakes } = await import('./takes.js');

afterAll(() => rmSync(testState.dataRoot, { recursive: true, force: true }));

const PRUNE_PREFIX = 'mv-issue-5532-prune-';
const project = (id, deletedAt) => ({
  id,
  name: id,
  status: 'draft',
  scenes: [],
  createdAt: deletedAt,
  updatedAt: deletedAt,
  deleted: true,
  deletedAt,
});

describe.skipIf(!runDb)('music video projects DB adapter', () => {
  let db;
  const catalogFixtures = [];

  beforeAll(async () => { db = await import('./projectsDB.js'); });

  beforeEach(async () => {
    await query(`DELETE FROM music_video_projects`);
    rmSync(join(testState.dataRoot, 'sharing'), { recursive: true, force: true });
    rmSync(join(testState.dataRoot, 'conflict-journal'), { recursive: true, force: true });
    __resetBaseHashCacheForTests();
    testState.writeCounter.baseHash = 0;
  });

  afterAll(async () => {
    for (const id of catalogFixtures) await query('DELETE FROM catalog_ingredients WHERE id = $1', [id]);
    await query(`DELETE FROM music_video_projects WHERE id LIKE $1`, [`${PRUNE_PREFIX}%`]).catch(() => {});
    await close();
  });

  it('commits a linked description with the project and rolls both back on a later failure', async () => {
    const catalog = await import('../catalog/catalogDB.js');
    const { syncEditedSubjectDescriptions } = await import('./subjectDescriptionSync.js');
    const id = `cat-obj-test-${randomUUID()}`;
    catalogFixtures.push(id);
    await catalog.createIngredient({ id, type: 'object', name: 'Example prop', payload: { description: 'Old description' }, embedding: Array(768).fill(0.01), embeddingModel: 'example-model' });
    const subject = { id: 'prop', kind: 'object', name: 'Example prop', ingredientId: id, description: 'Old description' };
    const created = await db.createProject({ name: 'Description transaction fixture', concept: { subjects: [subject] } });
    const edit = (current, description) => ({ ...current, concept: { ...current.concept, subjects: [{ ...current.concept.subjects[0], description }] } });
    await db.mutateProjectRecord(created.id, (current, { client }) => syncEditedSubjectDescriptions(current, edit(current, 'New description'), {
      client, bases: [{ subjectId: 'prop', description: 'Old description' }],
    }));
    expect((await db.getProject(created.id)).concept.subjects[0].description).toBe('New description');
    expect(await catalog.getIngredient(id)).toMatchObject({ payload: { description: 'New description' }, embedding: null, embeddingModel: null });

    await expect(db.mutateProjectRecord(created.id, async (current, { client }) => {
      await syncEditedSubjectDescriptions(current, edit(current, 'Not committed'), {
        client, bases: [{ subjectId: 'prop', description: 'New description' }],
      });
      throw new Error('fixture failure');
    })).rejects.toThrow('fixture failure');
    expect((await db.getProject(created.id)).concept.subjects[0].description).toBe('New description');
    expect((await catalog.getIngredient(id)).payload.description).toBe('New description');
  });

  it('reads a newer catalog description and saves a video edit without overwriting a later catalog edit', async () => {
    vi.doMock('../../lib/pgFileFacade.js', async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual, createRecordStoreBackendSelector: (options) => actual.createRecordStoreBackendSelector(
        options.label === 'Music Video' ? { ...options, isTestMode: () => false } : options,
      ) };
    });
    const service = await import('./projects.js');
    const catalog = await import('../catalog/catalogDB.js');
    const id = `cat-obj-test-${randomUUID()}`;
    catalogFixtures.push(id);
    await catalog.createIngredient({ id, type: 'object', name: 'Example prop', payload: { description: 'Original' } });
    const subject = { id: 'prop', kind: 'object', name: 'Example prop', ingredientId: id, description: 'Original' };
    const created = await db.createProject({ name: 'Linked description fixture', concept: { subjects: [subject, { ...subject, id: 'prop-copy', description: 'Older snapshot' }] } });
    const otherVideo = await db.createProject({ name: 'Another linked video', concept: { subjects: [subject] } });
    await catalog.updateIngredientPayloadKeys(id, () => ({ description: 'Catalog edit' }));
    const current = await service.getProject(created.id);
    expect(current.concept.subjects[0].description).toBe('Catalog edit');
    expect((await db.getProject(created.id)).concept.subjects[0].description).toBe('Original');

    const nextSubject = { ...current.concept.subjects[0], description: 'Video edit' };
    await service.updateProject(created.id, { concept: { subjects: [nextSubject, current.concept.subjects[1]] }, catalogDescriptionBases: [{ subjectId: 'prop', description: 'Catalog edit' }] });
    expect((await catalog.getIngredient(id)).payload.description).toBe('Video edit');
    expect((await db.getProject(created.id)).concept.subjects[0].description).toBe('Video edit');
    expect((await db.getProject(created.id)).concept.subjects[1].description).toBe('Older snapshot');
    expect((await service.getProject(created.id)).concept.subjects[1].description).toBe('Video edit');
    expect((await service.getProject(otherVideo.id)).concept.subjects[0].description).toBe('Video edit');
    expect((await db.getProject(otherVideo.id)).concept.subjects[0].description).toBe('Original');
    expect((await service.listProjects()).find((item) => item.id === otherVideo.id).concept.subjects[0].description).toBe('Video edit');
    await catalog.updateIngredientPayloadKeys(id, () => ({ description: 'Later catalog edit' }));
    await expect(service.updateProject(created.id, { concept: { subjects: [{ ...nextSubject, description: 'Stale video edit' }] },
      catalogDescriptionBases: [{ subjectId: 'prop', description: 'Video edit' }] })).rejects.toMatchObject({ code: 'CATALOG_DESCRIPTION_CONFLICT' });
    expect((await catalog.getIngredient(id)).payload.description).toBe('Later catalog edit');
    expect((await service.getProject(created.id)).concept.subjects[0].description).toBe('Later catalog edit');

    const { restoreVideoSubjectDescription } = await import('./catalogCast.js');
    await expect(restoreVideoSubjectDescription(created.id, { subjectId: 'prop', ingredientId: id,
      videoDescription: 'Video edit', catalogDescription: 'Stale catalog value' })).rejects.toMatchObject({ code: 'CATALOG_DESCRIPTION_CONFLICT' });
    await restoreVideoSubjectDescription(created.id, { subjectId: 'prop', ingredientId: id,
      videoDescription: 'Video edit', catalogDescription: 'Later catalog edit' });
    expect((await catalog.getIngredient(id)).payload.description).toBe('Video edit');
    expect((await service.getProject(created.id)).concept.subjects[0].description).toBe('Video edit');
  });

  it('preserves a festival packet through PG saves, kit updates and legacy peer edits', async () => {
    const packet = { version: 1, fields: { title: 'Festival edition' }, rights: 'unknown', musicRights: 'unknown', consent: 'unknown', festivals: [], include: ['title'] };
    const created = await db.createProject({ name: 'Festival fixture', festivalPacket: packet });
    expect((await db.getProject(created.id)).festivalPacket).toEqual(packet);
    await db.updateProject(created.id, { name: 'Edited name' });
    await db.mutateProjectRecord(created.id, current => ({ project: { ...current, publishKit: { builtAt: '2026-01-01' } } }));
    const saved = await db.getProject(created.id);
    const { festivalPacket: _packet, ...legacy } = saved;
    await db.mergeProjectsFromSync([{ ...legacy, updatedAt: '2099-01-01T00:00:00.000Z' }]);
    expect((await db.getProject(created.id)).festivalPacket).toEqual(packet);
    await db.updateProject(created.id, { festivalPacket: { ...packet, fields: { title: 'Revised packet' } } });
    expect((await db.getProject(created.id)).festivalPacket.fields.title).toBe('Revised packet');
  });

  it('round-trips dependency evidence and selective invalidation through PostgreSQL and peer merge', async () => {
    const created = await db.createProject({ name: 'Example dependency record' });
    await db.updateProject(created.id, { scenes: [{ sceneId: 'a', startSec: 0, endSec: 5, referenceImageId: 'plate.png', videoHistoryId: null, takes: [] }] });
    await db.mutateProjectRecord(created.id, (current) => appendSceneTakes(current, 'a', [
      { kind: 'video', assetId: 'clip-example', source: 'generated', sourceImageId: 'plate.png' },
    ]));
    const before = await db.getProject(created.id);
    await db.mutateProjectRecord(created.id, (current) => ({ project: { ...current, excerpts: [{ id: 'excerpt-example', status: 'complete', dependencies: captureMusicVideoEvidence(before) }] } }));
    await db.mutateProjectRecord(created.id, (current) => applySceneUpdate(current, 'a', { referenceImageId: 'new-plate.png' }));
    const stale = await db.getProject(created.id);
    expect(musicVideoDependencyImpact(stale).shots.map((shot) => shot.sceneId)).toEqual(['a']);
    expect(stale.excerpts[0].dependencies.version).toBe(1);
    const remote = { ...stale, id: 'mv-peer-example', updatedAt: '2099-01-01T00:00:00.000Z' };
    await db.mergeProjectsFromSync([remote]);
    const synced = await db.getProject(remote.id);
    expect(synced.scenes[0].takes[0].dependencies).toEqual(stale.scenes[0].takes[0].dependencies);
    expect(musicVideoDependencyImpact(synced).shots).toEqual(musicVideoDependencyImpact(stale).shots);
  });

  it('migrates legacy tool intent identically in PostgreSQL and files without replacing assets or timestamps', async () => {
    const { mkdir, readFile, writeFile } = await import('node:fs/promises');
    const { default: migration } = await import('../../../scripts/migrations/421-music-video-media-modes.js');
    const records = [
      { id: 'mv-migration-top-level', tools: ['code:render'] },
      { id: 'mv-migration-nested', automation: { tools: ['code:render'] } },
      { id: 'mv-migration-override', tools: ['code:render'], automation: { tools: ['image:local'] } },
      { id: 'mv-migration-explicit', mediaMode: 'code-images', tools: ['code:render'] },
    ].map((record) => ({ ...record, scenes: [{ referenceImageId: 'historical-example.png' }], updatedAt: '2026-01-01T00:00:00.000Z' }));
    const rootDir = join(testState.dataRoot, 'migration-fixture');
    const file = join(rootDir, 'data', 'music-video-projects.json');
    await mkdir(join(rootDir, 'data'), { recursive: true });
    await writeFile(file, JSON.stringify(records));
    for (const record of records) {
      await query(`INSERT INTO music_video_projects (id, status, data, created_at, updated_at)
        VALUES ($1, 'draft', $2::jsonb, $3, $3)`, [record.id, JSON.stringify(record), record.updatedAt]);
    }
    const { up: upDb } = await import('../../scripts/db-migrations/015-music-video-media-modes.js');
    await migration.up({ rootDir });
    await migration.up({ rootDir });
    await upDb({ query });
    await upDb({ query });
    const expected = records.map((record, index) => ({ ...record, mediaMode: ['code-only', 'code-only', 'code-images-video', 'code-images'][index] }));
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(expected);
    for (const record of expected) {
      const { rows: [stored] } = await query('SELECT data, updated_at FROM music_video_projects WHERE id = $1', [record.id]);
      expect(stored.data).toEqual(record);
      expect(new Date(stored.updated_at).toISOString()).toBe(record.updatedAt);
    }
  });

  it('backfills a missing JSONB id from the primary-key column', async () => {
    const id = `${PRUNE_PREFIX}legacy-no-json-id`;
    await query(
      `INSERT INTO music_video_projects (id, status, data, created_at, updated_at, deleted)
       VALUES ($1, 'draft', $2::jsonb, now(), now(), FALSE)`,
      [id, JSON.stringify({ name: 'Legacy row', status: 'draft', scenes: [] })],
    );

    expect(await db.getProject(id)).toMatchObject({ id, name: 'Legacy row' });
    expect((await db.listProjects()).find((item) => item.name === 'Legacy row')?.id).toBe(id);
  });

  it('projects only MIDI source fields in PostgreSQL with file-adapter parity', async () => {
    const file = await import('./projectsFile.js');
    const records = [
      {
        id: `${PRUNE_PREFIX}midi-archived`, name: 'Archived', trackId: 'track-a', status: 'archived',
        midiTranscription: { filename: 'archived.mid', model: null, report: 'x'.repeat(128 * 1024) },
        concept: { subjects: [{ ingredientId: 'cat-example' }] },
        scenes: Array.from({ length: 100 }, (_, i) => ({
          sceneId: `scene-${i}`, takes: [{ prompt: 'Example take history. '.repeat(500) }],
        })),
      },
      {
        id: `${PRUNE_PREFIX}midi-current`, name: null, trackId: 'track-b',
        midiTranscription: { filename: 'current.mid', createdAt: null },
      },
      { id: `${PRUNE_PREFIX}midi-deleted`, trackId: 'track-a', midiTranscription: { filename: 'deleted.mid' }, deleted: true },
      { id: `${PRUNE_PREFIX}midi-no-file`, trackId: 'track-c', midiTranscription: { model: 'medium' } },
      { id: `${PRUNE_PREFIX}midi-no-track`, midiTranscription: { filename: 'unlinked.mid' } },
    ];
    await writeFile(join(testState.dataRoot, 'music-video-projects.json'), toPgJson(records));
    for (const [i, { id, ...record }] of [...records.entries()].reverse()) {
      // Legacy JSONB rows may rely on the table's id. Insertion order is deliberately reversed.
      await query(`INSERT INTO music_video_projects (id, status, data, created_at, deleted)
        VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [id, record.status ?? 'draft', toPgJson(record), `2026-01-0${i + 1}`, record.deleted ?? false]);
    }
    const read = vi.spyOn(database, 'query');
    try {
      const projected = await db.listMidiSourceRows();
      expect(projected).toStrictEqual([
        {
          id: records[0].id, name: 'Archived', trackId: 'track-a',
          midiTranscription: { filename: 'archived.mid', model: null, createdAt: undefined },
        },
        {
          id: records[1].id, name: null, trackId: 'track-b',
          midiTranscription: { filename: 'current.mid', model: undefined, createdAt: null },
        },
      ]);
      expect(await file.listMidiSourceRows()).toStrictEqual(projected);
      expect(read).toHaveBeenCalledTimes(1);
      const { rows } = await read.mock.results[0].value;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(['createdAt', 'filename', 'id', 'model', 'name', 'projectId', 'trackId']);
      }
    } finally {
      read.mockRestore();
    }
  });

  it('loads a family page as just version names and ids, skipping tombstones', async () => {
    const records = [
      [{ id: 'mv-root', name: 'Original' }, '2026-01-01', false],
      [{ id: 'mv-fork', rootProjectId: 'mv-root', name: 'Renamed fork', version: 2, scenes: [{ prompt: 'unused' }] }, '2026-02-01', false],
      [{ id: 'mv-deleted', rootProjectId: 'mv-root', name: 'Deleted', version: 3 }, '2026-03-01', true],
      [{ id: 'mv-other', name: 'Other' }, '2026-04-01', false],
    ];
    for (const [record, createdAt, deleted] of records) {
      await query(`INSERT INTO music_video_projects (id, data, created_at, deleted)
        VALUES ($1, $2::jsonb, $3, $4)`, [record.id, toPgJson(record), createdAt, deleted]);
    }
    expect(await db.listProjectVersionPage('mv-root', { limit: 1, offset: 0 })).toEqual({
      limit: 1, offset: 0, total: 2,
      items: [{ id: 'mv-fork', name: 'Renamed fork', version: 2, rootProjectId: 'mv-root' }],
    });
    expect(await db.listProjectVersionPage('mv-root', { limit: 1, offset: 1 })).toEqual({
      limit: 1, offset: 1, total: 2,
      items: [{ id: 'mv-root', name: 'Original', version: 1, rootProjectId: 'mv-root' }],
    });
    expect(await db.listProjectVersionPage('mv-root', { limit: 1, offset: 2 }))
      .toEqual({ limit: 1, offset: 2, total: 2, items: [] });
  });

  it('hydrates only a requested page while preserving legacy timestamp fallbacks and excluding tombstones', async () => {
    const records = Array.from({ length: 20 }, (_, i) => ({ id: `mv-page-${i}`,
      createdAt: i === 19 ? null : `2026-01-${String(i + 1).padStart(2, '0')}`,
      updatedAt: `2026-02-${String(i + 1).padStart(2, '0')}`,
      name: `Example ${i}`,
      composition: { document: { source: 'x'.repeat(128 * 1024) } } }));
    for (const record of records) {
      await query(`INSERT INTO music_video_projects (id, status, data, created_at, updated_at, deleted)
        VALUES ($1, 'draft', $2::jsonb, '2026-01-01', '2026-01-01', $3)`,
      [record.id, toPgJson(record), record.id === 'mv-page-18']);
    }
    const read = vi.spyOn(database, 'query');
    try {
      const all = await db.listProjects();
      const baselineCalls = [...read.mock.calls];
      read.mockClear();
      const expected = [...all].sort(compareMusicVideoProjectsNewestFirst);
      expect(expected[0].id).toBe('mv-page-19');
      const page = await db.listProjectPage({ limit: 1, offset: 0, compare: compareMusicVideoProjectsNewestFirst });
      expect(page).toEqual({ items: expected.slice(0, 1), total: 19, limit: 1, offset: 0 });
      const rows = (await Promise.all(read.mock.results.map(result => result.value))).flatMap(result => result.rows);
      expect(rows.filter(row => row.data).map(row => row.id)).toEqual([expected[0].id]);
      expect(read.mock.calls[0][0]).not.toMatch(/\bdata\b/);
      if (process.env.PORTOS_COLLECTION_BENCHMARK === '1') {
        process.stdout.write(JSON.stringify({ projects: all.length, fullBytes: Buffer.byteLength(toPgJson(all)),
          pageReadBytes: Buffer.byteLength(toPgJson(rows)), hydratedProjects: rows.filter(row => row.data).length }) + '\n');
        const calls = [...baselineCalls, ...read.mock.calls];
        for (const [sql, params] of calls) {
          const { rows: explained } = await query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
          const plan = explained[0]['QUERY PLAN'][0];
          process.stdout.write(JSON.stringify({ operation: sql.includes('ANY') ? 'page' : sql.includes('AS "createdAt"') ? 'headers' : 'full',
            node: plan.Plan['Node Type'], executionMs: plan['Execution Time'], rows: plan.Plan['Actual Rows'],
            tempReadBlocks: plan.Plan['Temp Read Blocks'], tempWrittenBlocks: plan.Plan['Temp Written Blocks'] }) + '\n');
        }
      }
      expect(await db.listProjectPage({ limit: 1, offset: 19, compare: compareMusicVideoProjectsNewestFirst }))
        .toEqual({ items: [], total: 19, limit: 1, offset: 19 });
      read.mockClear();
      expect((await db.listProjectPage({ limit: 2, offset: 1 })).items).toEqual(all.slice(1, 3));
      const [pageSql, pageParams] = read.mock.calls[0];
      expect(pageSql).not.toMatch(/\bdata\b/);
      expect(pageParams).toEqual([2, 1]);

      expect(await db.listProjectNames()).toContainEqual({ id: 'mv-page-19', name: 'Example 19' });
    } finally {
      read.mockRestore();
    }
  });

  it('reads affected completion only after committed catalog media changes', async () => {
    const [catalog, { catalogEvents }, { withCatalogCheckin }, { readProjectCompletion }] = await Promise.all([
      import('../catalog/catalogDB.js'), import('../catalog/catalogEvents.js'), import('./catalogCheckin.js'), import('./projectPresentation.js'),
    ]);
    const id = `cat-obj-test-${randomUUID()}`;
    catalogFixtures.push(id);
    await catalog.createIngredient({ id, type: 'object', name: 'Example prop' });
    const images = join(testState.dataRoot, 'images');
    await mkdir(images, { recursive: true });
    await Promise.all(['original.png', 'replacement.png'].map(name => writeFile(join(images, name), 'fixture')));
    await catalog.setPortraitMedia(id, 'original.png');
    const scene = { sceneId: 'example-shot', startSec: 0, endSec: 4, videoHistoryId: 'clip', takes: [] };
    const project = {
      id: 'mv-catalog-completion', name: 'Example Video', status: 'complete', scenes: [scene], renderHistoryId: 'final',
      concept: { subjects: [{ id: 'prop', kind: 'object', name: 'Example prop', ingredientId: id }] },
      castAndSets: { source: 'catalog' },
    };
    const presented = await withCatalogCheckin(project);
    expect(presented.castAndSets.catalogCheckin).toMatchObject({ problems: [], items: [{ images: ['original.png'] }] });
    scene.clipReferenceIds = [musicVideoClipReferenceChoices(presented, scene)[0].id];
    scene.takes = [{ kind: 'video', assetId: 'clip', dependencies: {
      version: 1, references: [captureClipReferenceDependency(presented, scene)],
    } }];
    project.renderDependencies = captureMusicVideoEvidence(presented);
    await query(`INSERT INTO music_video_projects (id, status, data, created_at, updated_at)
      VALUES ($1, 'complete', $2::jsonb, now(), now())`, [project.id, toPgJson(project)]);
    expect(await db.listCompletionCandidateIds()).toEqual([project.id]);
    expect(await db.listCompletionCandidateIds(['cat-unrelated'])).toEqual([]);
    const named = await db.listProjectPage({ limit: 1, filter: ({ status, name }) => status === 'complete' && name === project.name });
    expect(named).toMatchObject({ total: 1, items: [{ id: project.id }] });
    const read = async () => {
      const [affectedId] = await db.listCompletionCandidateIds([id]);
      expect(affectedId).toBe(project.id);
      return readProjectCompletion(await db.getProject(affectedId), { requireCatalog: true });
    };
    expect(await read()).toBe(true);

    const observed = [];
    const onChanged = ({ ingredientId }) => {
      if (ingredientId === id) observed.push(read());
    };
    catalogEvents.on('assets-changed', onChanged);
    try {
      await expect(database.withTransaction(async client => {
        await catalog.setPortraitMedia(id, 'replacement.png', { client });
        expect(observed).toHaveLength(0);
        throw new Error('Rollback fixture');
      })).rejects.toThrow('Rollback fixture');
      expect(observed).toHaveLength(0);
      expect(await read()).toBe(true);

      await database.withTransaction(async client => {
        await catalog.setPortraitMedia(id, 'replacement.png', { client });
        expect(observed).toHaveLength(0);
      });
      expect(await Promise.all(observed)).toEqual([false]);
      await catalog.setPortraitMedia(id, 'original.png');
      expect(await Promise.all(observed)).toEqual([false, true]);
    } finally {
      catalogEvents.off('assets-changed', onChanged);
      await query('DELETE FROM music_video_projects WHERE id = $1', [project.id]);
    }
  });

  it('lists live project names without the record bodies', async () => {
    const live = await db.createProject({ name: 'Example Video' });
    const gone = await db.createProject({ name: 'Deleted Video' });
    await db.deleteProject(gone.id);
    expect(await db.listProjectNames()).toEqual([{ id: live.id, name: 'Example Video' }]);
  });

  it('rejects persistence when the project id is missing', async () => {
    await expect(db.persist(query, { name: 'Missing id' })).rejects.toMatchObject({ code: 'PROJECT_ID_MISSING' });
  });

  it('rejects a mutator against a tombstoned project', async () => {
    const created = await db.createProject({ name: 'Doomed' });
    await db.deleteProject(created.id);
    await expect(db.updateProject(created.id, { name: 'Zombie' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('same-updatedAt re-push does not persist or rewrite the base hash', async () => {
    const remote = {
      id: `${PRUNE_PREFIX}same-timestamp`, name: 'Same', status: 'draft', scenes: [],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      deleted: false, deletedAt: null,
    };
    await db.mergeProjectsFromSync([remote]);
    const before = await query(`SELECT xmin::text AS version FROM music_video_projects WHERE id = $1`, [remote.id]);
    testState.writeCounter.baseHash = 0;

    expect(await db.mergeProjectsFromSync([remote])).toEqual({ applied: false, count: 0 });
    const after = await query(`SELECT xmin::text AS version FROM music_video_projects WHERE id = $1`, [remote.id]);
    expect(after.rows[0].version).toBe(before.rows[0].version);
    expect(testState.writeCounter.baseHash).toBe(0);
  });

  it('pruneTombstonedProjects batches base-hash eviction for multiple tombstones', async () => {
    const oldOne = project(`${PRUNE_PREFIX}old-1`, '2000-01-01T00:00:00.000Z');
    const oldTwo = project(`${PRUNE_PREFIX}old-2`, '2000-01-02T00:00:00.000Z');
    const newer = project(`${PRUNE_PREFIX}new`, '2099-01-01T00:00:00.000Z');
    await db.mergeProjectsFromSync([oldOne, oldTwo, newer]);
    expect(await getSyncBaseHash('musicVideoProject', oldOne.id)).not.toBeNull();
    expect(await getSyncBaseHash('musicVideoProject', oldTwo.id)).not.toBeNull();

    testState.writeCounter.baseHash = 0;
    const result = await db.pruneTombstonedProjects(Date.parse('2030-01-01T00:00:00.000Z'));
    expect(result).toEqual({ pruned: 2 });
    expect(testState.writeCounter.baseHash).toBe(1);
    __resetBaseHashCacheForTests();
    expect(await getSyncBaseHash('musicVideoProject', oldOne.id)).toBeNull();
    expect(await getSyncBaseHash('musicVideoProject', oldTwo.id)).toBeNull();
    expect(await db.getProject(newer.id, { includeDeleted: true })).not.toBeNull();
    expect(await db.getProject(oldOne.id, { includeDeleted: true })).toBeNull();
  });
});
