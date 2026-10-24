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

vi.mock('../lib/fileUtils.js', async importOriginal => ({
  ...await importOriginal(), PATHS: paths,
}));

const { applyAgyUsageRepair, planAgyUsageRepairFromDisk } = await import('./agyUsageBackfill.js');
const { flushUsageLedger } = await import('./usage.js');

let home;
let dataDir;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agy-repair-home-'));
  dataDir = await mkdtemp(join(tmpdir(), 'agy-repair-data-'));
  paths.data = dataDir;
  ledger.grokRepairIds = [];
  written.length = 0;
  flushUsageLedger.mockClear();

  await mkdir(join(dataDir, 'images'), { recursive: true });
  await writeFile(join(dataDir, 'usage.json'), JSON.stringify({ grokRepairIds: [] }));
  await writeFile(join(dataDir, 'images', 'job-agy-1.metadata.json'), JSON.stringify({
    id: 'job-agy-1',
    mode: 'agy',
    imageModel: 'imagen-3.0-generate-002',
    createdAt: '2026-10-05T00:00:00.000Z',
  }));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe('planAgyUsageRepairFromDisk', () => {
  it('plans gallery images without writing the ledger', async () => {
    const plan = await planAgyUsageRepairFromDisk({ home, dataDir });
    expect(plan.additions.map((item) => item.repairId)).toEqual(['gallery:job-agy-1']);
    await expect(readFile(join(dataDir, 'usage.json'), 'utf8')).resolves.toBe(JSON.stringify({ grokRepairIds: [] }));
  });
});

describe('applyAgyUsageRepair', () => {
  it('backs up gallery repairs, excludes request-only transcripts, and skips a repeat', async () => {
    const logs = join(home, '.gemini', 'antigravity-cli', 'brain', 'session-request-only', '.system_generated', 'logs');
    await mkdir(logs, { recursive: true });
    await writeFile(join(logs, 'transcript.jsonl'), JSON.stringify({
      type: 'PLANNER_RESPONSE', created_at: '2026-10-05T00:00:00.000Z',
      tool_calls: [{ name: 'generate_image', args: { prompt: 'A fictional blue lighthouse' } }],
    }));
    const first = await applyAgyUsageRepair({ home, dataDir });
    expect(first).toMatchObject({ added: 1, images: 1, backedUp: true });
    expect(first.backupDir).toMatch(/agy-usage-/);
    expect(JSON.parse(await readFile(join(first.backupDir, 'usage.json'), 'utf8')).grokRepairIds).toEqual([]);
    expect(written).toHaveLength(1);
    expect(written[0].repairId).toBe('gallery:job-agy-1');
    expect(ledger.grokRepairIds).toEqual(['gallery:job-agy-1']);
    expect(first.note).toMatch(/transcript.*not counted/i);
    expect(flushUsageLedger).toHaveBeenCalledTimes(1);

    const second = await applyAgyUsageRepair({ home, dataDir });
    expect(second).toMatchObject({ added: 0, backedUp: false });
    expect(written).toHaveLength(1);
    expect(flushUsageLedger).toHaveBeenCalledTimes(1);
  });

  it('refuses to apply a plan read from a directory the server will not save', async () => {
    await expect(applyAgyUsageRepair({ home, dataDir: join(dataDir, 'elsewhere') }))
      .rejects.toThrow(/usage\.json/);
  });
});
