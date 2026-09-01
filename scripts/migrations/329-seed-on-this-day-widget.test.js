import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './329-seed-on-this-day-widget.js';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

describe('migration 329 — seed On This Day dashboard widget', () => {
  let rootDir;
  let layoutsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-329-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    layoutsPath = join(rootDir, 'data', 'dashboard-layouts.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('does nothing on a fresh install with no persisted layouts', async () => {
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'no-state' });
  });

  it('appends the widget after the existing grid and skips custom layouts', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        {
          id: 'default', name: 'Everything', builtIn: true,
          widgets: ['quick-brain', 'today-agenda'],
          grid: [
            { id: 'quick-brain', x: 0, w: 3, order: 0, h: 2 },
            { id: 'today-agenda', x: 0, w: 4, order: 1, h: 4 },
          ],
        },
        {
          id: 'custom', name: 'Mine', builtIn: false,
          widgets: ['quick-brain'], grid: [{ id: 'quick-brain', x: 0, w: 12, order: 0, h: 2 }],
        },
      ],
    });

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 1 });
    const after = readJson(layoutsPath);
    const seeded = after.layouts.find((layout) => layout.id === 'default');
    expect(seeded.widgets).toEqual(['quick-brain', 'today-agenda', 'on-this-day']);
    expect(seeded.grid.at(-1)).toEqual({ id: 'on-this-day', x: 0, w: 4, order: 2, h: 4 });
    expect(after.layouts.find((layout) => layout.id === 'custom').widgets).toEqual(['quick-brain']);
  });

  it('is idempotent once the widget is present', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        {
          id: 'default', name: 'Everything', builtIn: true,
          widgets: ['on-this-day'],
          grid: [{ id: 'on-this-day', x: 0, w: 4, order: 0, h: 4 }],
        },
      ],
    });

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'already-applied' });
  });
});
