import { describe, it, expect, vi, beforeEach } from 'vitest';

// The alcohol, nicotine, and body-composition services all read the same
// daily-log.json. They used to each carry a byte-identical copy of the probe →
// read → validate sequence; #4112 collapsed that into meatspaceDailyLog.js. These
// tests pin the shared reader's behavior AND the delegation from the callers, so
// the strict/#2726 semantics can't drift back apart.

vi.mock('../lib/fileUtils.js', () => ({
  tryReadFile: vi.fn().mockResolvedValue(null),
  readJSONFile: vi.fn(),
  getDateString: vi.fn(() => '2024-06-01'),
  PATHS: {
    root: '/mock',
    data: '/mock/data',
    meatspace: '/mock/data/meatspace'
  },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./mortalLoomStore.js', () => ({
  isMortalLoomEnabled: vi.fn().mockResolvedValue(false),
  readDailyLogIfEnabled: vi.fn().mockResolvedValue(null),
  mlArrayIfEnabled: vi.fn().mockResolvedValue(null),
  mlPush: vi.fn(),
  mlPatchById: vi.fn(),
  mlRemoveById: vi.fn(),
  mlIdAtDateIndex: vi.fn(),
  mlUpsertHealthMetricByDate: vi.fn()
}));

import { readJSONFile } from '../lib/fileUtils.js';
import { readDailyLogIfEnabled } from './mortalLoomStore.js';
import { DAILY_LOG_FILE, readLocalDailyLog, loadMeatspaceDailyLog } from './meatspaceDailyLog.js';
import { getDailyAlcohol } from './meatspaceAlcohol.js';
import { getDailyNicotine } from './meatspaceNicotine.js';
import { getBodyHistory } from './meatspaceHealth.js';

beforeEach(() => {
  vi.clearAllMocks();
  readDailyLogIfEnabled.mockResolvedValue(null);
});

describe('DAILY_LOG_FILE', () => {
  it('points at daily-log.json under the meatspace data dir', () => {
    expect(DAILY_LOG_FILE).toBe('/mock/data/meatspace/daily-log.json');
  });
});

describe('readLocalDailyLog', () => {
  it('reads the local mirror without consulting MortalLoom', async () => {
    readJSONFile.mockResolvedValue({ entries: [{ date: '2024-03-02' }], lastEntryDate: '2024-03-02' });
    const log = await readLocalDailyLog();
    expect(log.entries).toEqual([{ date: '2024-03-02' }]);
    expect(readDailyLogIfEnabled).not.toHaveBeenCalled();
  });

  it('passes the file, default, and allowArray:false through to readJSONFile', async () => {
    readJSONFile.mockResolvedValue({ entries: [] });
    await readLocalDailyLog({ strict: true, label: 'Alcohol' });
    expect(readJSONFile).toHaveBeenCalledWith(
      '/mock/data/meatspace/daily-log.json',
      { entries: [], lastEntryDate: null },
      { allowArray: false, strict: true }
    );
  });

  it('returns the empty log when the file is absent', async () => {
    readJSONFile.mockResolvedValue({ entries: [], lastEntryDate: null });
    expect(await readLocalDailyLog()).toEqual({ entries: [], lastEntryDate: null });
  });

  it('hands back a fresh empty log each time so callers can mutate it', async () => {
    readJSONFile.mockResolvedValue(null);
    const first = await readLocalDailyLog();
    first.entries.push({ date: '2024-01-01' });
    const second = await readLocalDailyLog();
    expect(second.entries).toEqual([]);
  });

  it('coerces a missing entries array to empty when not strict', async () => {
    readJSONFile.mockResolvedValue({ lastEntryDate: '2024-01-01' });
    expect(await readLocalDailyLog()).toEqual({ entries: [], lastEntryDate: '2024-01-01' });
  });

  it('substitutes the empty log for a non-object root when not strict', async () => {
    readJSONFile.mockResolvedValue([{ date: '2024-01-01' }]);
    expect(await readLocalDailyLog()).toEqual({ entries: [], lastEntryDate: null });
  });

  it('throws with the domain label for a non-object root under strict', async () => {
    readJSONFile.mockResolvedValue([{ date: '2024-01-01' }]);
    await expect(readLocalDailyLog({ strict: true, label: 'Health' }))
      .rejects.toThrow(/Health daily log malformed/);
  });

  it('throws with the domain label for a non-array entries under strict', async () => {
    readJSONFile.mockResolvedValue({ entries: 'nope' });
    await expect(readLocalDailyLog({ strict: true, label: 'Nicotine' }))
      .rejects.toThrow(/Nicotine daily log malformed/);
  });

  it('does not swallow a strict read failure raised by readJSONFile', async () => {
    readJSONFile.mockRejectedValue(new Error('Unreadable JSON file: /mock/data/meatspace/daily-log.json'));
    await expect(readLocalDailyLog({ strict: true })).rejects.toThrow(/Unreadable JSON file/);
  });
});

