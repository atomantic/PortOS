import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './156-seed-feeds-and-meatspace-streak-widgets.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 156 — seed feeds + meatspace-streak widgets', () => {
  let rootDir;
  let layoutsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-156-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    layoutsPath = join(rootDir, 'data', 'dashboard-layouts.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('no-ops cleanly when dashboard-layouts.json is missing (fresh install)', async () => {
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(result.reason).toBe('no-state');
    expect(existsSync(layoutsPath)).toBe(false);
  });

  it('inserts each widget into its target layout at the preferred slot', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        { id: 'default', name: 'Everything', builtIn: true, widgets: ['apps'], grid: [{ id: 'apps', x: 0, y: 0, w: 12, h: 8 }] },
        { id: 'health', name: 'Health', builtIn: true, widgets: ['death-clock'], grid: [{ id: 'death-clock', x: 0, y: 0, w: 4, h: 3 }] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(2);
    const after = readJson(layoutsPath);

    const def = after.layouts.find((l) => l.id === 'default');
    expect(def.widgets).toContain('feeds');
    expect(def.grid.find((g) => g.id === 'feeds')).toEqual({ id: 'feeds', x: 8, y: 29, w: 3, h: 4 });

    const health = after.layouts.find((l) => l.id === 'health');
    expect(health.widgets).toContain('meatspace-streak');
    expect(health.grid.find((g) => g.id === 'meatspace-streak')).toEqual({ id: 'meatspace-streak', x: 0, y: 9, w: 4, h: 4 });
  });

  it('is idempotent — second run is a no-op', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        { id: 'default', name: 'Everything', builtIn: true, widgets: ['feeds'], grid: [{ id: 'feeds', x: 8, y: 29, w: 3, h: 4 }] },
        { id: 'health', name: 'Health', builtIn: true, widgets: ['meatspace-streak'], grid: [{ id: 'meatspace-streak', x: 0, y: 9, w: 4, h: 4 }] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(result.reason).toBe('already-applied');
  });

  it('only touches the built-in ids, not renamed/other layouts', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'focus',
      layouts: [
        { id: 'focus',      name: 'Focus',      builtIn: true,  widgets: ['cos'], grid: [] },
        { id: 'my-default', name: 'My Home',    builtIn: false, widgets: ['cos'], grid: [] },
        { id: 'default',    name: 'Everything', builtIn: true,  widgets: ['cos'], grid: [] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const after = readJson(layoutsPath);
    expect(after.layouts.find((l) => l.id === 'focus').widgets).toEqual(['cos']);
    expect(after.layouts.find((l) => l.id === 'my-default').widgets).toEqual(['cos']);
    expect(after.layouts.find((l) => l.id === 'default').widgets).toContain('feeds');
  });

  it('survives an unreadable JSON file', async () => {
    writeFileSync(layoutsPath, 'not json');
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(result.reason).toBe('unreadable');
  });

  it('heals legacy state where the id is in widgets[] but missing from grid[]', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'health',
      layouts: [
        { id: 'health', name: 'Health', builtIn: true, widgets: ['death-clock', 'meatspace-streak'], grid: [{ id: 'death-clock', x: 0, y: 0, w: 4, h: 3 }] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const after = readJson(layoutsPath);
    const entry = after.layouts[0].grid.find((g) => g.id === 'meatspace-streak');
    expect(entry).toBeDefined();
    expect(after.layouts[0].widgets.filter((w) => w === 'meatspace-streak')).toHaveLength(1);
  });

  it('appends below existing items when the preferred slot is occupied', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        { id: 'health', name: 'Health', builtIn: true, widgets: ['hourly-activity'], grid: [{ id: 'hourly-activity', x: 0, y: 9, w: 12, h: 4 }] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const after = readJson(layoutsPath);
    const newEntry = after.layouts[0].grid.find((g) => g.id === 'meatspace-streak');
    expect(newEntry).toBeDefined();
    expect(newEntry.x).toBe(0);
    expect(newEntry.y).toBeGreaterThanOrEqual(13);
  });
});
