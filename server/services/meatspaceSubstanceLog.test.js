import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/fileUtils.js', () => ({
  tryReadFile: vi.fn().mockResolvedValue(null),
  readJSONFile: vi.fn(),
  getDateString: vi.fn(() => '2024-06-01'),
  PATHS: { root: '/mock', data: '/mock/data', meatspace: '/mock/data/meatspace' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('./mortalLoomStore.js', () => ({
  isMortalLoomEnabled: vi.fn().mockResolvedValue(false),
  readDailyLogIfEnabled: vi.fn().mockResolvedValue(null),
  mlArrayIfEnabled: vi.fn().mockResolvedValue(null),
  mlPush: vi.fn(), mlPatchById: vi.fn(), mlRemoveById: vi.fn(), mlIdAtDateIndex: vi.fn()
}));

import { readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import { isMortalLoomEnabled, readDailyLogIfEnabled, mlPush, mlPatchById, mlRemoveById, mlIdAtDateIndex } from './mortalLoomStore.js';
import * as alcohol from './meatspaceAlcohol.js';
import * as nicotine from './meatspaceNicotine.js';

const cases = [
  {
    name: 'alcohol', key: 'alcohol', items: 'drinks', total: 'standardDrinks', result: 'drink',
    input: { name: 'Example Lager', oz: 12, abv: 5, count: 1, date: '2024-06-01' },
    update: { oz: 24 }, movedTotal: 2,
    log: alcohol.logDrink, edit: alcohol.updateDrink, remove: alcohol.removeDrink,
    persisted: { name: 'Example Lager', abv: 5, oz: 12, count: 1 },
    buttons: { get: alcohol.getCustomDrinks, add: alcohol.addCustomDrink, edit: alcohol.updateCustomDrink, remove: alcohol.removeCustomDrink, field: 'drinks', input: { name: 'Example Beer', oz: 12, abv: 5 } },
    collection: 'alcoholDrinks', zeroAmount: 0
  },
  {
    name: 'nicotine', key: 'nicotine', items: 'items', total: 'totalMg', result: 'item',
    input: { product: 'Example Pouch', mgPerUnit: 3, count: 1, date: '2024-06-01' },
    update: { mgPerUnit: 4 }, movedTotal: 4,
    log: nicotine.logNicotine, edit: nicotine.updateNicotine, remove: nicotine.removeNicotine,
    persisted: { product: 'Example Pouch', mgPerUnit: 3, count: 1 },
    buttons: { get: nicotine.getCustomProducts, add: nicotine.addCustomProduct, edit: nicotine.updateCustomProduct, remove: nicotine.removeCustomProduct, field: 'products', input: { name: 'Example Pouch', mgPerUnit: 3 } },
    collection: 'nicotineEntries', zeroAmount: 0
  }
];

let store;
beforeEach(() => {
  vi.clearAllMocks();
  store = { entries: [], lastEntryDate: null };
  readJSONFile.mockImplementation(async () => structuredClone(store));
  isMortalLoomEnabled.mockResolvedValue(false);
  readDailyLogIfEnabled.mockResolvedValue(null);
  atomicWrite.mockImplementation(async (path, data) => {
    if (String(path).endsWith('daily-log.json')) store = structuredClone(data);
  });
});

describe.each(cases)('$name event log', ({ key, items, total, result, input, update, movedTotal, log, edit, remove, persisted, buttons, collection, zeroAmount }) => {
  it('keeps each repeated log separate, edits one, moves it, and removes it', async () => {
    const first = await log(input);
    const second = await log(input);
    const day = () => store.entries.find(entry => entry.date === input.date);
    expect(day()[key][items]).toHaveLength(2);
    expect(first[result].id).not.toBe(second[result].id);
    expect(day()[key][items][0]).toMatchObject(persisted);
    expect(Object.keys(day()[key])).toEqual([items, total]);

    await edit(input.date, 1, update);
    expect(day()[key][items][0]).toEqual(first[result]);
    expect(day()[key][items][1]).toMatchObject({ ...persisted, ...update, id: second[result].id });

    const moved = await edit(input.date, 1, { date: '2024-06-02' });
    expect(moved.date).toBe('2024-06-02');
    expect(moved.dayTotal).toBe(movedTotal);
    expect(day()[key][items]).toHaveLength(1);
    expect(store.entries.find(entry => entry.date === '2024-06-02')[key]).toMatchObject({
      [items]: [expect.objectContaining({ ...persisted, ...update, id: second[result].id })],
      [total]: movedTotal
    });
    expect(store.lastEntryDate).toBe('2024-06-02');

    const removed = await remove('2024-06-02', 0);
    expect(removed.id).toBe(second[result].id);
    expect(store.entries.find(entry => entry.date === '2024-06-02')[key]).toBeUndefined();
  });

  it('preserves the logged amount for an explicit zero count', async () => {
    const logged = await log({ ...input, count: 0 });
    expect(logged[key === 'alcohol' ? 'standardDrinks' : 'totalMg']).toBe(zeroAmount);
  });

  it('keeps the MortalLoom collection and public return shapes', async () => {
    isMortalLoomEnabled.mockResolvedValue(true);
    readDailyLogIfEnabled.mockResolvedValue({ entries: [{ date: input.date, [key]: { [total]: movedTotal } }] });
    mlIdAtDateIndex.mockResolvedValue('event-id');
    mlPatchById.mockResolvedValue({ ...persisted, date: '2024-06-02' });
    mlRemoveById.mockResolvedValue({ ...persisted, id: 'event-id' });
    expect(await log(input)).toMatchObject({ [result]: persisted, date: input.date });
    expect(mlPush).toHaveBeenCalledWith(collection, { ...persisted, date: input.date });
    expect(await edit(input.date, 0, { date: '2024-06-02' })).toMatchObject({
      [result]: persisted, date: '2024-06-02'
    });
    expect(mlPatchById).toHaveBeenCalledWith(collection, 'event-id', { date: '2024-06-02' });
    expect(await remove(input.date, 0)).toMatchObject(persisted);
    expect(mlRemoveById).toHaveBeenCalledWith(collection, 'event-id');
  });

  it('round-trips custom buttons in their existing file shape', async () => {
    let buttonsStore = { [buttons.field]: [] };
    readJSONFile.mockImplementation(async path => String(path).endsWith('daily-log.json') ? structuredClone(store) : structuredClone(buttonsStore));
    atomicWrite.mockImplementation(async (path, data) => {
      if (!String(path).endsWith('daily-log.json')) buttonsStore = structuredClone(data);
    });
    expect(await buttons.add(buttons.input)).toEqual(buttons.input);
    expect(buttonsStore).toEqual({ [buttons.field]: [buttons.input] });
    expect(await buttons.get()).toEqual([buttons.input]);
    expect(await buttons.edit(0, { name: 'Renamed' })).toEqual({ ...buttons.input, name: 'Renamed' });
    expect(await buttons.remove(0)).toEqual({ ...buttons.input, name: 'Renamed' });
    expect(buttonsStore).toEqual({ [buttons.field]: [] });
  });
});
