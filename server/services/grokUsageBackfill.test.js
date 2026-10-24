import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ledger = vi.hoisted(() => ({ grokRepairIds: [] }));
const written = vi.hoisted(() => []);
const paths = vi.hoisted(() => ({ data: '' }));

vi.mock('./usage.js', () => ({
  loadUsage: vi.fn(async () => ledger),
  getUsage: vi.fn(() => ledger),
  addDatedUsage: vi.fn(async (day, record, { repairId } = {}) => {
    if (ledger.grokRepairIds.includes(repairId)) return false;
    ledger.grokRepairIds.push(repairId);
    written.push({ day, record, repairId });
    return true;
  }),
  flushUsageLedger: vi.fn(async () => {}),
}));

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: paths,
}));

const { applyGrokUsageRepair, planGrokUsageRepairFromDisk } = await import('./grokUsageBackfill.js');
const { flushUsageLedger } = await import('./usage.js');

let home;
let dataDir;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'grok-repair-home-'));
  dataDir = await mkdtemp(join(tmpdir(), 'grok-repair-data-'));
  paths.data = dataDir;
  ledger.grokRepairIds = [];
  written.length = 0;
  flushUsageLedger.mockClear();
  await mkdir(join(dataDir, 'images'), { recursive: true });
  await writeFile(join(dataDir, 'usage.json'), JSON.stringify({ grokRepairIds: [] }));
  await writeFile(join(dataDir, 'images', 'job-1.metadata.json'), JSON.stringify({
    id: 'job-1', mode: 'grok', createdAt: '2026-10-02T00:00:00.000Z',
  }));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe('planGrokUsageRepairFromDisk', () => {
  it('plans gallery images without writing the ledger', async () => {
    const plan = await planGrokUsageRepairFromDisk({ home, dataDir });
    expect(plan.additions.map((item) => item.repairId)).toEqual(['gallery:job-1']);
    expect(plan.notes[0]).toMatch(/no Grok usage scan has run yet/);
    await expect(readFile(join(dataDir, 'usage.json'), 'utf8')).resolves.toBe(JSON.stringify({ grokRepairIds: [] }));
  });
});

describe('applyGrokUsageRepair', () => {
  it('backs up the ledger once, writes the in-memory repair, and skips a repeat', async () => {
    const first = await applyGrokUsageRepair({ home, dataDir });
    expect(first).toMatchObject({ added: 1, images: 1, turns: 0, videos: 0, backedUp: true });
    expect(first.backupDir).toMatch(/grok-usage-/);
    expect(JSON.parse(await readFile(join(first.backupDir, 'usage.json'), 'utf8')).grokRepairIds).toEqual([]);
    expect(written).toHaveLength(1);
    expect(written[0].repairId).toBe('gallery:job-1');
    expect(flushUsageLedger).toHaveBeenCalledTimes(1);

    const second = await applyGrokUsageRepair({ home, dataDir });
    expect(second).toMatchObject({ added: 0, backedUp: false });
    expect(written).toHaveLength(1);
    expect(flushUsageLedger).toHaveBeenCalledTimes(1);
  });

  it('refuses to apply a plan read from a directory the server will not save', async () => {
    await expect(applyGrokUsageRepair({ home, dataDir: join(dataDir, 'elsewhere') }))
      .rejects.toThrow(/usage\.json/);
    expect(written).toHaveLength(0);
  });
});
