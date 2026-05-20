import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './029-seed-network-exposure-widget.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 029 — seed network-exposure widget into built-in layouts', () => {
  let rootDir;
  let layoutsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-029-'));
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

  it('inserts network-exposure into both default and ops layouts', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        { id: 'default', name: 'Everything', builtIn: true, widgets: ['quick-task', 'system-health'], grid: [{ id: 'quick-task', x: 0, y: 0, w: 6, h: 5 }] },
        { id: 'ops', name: 'Ops', builtIn: true, widgets: ['system-health', 'cos'], grid: [{ id: 'system-health', x: 0, y: 0, w: 6, h: 5 }] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(2);
    const after = readJson(layoutsPath);
    const defaultLayout = after.layouts.find((l) => l.id === 'default');
    const opsLayout = after.layouts.find((l) => l.id === 'ops');
    expect(defaultLayout.widgets).toContain('network-exposure');
    expect(opsLayout.widgets).toContain('network-exposure');
    expect(defaultLayout.grid.find((g) => g.id === 'network-exposure')).toEqual({ id: 'network-exposure', x: 9, y: 10, w: 3, h: 5 });
    expect(opsLayout.grid.find((g) => g.id === 'network-exposure')).toEqual({ id: 'network-exposure', x: 3, y: 5, w: 3, h: 5 });
  });

  it('is idempotent — second run is a no-op', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        { id: 'default', name: 'Everything', builtIn: true, widgets: ['network-exposure'], grid: [{ id: 'network-exposure', x: 9, y: 10, w: 3, h: 5 }] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(result.reason).toBe('already-applied');
  });

  it('preserves user-renamed layout copies — only touches built-in ids', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'my-default',
      layouts: [
        { id: 'my-default', name: 'My Everything', builtIn: false, widgets: ['quick-task'], grid: [] },
        { id: 'default', name: 'Everything', builtIn: true, widgets: ['quick-task'], grid: [] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const after = readJson(layoutsPath);
    expect(after.layouts.find((l) => l.id === 'my-default').widgets).toEqual(['quick-task']);
    expect(after.layouts.find((l) => l.id === 'default').widgets).toContain('network-exposure');
  });

  it('survives an unreadable JSON file', async () => {
    writeFileSync(layoutsPath, 'not json');
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(result.reason).toBe('unreadable');
  });

  it('appends below existing items when the preferred slot is occupied by user rearrangement', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        {
          id: 'default',
          name: 'Everything',
          builtIn: true,
          widgets: ['system-health'],
          grid: [{ id: 'system-health', x: 9, y: 10, w: 3, h: 5 }],
        },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const after = readJson(layoutsPath);
    const newEntry = after.layouts[0].grid.find((g) => g.id === 'network-exposure');
    expect(newEntry).toBeDefined();
    expect(newEntry.y).toBeGreaterThanOrEqual(15);
    expect(newEntry.x).toBe(0);
    expect(newEntry.w).toBe(3);
    expect(newEntry.h).toBe(5);
    const userHealth = after.layouts[0].grid.find((g) => g.id === 'system-health');
    const overlaps =
      newEntry.x < userHealth.x + userHealth.w &&
      userHealth.x < newEntry.x + newEntry.w &&
      newEntry.y < userHealth.y + userHealth.h &&
      userHealth.y < newEntry.y + newEntry.h;
    expect(overlaps).toBe(false);
  });

  it('skips a built-in layout that was hand-removed (single deleted built-in stays absent)', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        { id: 'default', name: 'Everything', builtIn: true, widgets: ['system-health'], grid: [] },
        // ops layout deliberately absent — user deleted it
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const after = readJson(layoutsPath);
    expect(after.layouts.find((l) => l.id === 'ops')).toBeUndefined();
  });
});
