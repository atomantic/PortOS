import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './396-seed-open-threads-widget.js';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

describe('migration 396 — seed Open Threads dashboard widget', () => {
  let rootDir;
  let layoutsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-396-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    layoutsPath = join(rootDir, 'data', 'dashboard-layouts.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('does nothing on a fresh install with no persisted layouts', async () => {
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'no-state' });
  });

  it('appends the widget to the Everything layout only, in post-#269 grid shape', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        {
          id: 'default', name: 'Everything', builtIn: true,
          widgets: ['quick-brain', 'on-this-day'],
          grid: [
            { id: 'quick-brain', x: 0, w: 3, order: 0, h: 2 },
            { id: 'on-this-day', x: 4, w: 4, order: 1, h: 4 },
          ],
        },
        {
          id: 'morning-review', name: 'Morning Review', builtIn: true,
          widgets: ['review-hub'], grid: [{ id: 'review-hub', x: 0, w: 4, order: 0, h: 4 }],
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
    expect(seeded.widgets).toEqual(['quick-brain', 'on-this-day', 'open-threads']);
    expect(seeded.grid.at(-1)).toEqual({ id: 'open-threads', x: 0, w: 4, order: 2, h: 4 });
    expect(after.layouts.find((layout) => layout.id === 'morning-review').widgets).toEqual(['review-hub']);
    expect(after.layouts.find((layout) => layout.id === 'custom').widgets).toEqual(['quick-brain']);
  });

  it('is idempotent once the widget is present', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        {
          id: 'default', name: 'Everything', builtIn: true,
          widgets: ['open-threads'],
          grid: [{ id: 'open-threads', x: 0, w: 4, order: 0, h: 4 }],
        },
      ],
    });

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'already-applied' });
  });
});
