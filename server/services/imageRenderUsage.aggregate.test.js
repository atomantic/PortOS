import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fsp from 'node:fs/promises';

const opened = [];
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual();
  return { ...actual, readFile: (path, ...rest) => { opened.push(String(path)); return actual.readFile(path, ...rest); } };
});

const { getImageRenderUsage, ensureRenderAggregate, readRenderProjectionRows, readRenderReceipts, recordRenderReceipt, summarizeRenderReceipts } = await import('./imageRenderUsage.js');

// All fixtures live in a temp ledger directory; the real data/ tree is never touched.
let directory;
const hex = value => createHash('sha256').update(value).digest('hex');
const receipt = (n, { session = `s${n}`, at, tokens = null, job = false } = {}) => ({
  version: 1, id: hex(`out${n}`), renderKey: hex(session), occurredAt: at, timestampSource: 'renderStartedAt',
  identitySource: job ? 'portos-job' : 'codex-session', driverModel: 'example-driver',
  driverTokens: tokens === null ? null : { reportedTotal: tokens, source: 'codex-cli-footer' },
  imageTokens: null, imageCostUsd: null, allowanceUnits: null, source: 'portos-saved-render',
});
// A fixture with a session spanning UTC midnight, job-identity sessions, mixed token footers.
const fixture = () => [
  receipt(1, { session: 'a', at: '2026-07-01T23:59:00.000Z', tokens: 100 }),
  receipt(2, { session: 'a', at: '2026-07-02T00:01:00.000Z', tokens: 250 }),
  receipt(3, { session: 'a', at: '2026-07-03T09:00:00.000Z' }),
  receipt(4, { session: 'b', at: '2026-07-02T10:00:00.000Z', job: true }),
  receipt(5, { session: 'c', at: '2026-07-03T11:00:00.000Z', tokens: 40 }),
  receipt(6, { session: 'c', at: '2026-07-03T12:00:00.000Z', tokens: 70 }),
  receipt(7, { session: 'd', at: '2026-06-30T08:00:00.000Z', job: true, tokens: 5 }),
];
const RANGES = [{}, { from: '2026-07-02' }, { to: '2026-07-01' }, { from: '2026-07-02', to: '2026-07-02' }, { from: '2026-07-03', to: '2026-07-09' }, { from: '2027-01-01' }];
// Reference: the pre-aggregate implementation, computed straight from receipt files.
const reference = async range => {
  const { conflicts: _c, ...rest } = summarizeRenderReceipts(await readRenderReceipts({ directory }), range);
  return rest;
};
const withoutDamaged = ({ damaged: _d, conflicts: _c, ...rest }) => rest;

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'image-usage-agg-')); opened.length = 0; });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('image render usage aggregates', () => {
  it('matches the receipt-derived totals for every range, live and after a rebuild from receipts', async () => {
    for (const row of fixture()) await recordRenderReceipt(row, { directory });
    for (const range of RANGES) expect(withoutDamaged(await getImageRenderUsage({ ...range, directory }))).toEqual(await reference(range));
    await rm(join(directory, 'aggregates'), { recursive: true });
    for (const range of RANGES) expect(withoutDamaged(await getImageRenderUsage({ ...range, directory }))).toEqual(await reference(range));
  });

  it('reports the same totals for an upgraded install that has receipts and no aggregates', async () => {
    for (const row of fixture()) await recordRenderReceipt(row, { directory, aggregate: false });
    expect(await readdir(directory)).not.toContain('aggregates');
    for (const range of RANGES) expect(withoutDamaged(await getImageRenderUsage({ ...range, directory }))).toEqual(await reference(range));
    expect(await readdir(join(directory, 'aggregates'))).toContain('index.json');
  });

  it('opens no receipt files once the aggregate is current, and at most the days it needs for the projection', async () => {
    for (let n = 0; n < 60; n++) {
      await recordRenderReceipt(receipt(n, { at: `2026-07-${String(1 + (n % 3)).padStart(2, '0')}T10:00:00.000Z`, tokens: n }), { directory });
    }
    opened.length = 0;
    await getImageRenderUsage({ from: '2026-07-01', to: '2026-07-02', directory });
    expect(opened.filter(path => /[a-f0-9]{64}\.json$/.test(path))).toEqual([]);
    expect(opened.length).toBeLessThanOrEqual(2 + 1); // days in range + the index
    opened.length = 0;
    const { receipts } = await readRenderProjectionRows({ directory, limit: 5 });
    expect(receipts).toHaveLength(5);
    expect(opened.length).toBe(2); // the index plus the newest day, which alone holds 20 rows
  });

  it('skips a damaged receipt, counts it, and keeps the rest of the report', async () => {
    for (const row of fixture()) await recordRenderReceipt(row, { directory, aggregate: false });
    await writeFile(join(directory, `${hex('broken')}.json`), '{not json');
    await writeFile(join(directory, `${hex('wrongid')}.json`), JSON.stringify(receipt(99, { at: '2026-07-01T00:00:00.000Z' })));
    const usage = await getImageRenderUsage({ directory });
    expect(usage).toMatchObject({ damaged: 2, savedOutputs: 7, renderGroups: 4 });
    const projection = await readRenderProjectionRows({ directory, limit: 100 });
    expect(projection).toMatchObject({ damaged: 2, complete: false });
    expect(projection.receipts).toHaveLength(7);
  });

  it('rebuilds when a receipt arrives without an aggregate update, including a lost cross-process update', async () => {
    for (const row of fixture()) await recordRenderReceipt(row, { directory });
    await recordRenderReceipt(receipt(50, { session: 'z', at: '2026-07-05T00:00:00.000Z' }), { directory, aggregate: false });
    expect(await getImageRenderUsage({ directory })).toMatchObject({ savedOutputs: 8, renderGroups: 5 });
    const before = JSON.parse(await readFile(join(directory, 'aggregates/index.json'), 'utf8'));
    await writeFile(join(directory, 'aggregates/index.json'), JSON.stringify({ ...before, receiptFiles: before.receiptFiles - 1 }));
    expect(await getImageRenderUsage({ directory })).toMatchObject({ savedOutputs: 8 });
    expect(JSON.parse(await readFile(join(directory, 'aggregates/index.json'), 'utf8')).receiptFiles).toBe(8);
  });

  it('rebuilds from receipts when the index is unreadable and removes day files that no longer have receipts', async () => {
    for (const row of fixture()) await recordRenderReceipt(row, { directory });
    await writeFile(join(directory, 'aggregates/index.json'), '{broken');
    await writeFile(join(directory, 'aggregates/2020-01-01.json'), JSON.stringify({ version: 1, rows: [] }));
    expect(withoutDamaged(await getImageRenderUsage({ directory }))).toEqual(await reference({}));
    expect(await readdir(join(directory, 'aggregates'))).not.toContain('2020-01-01.json');
  });

  it('serializes concurrent live records so no row or count is lost', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, n) => recordRenderReceipt(receipt(n, { at: '2026-07-01T10:00:00.000Z', tokens: n }), { directory })));
    const index = await ensureRenderAggregate({ directory });
    expect(index.receiptFiles).toBe(12);
    expect(index.days['2026-07-01']).toBe(12);
    expect((await readRenderProjectionRows({ directory, limit: 100 })).receipts).toHaveLength(12);
  });

  it('serves an absent ledger as empty without creating any directory', async () => {
    const missing = join(directory, 'never-written');
    expect(await getImageRenderUsage({ directory: missing })).toMatchObject({ savedOutputs: 0, renderGroups: 0, driverTokens: null, damaged: 0 });
    expect(await readRenderProjectionRows({ directory: missing, limit: 10 })).toMatchObject({ receipts: [], complete: true });
    await expect(fsp.stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('orders projection rows newest first with the id tie-break and flags truncation as partial', async () => {
    for (const row of fixture()) await recordRenderReceipt(row, { directory });
    const all = await readRenderProjectionRows({ directory, limit: 100 });
    const expected = (await readRenderReceipts({ directory })).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
    expect(all.receipts.map(row => row.id)).toEqual(expected.map(row => row.id));
    expect(all.complete).toBe(true);
    expect(await readRenderProjectionRows({ directory, limit: 3 })).toMatchObject({ complete: false, total: 7 });
  });
});
