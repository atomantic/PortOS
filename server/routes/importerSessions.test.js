/**
 * HTTP-level proof of the import-session contract (#9943): a repeated
 * `POST /api/importer/commit` with the same import id creates nothing new, and
 * a re-analyze after the client lost its state reports the committed session.
 *
 * Mounts the real router over the real services (importer, series, issues,
 * session store) with only the data root and the LLM runner doubled, so the
 * assertions are about persisted records, not mock calls. The service-level
 * matrix (resume, stale session, concurrency) lives in services/importer.test.js.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import {
  makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots, mockNoPeers, mockNoPeerSync,
} from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-importer-sessions-') }));
vi.mock('../services/instances.js', () => mockNoPeers());
vi.mock('../services/sharing/peerSync.js', () => mockNoPeerSync());

const canon = { characters: [{ name: 'Aria', role: 'protagonist' }], places: [], objects: [] };
const arc = { logline: 'A logline.', summary: 'A summary.', shape: 'man-in-hole', seasons: [] };
const issues = { issues: [{ title: 'Cold Iron', arcPosition: 1, proseExcerpt: 'The vault loomed.' }] };

vi.mock('../services/stageRunner.js', () => ({
  tryReadFile: vi.fn().mockResolvedValue(null),
  runStagedLLM: vi.fn(async (stage) => ({
    content: { 'importer-canon-extract': canon, 'importer-arc-extract': arc, 'importer-issue-proposal': issues }[stage],
    model: 'mock', providerId: 'mock', runId: `run-${stage}`,
  })),
}));

const importerRoutes = (await import('../routes/importer.js')).default;
const issuesSvc = await import('../services/pipeline/issues.js');

afterAll(cleanupTempDataRoots);

const app = express();
app.use(express.json());
app.use('/api/importer', importerRoutes);
app.use(errorMiddleware);

const analyze = (source) => request(app).post('/api/importer/analyze').send({
  universeName: 'Route Universe', seriesName: 'Route Series', contentType: 'short-story', source,
});
const commit = (preview) => request(app).post('/api/importer/commit').send({
  universeId: preview.universe.id,
  seriesId: preview.series.id,
  importId: preview.importId,
  arc: { logline: 'A logline.', summary: 'A summary.', shape: 'man-in-hole' },
  issues: preview.issueProposals,
});

describe('POST /api/importer/commit with an import id', () => {
  it('creates nothing on a repeat, including after a re-analyze that has no client state', async () => {
    const first = await analyze('The vault loomed in the dark.');
    expect(first.status).toBe(200);
    expect(first.body.importId).toMatch(/^imp-[0-9a-f]{32}$/);
    expect(first.body.importSession).toBeNull();

    const committed = await commit(first.body);
    expect(committed.status).toBe(200);
    expect(committed.body.createdIssueIds).toHaveLength(1);
    expect(committed.body.replayed).toBeUndefined();

    const repeat = await commit(first.body);
    expect(repeat.status).toBe(200);
    expect(repeat.body.replayed).toBe(true);
    expect(repeat.body.createdIssueIds).toEqual(committed.body.createdIssueIds);

    // The "reload": nothing carried over but the manuscript text.
    const reanalyzed = await analyze('The vault loomed in the dark.');
    expect(reanalyzed.body.importId).toBe(first.body.importId);
    expect(reanalyzed.body.importSession).toEqual({
      status: 'committed', createdIssueIds: committed.body.createdIssueIds,
    });
    const afterReload = await commit(reanalyzed.body);
    expect(afterReload.body.replayed).toBe(true);

    expect(await issuesSvc.listIssues({ seriesId: first.body.series.id })).toHaveLength(1);
  });

  it('rejects a malformed import id at the Zod layer', async () => {
    const res = await request(app).post('/api/importer/commit').send({
      universeId: 'u', seriesId: 's', importId: 'not-an-import-id', issues: [{ title: 'x' }],
    });
    expect(res.status).toBe(400);
  });
});
