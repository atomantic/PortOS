import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planImageRenderBackfill, applyImageRenderBackfill } from './imageRenderBackfill.js';
import { codexRenderReceipt, getImageRenderUsage, readRenderReceipts, recordRenderReceipt, codexDriverReportedTokens } from './imageRenderUsage.js';

let root, directory;
const session = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const meta = (extra = {}) => ({ mode: 'codex', id, codexSessionId: session, model: 'example-driver', createdAt: '2026-07-01T12:00:00Z', prompt: 'Private example prompt', ...extra });
const sidecar = (name, row) => writeFile(join(root, 'images', `${name}.metadata.json`), JSON.stringify(row));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'image-usage-'));
  directory = join(root, 'image-render-usage');
  await mkdir(join(root, 'images'));
  await writeFile(join(root, 'usage.json'), '{"existing":"preserve exactly"}');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('saved Codex image usage recovery', () => {
  it('deduplicates repeated outputs and derived copies, groups sessions, and preserves token history across repeated applies', async () => {
    await sidecar('original', meta());
    await sidecar('duplicate', meta());
    await sidecar('second-output', meta({ id: otherId }));
    await sidecar('derived', meta({ cleanedFrom: 'original.png' }));
    await sidecar('import', meta({ sourceFilename: 'original.png', codexSessionId: null }));
    await sidecar('missing-date', meta({ createdAt: null }));
    await sidecar('other-provider', { mode: 'agy' });
    await writeFile(join(root, 'media-jobs.json'), JSON.stringify({ jobs: [{ kind: 'image', status: 'completed', params: { mode: 'codex' }, result: { filename: 'original.png', generationId: id }, startedAt: '2026-07-01T12:00:00Z' }] }));
    const plan = await planImageRenderBackfill(root);
    expect(plan.coverage).toMatchObject({ eligibleOutputs: 2, renderGroups: 1, duplicates: 1, derived: 2, unrecoverable: 1, queueOnly: 0 });
    expect(JSON.stringify(plan)).not.toContain('Private example prompt');
    expect(await readdir(root)).not.toContain('image-render-usage');
    const applied = await applyImageRenderBackfill(root, plan, join(root, 'journal.json'));
    expect(applied.inserted).toBe(2);
    expect((await applyImageRenderBackfill(root, plan, join(root, 'second-journal.json'))).inserted).toBe(0);
    expect(await getImageRenderUsage({ directory, from: '2026-07-01', to: '2026-07-01' })).toMatchObject({ renderGroups: 1, codexSessions: 1, jobIdentityGroups: 0, savedOutputs: 2, imageTokens: null, imageCostUsd: null, allowanceUnits: null, driverTokens: null });
    expect(await getImageRenderUsage({ directory, from: '2026-07-02' })).toMatchObject({ renderGroups: 0, savedOutputs: 0 });
    expect(await readFile(join(root, 'usage.json'), 'utf8')).toBe('{"existing":"preserve exactly"}');
    const journal = JSON.parse(await readFile(join(root, 'journal.json'), 'utf8'));
    expect((await readRenderReceipts({ directory })).every(row => row.backfillBatch === journal.batch)).toBe(true);
  });

  it('counts a session spanning midnight only in its original period and refuses changed dry-run inputs', async () => {
    await sidecar('first', meta({ createdAt: '2026-07-01T23:59:59Z' }));
    const oldPlan = await planImageRenderBackfill(root);
    await sidecar('next', meta({ id: otherId, createdAt: '2026-07-02T00:00:01Z' }));
    await expect(applyImageRenderBackfill(root, oldPlan, join(root, 'journal.json'))).rejects.toThrow('inventory changed');
    const plan = await planImageRenderBackfill(root);
    await applyImageRenderBackfill(root, plan, join(root, 'journal.json'));
    expect(await getImageRenderUsage({ directory, from: '2026-07-01', to: '2026-07-01' })).toMatchObject({ renderGroups: 1, savedOutputs: 2 });
    expect(await getImageRenderUsage({ directory, from: '2026-07-02' })).toMatchObject({ renderGroups: 0, savedOutputs: 0 });
  });

  it('publishes complete receipts exactly once across simultaneous writers and does not replace a live receipt during backfill', async () => {
    const receipt = codexRenderReceipt(meta({ driverReportedTokens: codexDriverReportedTokens('result\ntokens used\n1,234\n') }));
    expect((await Promise.all(Array.from({ length: 8 }, () => recordRenderReceipt(receipt, { directory })))).filter(Boolean)).toHaveLength(1);
    await sidecar('original', meta());
    const plan = await planImageRenderBackfill(root);
    expect(plan.coverage.alreadyRecorded).toBe(1);
    expect((await applyImageRenderBackfill(root, plan, join(root, 'journal.json'))).inserted).toBe(0);
    expect(await readRenderReceipts({ directory })).toEqual([receipt]);
    expect(await getImageRenderUsage({ directory })).toMatchObject({ driverTokens: { reportedTotal: 1234, sessionsMeasured: 1 }, driverSessionsUnknown: 0, imageCostUsd: null });
    expect(codexDriverReportedTokens('no footer')).toBeNull();
  });

  it('does not count a live receipt again when only completed queue metadata remains', async () => {
    await recordRenderReceipt(codexRenderReceipt(meta()), { directory });
    await writeFile(join(root, 'media-jobs.json'), JSON.stringify({ jobs: [
      { kind: 'image', status: 'completed', params: { mode: 'codex' }, result: { filename: 'deleted.png', generationId: id }, startedAt: '2026-07-01T12:00:00Z' },
    ] }));
    const plan = await planImageRenderBackfill(root);
    expect(plan.coverage).toMatchObject({ alreadyRecorded: 1, additiveOutputs: 0, queueOnly: 1 });
    expect((await applyImageRenderBackfill(root, plan, join(root, 'journal.json'))).inserted).toBe(0);
    expect(await getImageRenderUsage({ directory })).toMatchObject({ savedOutputs: 1, codexSessions: 1, jobIdentityGroups: 0 });
  });

  it('uses completed queue evidence for deleted sidecars and keeps missing identities or timestamps unrecoverable', async () => {
    await writeFile(join(root, 'media-jobs.json'), JSON.stringify({ jobs: [
      { kind: 'image', status: 'completed', params: { mode: 'codex' }, result: { filename: 'deleted.png', generationId: id }, startedAt: '2026-06-01T01:02:03Z' },
      { kind: 'image', status: 'failed', params: { mode: 'codex' }, result: { filename: 'failed.png', generationId: otherId } },
    ] }));
    await sidecar('no-identity', meta({ id: null, codexSessionId: null }));
    await sidecar('no-timezone', meta({ createdAt: '2026-06-01T12:00:00' }));
    await sidecar('impossible-date', meta({ createdAt: '2026-02-30T12:00:00Z' }));
    const plan = await planImageRenderBackfill(root);
    expect(plan.coverage).toMatchObject({ eligibleOutputs: 1, queueOnly: 1, unrecoverable: 3, jobIdentityOutputs: 1, earliest: '2026-06-01T01:02:03.000Z' });
  });

  it('fails closed on a damaged ledger and reports malformed sidecars without inventing usage', async () => {
    await writeFile(join(root, 'images', 'bad.metadata.json'), '{');
    expect((await planImageRenderBackfill(root)).coverage.unreadable).toBe(1);
    await recordRenderReceipt(codexRenderReceipt(meta()), { directory });
    await writeFile(join(directory, `${codexRenderReceipt(meta()).id}.json`), '{');
    await expect(planImageRenderBackfill(root)).rejects.toThrow();
  });
});
