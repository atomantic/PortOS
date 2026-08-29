import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './310-remove-activity-streak-widget.js';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

describe('migration 310 — remove activity streak dashboard widget', () => {
  let rootDir;
  let layoutsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-310-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    layoutsPath = join(rootDir, 'data', 'dashboard-layouts.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('removes the widget from built-in and custom layouts while preserving other widgets', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        {
          id: 'default', widgets: ['quick-task', 'activity-streak', 'daily-post'],
          grid: [
            { id: 'quick-task', x: 0, w: 6, order: 0, h: 5 },
            { id: 'activity-streak', x: 6, w: 3, order: 1, h: 3 },
            { id: 'daily-post', x: 9, w: 3, order: 2, h: 3 },
          ],
        },
        { id: 'custom', widgets: ['activity-streak', 'tribe-care'], grid: [] },
      ],
    });

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 2 });
    const after = readJson(layoutsPath);
    expect(after.layouts[0].widgets).toEqual(['quick-task', 'daily-post']);
    expect(after.layouts[0].grid).toEqual([
      { id: 'quick-task', x: 0, w: 6, order: 0, h: 5 },
      { id: 'daily-post', x: 9, w: 3, order: 2, h: 3 },
    ]);
    expect(after.layouts[1].widgets).toEqual(['tribe-care']);
  });

  it('is safe when no saved layout contains the widget', async () => {
    writeJson(layoutsPath, { layouts: [{ id: 'default', widgets: ['daily-post'], grid: [] }] });
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'already-applied' });
  });
});
