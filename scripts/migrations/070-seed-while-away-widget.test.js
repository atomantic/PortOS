import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './070-seed-while-away-widget.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 070 — seed while-away widget into default + agent-watch layouts', () => {
  let rootDir;
  let layoutsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-070-'));
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

  it('inserts while-away into both target layouts at their preferred slots', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        {
          id: 'default',
          name: 'Everything',
          builtIn: true,
          widgets: ['cos'],
          grid: [{ id: 'cos', x: 4, y: 14, w: 5, h: 4 }],
        },
        {
          id: 'agent-watch',
          name: 'Agent Watch',
          builtIn: true,
          widgets: ['cos'],
          grid: [{ id: 'cos', x: 0, y: 0, w: 6, h: 5 }],
        },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(2);
    const after = readJson(layoutsPath);

    const def = after.layouts.find((l) => l.id === 'default');
    expect(def.widgets).toContain('while-away');
    expect(def.grid.find((g) => g.id === 'while-away')).toEqual({ id: 'while-away', x: 9, y: 15, w: 3, h: 3 });

    const watch = after.layouts.find((l) => l.id === 'agent-watch');
    expect(watch.widgets).toContain('while-away');
    expect(watch.grid.find((g) => g.id === 'while-away')).toEqual({ id: 'while-away', x: 6, y: 3, w: 6, h: 5 });
  });

  it('is idempotent — second run is a no-op', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        { id: 'default', name: 'Everything', builtIn: true, widgets: ['while-away'], grid: [{ id: 'while-away', x: 9, y: 14, w: 3, h: 5 }] },
        { id: 'agent-watch', name: 'Agent Watch', builtIn: true, widgets: ['while-away'], grid: [{ id: 'while-away', x: 6, y: 3, w: 6, h: 5 }] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(result.reason).toBe('already-applied');
  });

  it('only touches the default + agent-watch ids, not other or renamed layouts', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'focus',
      layouts: [
        { id: 'focus',       name: 'Focus',        builtIn: true,  widgets: ['cos'], grid: [] },
        { id: 'my-watch',    name: 'My Watch',     builtIn: false, widgets: ['cos'], grid: [] },
        { id: 'agent-watch', name: 'Agent Watch',  builtIn: true,  widgets: ['cos'], grid: [] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const after = readJson(layoutsPath);
    expect(after.layouts.find((l) => l.id === 'focus').widgets).toEqual(['cos']);
    expect(after.layouts.find((l) => l.id === 'my-watch').widgets).toEqual(['cos']);
    expect(after.layouts.find((l) => l.id === 'agent-watch').widgets).toContain('while-away');
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
          id: 'default',
          name: 'Everything',
          builtIn: true,
          widgets: ['cos', 'while-away'],
          grid: [{ id: 'cos', x: 4, y: 14, w: 5, h: 4 }],
        },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const after = readJson(layoutsPath);
    const entry = after.layouts[0].grid.find((g) => g.id === 'while-away');
    expect(entry).toBeDefined();
    expect(after.layouts[0].widgets.filter((w) => w === 'while-away')).toHaveLength(1);
  });

  it('appends below existing items when the preferred slot is occupied', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        {
          id: 'default',
          name: 'Everything',
          builtIn: true,
          widgets: ['cos'],
          // Something already sits in the preferred slot (x:9,y:14).
          grid: [{ id: 'cos', x: 9, y: 14, w: 3, h: 5 }],
        },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const after = readJson(layoutsPath);
    const newEntry = after.layouts[0].grid.find((g) => g.id === 'while-away');
    expect(newEntry).toBeDefined();
    expect(newEntry.x).toBe(0);
    expect(newEntry.y).toBeGreaterThanOrEqual(19);
  });

  it('keeps the agent-watch preferred width (6) when the slot is occupied', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'agent-watch',
      layouts: [
        {
          id: 'agent-watch',
          name: 'Agent Watch',
          builtIn: true,
          widgets: ['system-health'],
          // Occupies the preferred slot (x:6,y:3) so the fallback path runs.
          grid: [{ id: 'system-health', x: 6, y: 3, w: 6, h: 5 }],
        },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const after = readJson(layoutsPath);
    const newEntry = after.layouts[0].grid.find((g) => g.id === 'while-away');
    expect(newEntry).toBeDefined();
    // Fallback must carry the layout's preferred width, not the bare default.
    expect(newEntry.w).toBe(6);
    expect(newEntry.h).toBe(5);
  });
});
