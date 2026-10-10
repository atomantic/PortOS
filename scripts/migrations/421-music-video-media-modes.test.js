import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A DB import would fail loudly if the migration touched Postgres.
vi.mock('../../server/lib/db.js', () => { throw new Error('ECONNREFUSED'); });

import migration from './421-music-video-media-modes.js';

describe('migration 421 - music video media modes', () => {
  it('migrates the project file without touching PostgreSQL', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'm421-'));
    try {
      await mkdir(join(rootDir, 'data'));
      const file = join(rootDir, 'data', 'music-video-projects.json');
      await writeFile(file, JSON.stringify([{ id: 'a', scenes: [] }]));
      await expect(migration.up({ rootDir })).resolves.toEqual({ success: true });
      expect(JSON.parse(await readFile(file, 'utf8'))[0].mediaMode).toBe('code-images-video');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
