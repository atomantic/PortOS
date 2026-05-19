/**
 * Test for migration 024 — lock canon + variations + composite sheets by
 * default, mint stable ids on legacy id-less rows, best-effort back-fill
 * variation imageRefs from surviving media-jobs.json entries.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './024-lock-canon-and-variations.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 024 — lock canon + variations, back-fill thumbnails', () => {
  let rootDir;
  let dataDir;
  let universesPath;
  let jobsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-024-'));
    dataDir = join(rootDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    universesPath = join(dataDir, 'universe-builder.json');
    jobsPath = join(dataDir, 'media-jobs.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('stamps locked:true on canon entries that have no locked field', async () => {
    writeJson(universesPath, {
      universes: [
        {
          id: 'u-1',
          characters: [{ id: 'c-1', name: 'Alex' }, { id: 'c-2', name: 'Bee' }],
          places: [{ id: 'p-1', name: 'Vault' }],
          objects: [],
        },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.lockedCanon).toBe(3);
    const after = readJson(universesPath);
    expect(after.universes[0].characters.every((c) => c.locked === true)).toBe(true);
    expect(after.universes[0].places[0].locked).toBe(true);
  });

  it('preserves explicit locked:false (does not re-lock entries the user already unlocked)', async () => {
    writeJson(universesPath, {
      universes: [
        {
          id: 'u-1',
          characters: [
            { id: 'c-1', name: 'Alex', locked: false },
            { id: 'c-2', name: 'Bee' }, // missing → should lock
          ],
        },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.lockedCanon).toBe(1);
    const after = readJson(universesPath);
    expect(after.universes[0].characters.find((c) => c.id === 'c-1').locked).toBe(false);
    expect(after.universes[0].characters.find((c) => c.id === 'c-2').locked).toBe(true);
  });

  it('mints stable ids for variations that lack them, locks them, leaves prior ids untouched', async () => {
    writeJson(universesPath, {
      universes: [
        {
          id: 'u-1',
          categories: {
            landscapes: {
              variations: [
                { label: 'No id', prompt: 'a' },
                { id: 'var-existing', label: 'Has id', prompt: 'b' },
              ],
            },
          },
        },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.mintedVariationIds).toBe(1);
    expect(result.lockedVariations).toBe(2);
    const after = readJson(universesPath);
    const variations = after.universes[0].categories.landscapes.variations;
    // First entry: minted id starts with `var-`, locked:true.
    expect(variations[0].id).toMatch(/^var-/);
    expect(variations[0].locked).toBe(true);
    // Second entry: id preserved verbatim, locked:true added.
    expect(variations[1].id).toBe('var-existing');
    expect(variations[1].locked).toBe(true);
  });

  it('mints stable ids for composite sheets + locks them', async () => {
    writeJson(universesPath, {
      universes: [
        {
          id: 'u-1',
          compositeSheets: [{ kind: 'reference_sheet', label: 'X', prompt: 'long prompt' }],
        },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.mintedSheetIds).toBe(1);
    expect(result.lockedSheets).toBe(1);
    const after = readJson(universesPath);
    expect(after.universes[0].compositeSheets[0].id).toMatch(/^sheet-/);
    expect(after.universes[0].compositeSheets[0].locked).toBe(true);
  });

  it('back-fills imageRefs on variations from completed media jobs via category+label match', async () => {
    writeJson(universesPath, {
      universes: [
        {
          id: 'u-1',
          categories: {
            landscapes: {
              variations: [{ id: 'var-1', label: 'Crystal Canyon', prompt: 'a' }],
            },
          },
        },
      ],
    });
    writeJson(jobsPath, {
      jobs: [
        {
          id: 'job-old',
          kind: 'image',
          status: 'completed',
          params: {
            universeRun: {
              universeId: 'u-1',
              category: 'landscapes',
              label: 'Crystal Canyon',
            },
          },
          result: { filename: 'render-aaa.png' },
        },
        // Non-image / non-completed jobs are ignored.
        { kind: 'video', status: 'completed', params: { universeRun: { universeId: 'u-1', category: 'landscapes', label: 'Crystal Canyon' } }, result: { filename: 'ignore-me.mp4' } },
        { kind: 'image', status: 'running', params: { universeRun: { universeId: 'u-1', category: 'landscapes', label: 'Crystal Canyon' } }, result: { filename: 'wip.png' } },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.appendedRefs).toBe(1);
    const after = readJson(universesPath);
    expect(after.universes[0].categories.landscapes.variations[0].imageRefs).toEqual(['render-aaa.png']);
  });

  it('normalizes category keys when matching jobs against variations', async () => {
    // Job tagged with a non-normalized category name should still match the
    // sanitized variation bucket (mirrors the runtime `normalizeCategoryKey`
    // behavior).
    writeJson(universesPath, {
      universes: [
        {
          id: 'u-1',
          categories: {
            raider_pirate_clans: {
              variations: [{ id: 'var-1', label: 'Wake Jackals', prompt: 'a' }],
            },
          },
        },
      ],
    });
    writeJson(jobsPath, {
      jobs: [
        {
          kind: 'image', status: 'completed',
          params: { universeRun: { universeId: 'u-1', category: 'Raider / Pirate Clans', label: 'wake jackals' } },
          result: { filename: 'render-bbb.png' },
        },
      ],
    });
    await migration.up({ rootDir });
    const after = readJson(universesPath);
    expect(after.universes[0].categories.raider_pirate_clans.variations[0].imageRefs).toEqual(['render-bbb.png']);
  });

  it('is idempotent — second run reports zero changes', async () => {
    writeJson(universesPath, {
      universes: [
        {
          id: 'u-1',
          characters: [{ id: 'c-1', name: 'Alex' }],
          categories: { landscapes: { variations: [{ label: 'Tower', prompt: 'a' }] } },
        },
      ],
    });
    const first = await migration.up({ rootDir });
    expect(first.lockedCanon).toBe(1);
    expect(first.lockedVariations).toBe(1);
    const second = await migration.up({ rootDir });
    expect(second.lockedCanon).toBe(0);
    expect(second.lockedVariations).toBe(0);
    expect(second.mintedVariationIds).toBe(0);
  });

  it('is idempotent across reruns when a variation has MORE than the imageRefs cap of completed jobs', async () => {
    // Regression: the previous per-job append-and-cap loop pruned older
    // filenames out of imageRefs[] during the first run, then the second run
    // saw them as missing, re-appended them, rotated the list, and reported
    // changes on every rerun. The merge-then-cap approach computes the same
    // deterministic capped window each run regardless of where the prior run
    // left imageRefs.
    const variationLabel = 'Heavy Renderer';
    const totalJobs = 18; // > IMAGE_REFS_PER_ENTRY_MAX (12)
    writeJson(universesPath, {
      universes: [
        {
          id: 'u-1',
          categories: {
            landscapes: {
              variations: [{ id: 'var-1', label: variationLabel, prompt: 'a' }],
            },
          },
        },
      ],
    });
    const jobs = Array.from({ length: totalJobs }, (_, i) => ({
      id: `job-${i}`,
      kind: 'image',
      status: 'completed',
      params: { universeRun: { universeId: 'u-1', category: 'landscapes', label: variationLabel } },
      result: { filename: `render-${String(i).padStart(3, '0')}.png` },
    }));
    writeJson(jobsPath, { jobs });

    const first = await migration.up({ rootDir });
    expect(first.appendedRefs).toBe(12);
    const afterFirst = readJson(universesPath);
    const firstRefs = afterFirst.universes[0].categories.landscapes.variations[0].imageRefs;
    expect(firstRefs).toHaveLength(12);
    // Last-12-wins window: jobs 6..17 in file order.
    expect(firstRefs[0]).toBe('render-006.png');
    expect(firstRefs[11]).toBe('render-017.png');

    const second = await migration.up({ rootDir });
    expect(second.appendedRefs).toBe(0);
    const afterSecond = readJson(universesPath);
    expect(afterSecond.universes[0].categories.landscapes.variations[0].imageRefs)
      .toEqual(firstRefs);
  });

  it('returns `no-universes` when the data file is missing', async () => {
    // Skip writing universesPath — the loader should bail.
    const result = await migration.up({ rootDir });
    expect(result.reason).toBe('no-universes');
  });
});
