import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './033-seed-quick-image-widget.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 033 — seed quick-image widget into default layout', () => {
  let rootDir;
  let layoutsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-033-'));
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

  it('inserts quick-image into the default layout at the preferred slot', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        {
          id: 'default',
          name: 'Everything',
          builtIn: true,
          widgets: ['quick-brain', 'quick-task'],
          grid: [
            { id: 'quick-brain', x: 0, y: 0, w: 3, h: 2 },
            { id: 'quick-task',  x: 3, y: 0, w: 5, h: 5 },
          ],
        },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const after = readJson(layoutsPath);
    const defaultLayout = after.layouts.find((l) => l.id === 'default');
    expect(defaultLayout.widgets).toContain('quick-image');
    expect(defaultLayout.grid.find((g) => g.id === 'quick-image')).toEqual({ id: 'quick-image', x: 0, y: 2, w: 3, h: 3 });
  });

  it('is idempotent — second run is a no-op', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        { id: 'default', name: 'Everything', builtIn: true, widgets: ['quick-image'], grid: [{ id: 'quick-image', x: 0, y: 2, w: 3, h: 3 }] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(result.reason).toBe('already-applied');
  });

  it('preserves user-renamed layout copies — only touches default id', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'my-default',
      layouts: [
        { id: 'my-default', name: 'My Everything', builtIn: false, widgets: ['quick-task'], grid: [] },
        { id: 'default',    name: 'Everything',    builtIn: true,  widgets: ['quick-task'], grid: [] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const after = readJson(layoutsPath);
    expect(after.layouts.find((l) => l.id === 'my-default').widgets).toEqual(['quick-task']);
    expect(after.layouts.find((l) => l.id === 'default').widgets).toContain('quick-image');
  });

  it('survives an unreadable JSON file', async () => {
    writeFileSync(layoutsPath, 'not json');
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(result.reason).toBe('unreadable');
  });

  it('heals legacy state where widget id is in widgets[] but missing from grid[]', async () => {
    // Regression: an earlier shape of migration 033 (or any out-of-band
    // 'widgets'-only edit) could leave the widget id in widgets[] without
    // the corresponding placement entry in grid[]. Without the heal, the
    // widget renders only via client-side synthesizeGrid auto-flow, and
    // any subsequent "Save Arrangement" persists the gap. The migration
    // should add the missing grid entry on the next run.
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        {
          id: 'default',
          name: 'Everything',
          builtIn: true,
          widgets: ['quick-brain', 'quick-image'],
          grid: [{ id: 'quick-brain', x: 0, y: 0, w: 3, h: 2 }],
        },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const after = readJson(layoutsPath);
    const entry = after.layouts[0].grid.find((g) => g.id === 'quick-image');
    expect(entry).toBeDefined();
    // widgets[] should not duplicate the id (still exactly one occurrence).
    expect(after.layouts[0].widgets.filter((w) => w === 'quick-image')).toHaveLength(1);
  });

  it('appends below existing items when the preferred slot is occupied by user rearrangement', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        {
          id: 'default',
          name: 'Everything',
          builtIn: true,
          widgets: ['quick-brain'],
          // User dragged quick-brain into the preferred slot.
          grid: [{ id: 'quick-brain', x: 0, y: 2, w: 3, h: 3 }],
        },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const after = readJson(layoutsPath);
    const newEntry = after.layouts[0].grid.find((g) => g.id === 'quick-image');
    expect(newEntry).toBeDefined();
    expect(newEntry.y).toBeGreaterThanOrEqual(5);
    expect(newEntry.x).toBe(0);
    expect(newEntry.w).toBe(3);
    expect(newEntry.h).toBe(3);
  });
});
