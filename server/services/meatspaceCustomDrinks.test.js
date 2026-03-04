import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../lib/fileUtils.js', () => ({
  readJSONFile: vi.fn(),
  PATHS: {
    root: '/mock',
    data: '/mock/data',
    meatspace: '/mock/data/meatspace'
  },
  ensureDir: vi.fn().mockResolvedValue(undefined)
}));

import { writeFile } from 'fs/promises';
import { readJSONFile } from '../lib/fileUtils.js';
import {
  getCustomDrinks,
  addCustomDrink,
  updateCustomDrink,
  removeCustomDrink
} from './meatspaceAlcohol.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('custom drink CRUD', () => {
  it('returns default drinks when file does not exist', async () => {
    readJSONFile.mockResolvedValue(null);
    const drinks = await getCustomDrinks();
    expect(drinks.length).toBeGreaterThan(0);
    expect(drinks[0]).toHaveProperty('name');
    expect(drinks[0]).toHaveProperty('oz');
    expect(drinks[0]).toHaveProperty('abv');
    // Should not write to disk on read
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('returns persisted drinks from file', async () => {
    readJSONFile.mockResolvedValue({ drinks: [{ name: 'IPA', oz: 16, abv: 7 }] });
    const drinks = await getCustomDrinks();
    expect(drinks).toEqual([{ name: 'IPA', oz: 16, abv: 7 }]);
  });

  it('adds a custom drink and persists', async () => {
    readJSONFile.mockResolvedValue({ drinks: [{ name: 'IPA', oz: 16, abv: 7 }] });
    const result = await addCustomDrink({ name: 'Stout', oz: 12, abv: 5 });
    expect(result).toEqual({ name: 'Stout', oz: 12, abv: 5 });
    expect(writeFile).toHaveBeenCalledTimes(1);
    const written = JSON.parse(writeFile.mock.calls[0][1]);
    expect(written.drinks).toHaveLength(2);
    expect(written.drinks[1].name).toBe('Stout');
  });

  it('updates a custom drink by index', async () => {
    readJSONFile.mockResolvedValue({ drinks: [{ name: 'IPA', oz: 16, abv: 7 }] });
    const result = await updateCustomDrink(0, { name: 'Double IPA', abv: 9 });
    expect(result.name).toBe('Double IPA');
    expect(result.abv).toBe(9);
    expect(result.oz).toBe(16); // unchanged
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('returns null for out-of-bounds update', async () => {
    readJSONFile.mockResolvedValue({ drinks: [{ name: 'IPA', oz: 16, abv: 7 }] });
    expect(await updateCustomDrink(5, { name: 'X' })).toBeNull();
    expect(await updateCustomDrink(-1, { name: 'X' })).toBeNull();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('removes a custom drink by index', async () => {
    readJSONFile.mockResolvedValue({ drinks: [
      { name: 'IPA', oz: 16, abv: 7 },
      { name: 'Stout', oz: 12, abv: 5 }
    ]});
    const removed = await removeCustomDrink(0);
    expect(removed.name).toBe('IPA');
    expect(writeFile).toHaveBeenCalledTimes(1);
    const written = JSON.parse(writeFile.mock.calls[0][1]);
    expect(written.drinks).toHaveLength(1);
    expect(written.drinks[0].name).toBe('Stout');
  });

  it('returns null for out-of-bounds remove', async () => {
    readJSONFile.mockResolvedValue({ drinks: [{ name: 'IPA', oz: 16, abv: 7 }] });
    expect(await removeCustomDrink(5)).toBeNull();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('normalizes missing drinks array from file', async () => {
    readJSONFile.mockResolvedValue({ notDrinks: true });
    const drinks = await getCustomDrinks();
    expect(drinks).toEqual([]);
  });
});
