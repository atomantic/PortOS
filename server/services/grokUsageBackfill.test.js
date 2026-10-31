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

const IMAGE_CHAT = `${JSON.stringify({
  type: 'assistant',
  tool_calls: [{ name: 'image_gen', arguments: '{}' }],
})}\n`;

async function writeGrokSession({
  cwd = '/tmp/example-repo',
  sessionId = 'session-1',
  summary = { created_at: '2026-10-04T12:00:00.000Z' },
  chat = IMAGE_CHAT,
} = {}) {
  const cwdDir = join(home, '.grok', 'sessions', encodeURIComponent(cwd));
  const sessionDir = join(cwdDir, sessionId);
  await mkdir(sessionDir, { recursive: true });
  if (summary !== null) {
    const body = typeof summary === 'string' ? summary : JSON.stringify(summary);
    await writeFile(join(sessionDir, 'summary.json'), body);
  }
  if (chat !== null) await writeFile(join(sessionDir, 'chat_history.jsonl'), chat);
  return cwdDir;
}

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

  it('honors the grok watermark from the ledger and from the legacy scan file', async () => {
    const watermark = Date.parse('2026-10-10T00:00:00.000Z');
    await writeFile(join(dataDir, 'usage.json'), JSON.stringify({
      grokRepairIds: [], interactiveScan: { watermarks: { grok: watermark } },
    }));
    const fromLedger = await planGrokUsageRepairFromDisk({ home, dataDir });
    expect(fromLedger.notes.join(' ')).not.toMatch(/no Grok usage scan has run yet/);

    await writeFile(join(dataDir, 'usage.json'), JSON.stringify({ grokRepairIds: [] }));
    await writeFile(join(dataDir, 'usage-interactive-scan.json'), JSON.stringify({ watermarks: { grok: watermark } }));
    const fromLegacy = await planGrokUsageRepairFromDisk({ home, dataDir });
    expect(fromLegacy.notes.join(' ')).not.toMatch(/no Grok usage scan has run yet/);
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

  it('repairs the real session when a cwd folder also holds prompt_history.jsonl', async () => {
    // Grok writes that file beside the session-id directories, and other files
    // can sit next to the cwd folders. Treating either name as a directory
    // threw ENOTDIR on `<file>/summary.json` and aborted Reconcile now.
    const cwdDir = await writeGrokSession();
    await writeFile(join(cwdDir, 'prompt_history.jsonl'), '{"prompt":"not a session"}\n');
    await writeFile(join(home, '.grok', 'sessions', 'not-a-cwd.txt'), 'stray');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await applyGrokUsageRepair({ home, dataDir });
      expect(result).toMatchObject({ added: 2, images: 2, turns: 0, videos: 0, backedUp: true });
      expect(written.map((row) => row.repairId).sort()).toEqual([
        'gallery:job-1',
        'session-image:session-1:0',
      ]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('planGrokUsageRepairFromDisk bad inputs', () => {
  it('skips an unreadable session file, gallery sidecar, video history, and scan without dropping the rest', async () => {
    await writeGrokSession({ sessionId: 'session-good' });
    await writeGrokSession({ sessionId: 'session-bad', summary: '{not-json' });
    await writeFile(join(dataDir, 'images', 'broken.metadata.json'), '{not-json');
    await writeFile(join(dataDir, 'video-history.json'), '{not-json');
    await writeFile(join(dataDir, 'usage-interactive-scan.json'), '{not-json');
    await writeFile(join(dataDir, 'providers.json'), '{not-json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const plan = await planGrokUsageRepairFromDisk({ home, dataDir });
      expect(plan.additions.map((item) => item.repairId).sort()).toEqual([
        'gallery:job-1',
        'session-image:session-bad:0',
        'session-image:session-good:0',
      ]);
      expect(plan.additions.every((item) => item.record.providerId === 'grok')).toBe(true);
      expect(plan.notes[0]).toMatch(/no Grok usage scan has run yet/);
      expect(warn).toHaveBeenCalledTimes(5);
      expect(warn.mock.calls.map((call) => String(call[0]))).toEqual(expect.arrayContaining([
        expect.stringContaining('summary.json for session session-bad'),
        expect.stringContaining('broken.metadata.json'),
        expect.stringContaining('video-history.json'),
        expect.stringContaining('usage-interactive-scan.json'),
        expect.stringContaining('providers.json'),
      ]));
      for (const [line] of warn.mock.calls) expect(String(line)).not.toContain(home);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not treat an unreadable usage ledger as an empty repair list', async () => {
    await writeFile(join(dataDir, 'usage.json'), '{not-json');
    await expect(planGrokUsageRepairFromDisk({ home, dataDir })).rejects.toThrow(SyntaxError);
  });
});