describe('loadMeatspaceDailyLog', () => {
  it('prefers the MortalLoom-composed log and skips the local read', async () => {
    readDailyLogIfEnabled.mockResolvedValue({ entries: [{ date: '2024-05-05' }], lastEntryDate: '2024-05-05' });
    readJSONFile.mockResolvedValue({ entries: [{ date: '1999-01-01' }] });
    const log = await loadMeatspaceDailyLog();
    expect(log.entries).toEqual([{ date: '2024-05-05' }]);
    expect(readJSONFile).not.toHaveBeenCalled();
  });

  it('falls back to the local mirror when MortalLoom is off', async () => {
    readDailyLogIfEnabled.mockResolvedValue(null);
    readJSONFile.mockResolvedValue({ entries: [{ date: '2024-04-04' }], lastEntryDate: '2024-04-04' });
    const log = await loadMeatspaceDailyLog();
    expect(log.entries).toEqual([{ date: '2024-04-04' }]);
  });

  it('forwards strict to the MortalLoom probe', async () => {
    readJSONFile.mockResolvedValue({ entries: [] });
    await loadMeatspaceDailyLog({ strict: true });
    expect(readDailyLogIfEnabled).toHaveBeenCalledWith({ strict: true });
  });

  it('propagates a strict MortalLoom failure instead of scoring a local empty', async () => {
    readDailyLogIfEnabled.mockRejectedValue(new Error('MortalLoom store unreadable for daily log'));
    readJSONFile.mockResolvedValue({ entries: [] });
    await expect(loadMeatspaceDailyLog({ strict: true })).rejects.toThrow(/unreadable/i);
    expect(readJSONFile).not.toHaveBeenCalled();
  });
});

// The point of the extraction is that the three services actually go through it.
// Each case asserts on a distinctive value or label that only the shared reader
// (driven by the mocked readJSONFile) can produce, so a mock that stopped
// intercepting would fail rather than pass against a default.
describe('caller delegation (#4112)', () => {
  it('routes alcohol reads through the shared reader', async () => {
    readJSONFile.mockResolvedValue({
      entries: [{ date: '2024-02-02', alcohol: { drinks: [{ name: 'Example Lager', oz: 12, abv: 5 }] } }]
    });
    const entries = await getDailyAlcohol();
    expect(entries).toEqual([
      { date: '2024-02-02', alcohol: { drinks: [{ name: 'Example Lager', oz: 12, abv: 5 }] } }
    ]);
    expect(readDailyLogIfEnabled).toHaveBeenCalled();
  });

  it('labels an alcohol strict failure as Alcohol', async () => {
    readJSONFile.mockResolvedValue({ entries: 'nope' });
    await expect(getDailyAlcohol(null, null, { strict: true }))
      .rejects.toThrow(/Alcohol daily log malformed/);
  });

  it('routes nicotine reads through the shared reader', async () => {
    readJSONFile.mockResolvedValue({
      entries: [{ date: '2024-02-03', nicotine: { items: [{ product: 'Example Pouch', mgPerUnit: 3, count: 2 }], totalMg: 6 } }]
    });
    const entries = await getDailyNicotine();
    expect(entries).toHaveLength(1);
    expect(entries[0].nicotine.totalMg).toBe(6);
    expect(readDailyLogIfEnabled).toHaveBeenCalled();
  });

  it('labels a nicotine strict failure as Nicotine', async () => {
    readJSONFile.mockResolvedValue({ entries: 'nope' });
    await expect(getDailyNicotine(null, null, { strict: true }))
      .rejects.toThrow(/Nicotine daily log malformed/);
  });

  it('routes body history through the local reader, not the composed log', async () => {
    readJSONFile.mockResolvedValue({
      entries: [{ date: '2024-02-04', body: { weightLbs: 175 } }]
    });
    expect(await getBodyHistory()).toEqual([{ date: '2024-02-04', weightLbs: 175 }]);
    // Body entries come from MortalLoom's own `bodyEntries` key, so the composed
    // daily-log probe must stay out of this path (see meatspaceHealth.js).
    expect(readDailyLogIfEnabled).not.toHaveBeenCalled();
  });

  it('labels a body-history strict failure as Health', async () => {
    readJSONFile.mockResolvedValue({ entries: 'nope' });
    await expect(getBodyHistory({ strict: true })).rejects.toThrow(/Health daily log malformed/);
  });
});
