import { describe, it, expect, vi } from 'vitest';
import { computeRollingAverages } from './meatspaceNicotine.js';
import { getDateString } from '../../lib/fileUtils.js';

// Substance writes must log an id and a date, never the product name, mg, or the
// computed total (#17348). See meatspaceAlcohol.test.js for the shared mock rationale.
vi.mock('../../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readJSONFile: vi.fn(),
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  ensureDir: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('../mortalLoomStore.js', () => ({
  isMortalLoomEnabled: vi.fn().mockResolvedValue(false),
  readDailyLogIfEnabled: vi.fn().mockResolvedValue(null),
  mlArrayIfEnabled: vi.fn().mockResolvedValue(null),
  mlPush: vi.fn(), mlPatchById: vi.fn(), mlRemoveById: vi.fn(), mlIdAtDateIndex: vi.fn()
}));

describe('nicotine logs never carry the product name or dose', () => {
  it('log, edit, remove, and custom-product writes keep product, mg, and the total off stdout', async () => {
    const fileUtils = await import('../../lib/fileUtils.js');
    const { logNicotine, updateNicotine, removeNicotine, addCustomProduct, updateCustomProduct, removeCustomProduct } = await import('./meatspaceNicotine.js');
    let store = { entries: [], lastEntryDate: null };
    let products = { products: [] };
    fileUtils.readJSONFile.mockImplementation(async path => structuredClone(String(path).endsWith('daily-log.json') ? store : products));
    fileUtils.atomicWrite.mockImplementation(async (path, data) => {
      if (String(path).endsWith('daily-log.json')) store = structuredClone(data);
      else products = structuredClone(data);
    });
    const stdout = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => { stdout.push(args.join(' ')); });
    try {
      const date = '2024-06-01';
      const logged = await logNicotine({ product: 'Zzyzx Fixture Pouch', mgPerUnit: 3.21, count: 2, date });
      const total = String(logged.totalMg);
      await updateNicotine(date, 0, { mgPerUnit: 4.56, id: logged.item.id });
      await removeNicotine(date, 0, logged.item.id);
      await addCustomProduct({ name: 'Zzyzx Custom Button', mgPerUnit: 3.21 });
      await updateCustomProduct(0, { name: 'Zzyzx Renamed Button' });
      await removeCustomProduct(0);

      const output = stdout.join('\n');
      for (const secret of ['Zzyzx', '3.21', '4.56', total]) {
        expect(output).not.toContain(secret);
      }
      expect(stdout.filter(line => line.includes(logged.item.id))).toHaveLength(3);
      expect(stdout.some(line => line.includes(date))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
describe('computeRollingAverages (nicotine)', () => {
  // Local calendar date, matching the function's own "today" derivation.
  const daysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return getDateString(d);
  };

  it('averages the 7-day window over exactly 7 calendar days', () => {
    // 10 mg on each of the last 8 days: today-7 must be excluded, so 70 mg / 7 = 10.
    const entries = [];
    for (let i = 0; i < 8; i++) {
      entries.push({ date: daysAgo(i), nicotine: { totalMg: 10 } });
    }
    const result = computeRollingAverages(entries);
    expect(result.avg7day).toBe(10);
    expect(result.weeklyTotal).toBe(70);
  });

  it('averages the 30-day window over exactly 30 calendar days', () => {
    // 3 mg on each of the last 31 days: today-30 must be excluded, so 90 mg / 30 = 3.
    const entries = [];
    for (let i = 0; i < 31; i++) {
      entries.push({ date: daysAgo(i), nicotine: { totalMg: 3 } });
    }
    const result = computeRollingAverages(entries);
    expect(result.avg30day).toBe(3);
  });
});
