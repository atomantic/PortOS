import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './191-seed-daily-driver-widget.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 191 — seed daily-driver widget into the morning-review layout', () => {
  let rootDir;
  let layoutsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-191-'));
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

  it('appends daily-driver full-width in a fresh row below existing content', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        { id: 'morning-review', name: 'Morning Review', builtIn: true, widgets: ['review-hub'], grid: [{ id: 'review-hub', x: 0, y: 8, w: 4, h: 4 }] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const after = readJson(layoutsPath);
    const layout = after.layouts.find((l) => l.id === 'morning-review');
    expect(layout.widgets).toContain('daily-driver');
    // Below the existing review-hub (y:8 h:4 → bottom 12).
    expect(layout.grid.find((g) => g.id === 'daily-driver')).toEqual({ id: 'daily-driver', x: 0, y: 12, w: 12, h: 6 });
  });

  it('appends below existing items when the preferred top slot is occupied', async () => {
    // The real persisted Morning Review keeps its widgets at the old top rows.
    writeJson(layoutsPath, {
      activeLayoutId: 'morning-review',
      layouts: [
        {
          id: 'morning-review', name: 'Morning Review', builtIn: true,
          widgets: ['proactive-alerts', 'upcoming-tasks'],
          grid: [
            { id: 'proactive-alerts', x: 0, y: 0, w: 4, h: 4 },
            { id: 'upcoming-tasks', x: 4, y: 0, w: 5, h: 8 },
          ],
        },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const after = readJson(layoutsPath);
    const entry = after.layouts[0].grid.find((g) => g.id === 'daily-driver');
    expect(entry).toBeDefined();
    expect(entry.x).toBe(0);
    expect(entry.y).toBeGreaterThanOrEqual(8);
    // Existing widgets are left untouched.
    expect(after.layouts[0].grid.find((g) => g.id === 'proactive-alerts')).toEqual({ id: 'proactive-alerts', x: 0, y: 0, w: 4, h: 4 });
  });

  it('is idempotent — second run is a no-op', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        { id: 'morning-review', name: 'Morning Review', builtIn: true, widgets: ['daily-driver'], grid: [{ id: 'daily-driver', x: 0, y: 0, w: 12, h: 6 }] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(result.reason).toBe('already-applied');
  });

  it('only touches the morning-review id, not other or renamed layouts', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'focus',
      layouts: [
        { id: 'focus',           name: 'Focus',            builtIn: true,  widgets: ['cos'], grid: [] },
        { id: 'my-morning',      name: 'My Morning',       builtIn: false, widgets: ['cos'], grid: [] },
        { id: 'morning-review',  name: 'Morning Review',   builtIn: true,  widgets: ['cos'], grid: [] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const after = readJson(layoutsPath);
    expect(after.layouts.find((l) => l.id === 'focus').widgets).toEqual(['cos']);
    expect(after.layouts.find((l) => l.id === 'my-morning').widgets).toEqual(['cos']);
    expect(after.layouts.find((l) => l.id === 'morning-review').widgets).toContain('daily-driver');
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
        { id: 'morning-review', name: 'Morning Review', builtIn: true, widgets: ['review-hub', 'daily-driver'], grid: [{ id: 'review-hub', x: 0, y: 0, w: 4, h: 4 }] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const after = readJson(layoutsPath);
    const entry = after.layouts[0].grid.find((g) => g.id === 'daily-driver');
    expect(entry).toBeDefined();
    expect(after.layouts[0].widgets.filter((w) => w === 'daily-driver')).toHaveLength(1);
  });
});
