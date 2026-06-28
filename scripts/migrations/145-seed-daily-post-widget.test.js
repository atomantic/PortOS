import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './145-seed-daily-post-widget.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 145 — seed daily-post widget into the health layout', () => {
  let rootDir;
  let layoutsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-145-'));
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

  it('inserts daily-post into the health layout at its preferred slot', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        {
          id: 'health',
          name: 'Health',
          builtIn: true,
          widgets: ['death-clock', 'activity-streak'],
          grid: [
            { id: 'death-clock', x: 0, y: 0, w: 4, h: 3 },
            { id: 'activity-streak', x: 9, y: 0, w: 3, h: 3 },
          ],
        },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const after = readJson(layoutsPath);

    const health = after.layouts.find((l) => l.id === 'health');
    expect(health.widgets).toContain('daily-post');
    expect(health.grid.find((g) => g.id === 'daily-post')).toEqual({ id: 'daily-post', x: 9, y: 3, w: 3, h: 2 });
  });

  it('is idempotent — second run is a no-op', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        { id: 'health', name: 'Health', builtIn: true, widgets: ['daily-post'], grid: [{ id: 'daily-post', x: 9, y: 3, w: 3, h: 2 }] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(result.reason).toBe('already-applied');
  });

  it('only touches the health id, not other or renamed layouts', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'focus',
      layouts: [
        { id: 'focus',     name: 'Focus',       builtIn: true,  widgets: ['cos'], grid: [] },
        { id: 'my-health', name: 'My Health',   builtIn: false, widgets: ['cos'], grid: [] },
        { id: 'health',    name: 'Health',      builtIn: true,  widgets: ['cos'], grid: [] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const after = readJson(layoutsPath);
    expect(after.layouts.find((l) => l.id === 'focus').widgets).toEqual(['cos']);
    expect(after.layouts.find((l) => l.id === 'my-health').widgets).toEqual(['cos']);
    expect(after.layouts.find((l) => l.id === 'health').widgets).toContain('daily-post');
  });

  it('survives an unreadable JSON file', async () => {
    writeFileSync(layoutsPath, 'not json');
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(result.reason).toBe('unreadable');
  });

  it('heals legacy state where widget id is in widgets[] but missing from grid[]', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        {
          id: 'health',
          name: 'Health',
          builtIn: true,
          widgets: ['death-clock', 'daily-post'],
          grid: [{ id: 'death-clock', x: 0, y: 0, w: 4, h: 3 }],
        },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const after = readJson(layoutsPath);
    const entry = after.layouts[0].grid.find((g) => g.id === 'daily-post');
    expect(entry).toBeDefined();
    expect(after.layouts[0].widgets.filter((w) => w === 'daily-post')).toHaveLength(1);
  });

  it('appends below existing items when the preferred slot is occupied', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        {
          id: 'health',
          name: 'Health',
          builtIn: true,
          widgets: ['hourly-activity'],
          // Something already sits in the preferred slot (x:9,y:3).
          grid: [{ id: 'hourly-activity', x: 9, y: 3, w: 3, h: 4 }],
        },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const after = readJson(layoutsPath);
    const newEntry = after.layouts[0].grid.find((g) => g.id === 'daily-post');
    expect(newEntry).toBeDefined();
    expect(newEntry.x).toBe(0);
    expect(newEntry.y).toBeGreaterThanOrEqual(7);
  });
});
