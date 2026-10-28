import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { fork } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './022-rename-bible-setting-to-place.js';
import { runMigrations, listPendingMigrations } from '../run-migrations.js';
vi.mock('../../server/lib/fileUtils.js', async (importOriginal) => {
  const { makePathsProxy } = await import('../../server/lib/mockPathsDataRoot.js');
  return makePathsProxy(await importOriginal(), { dataRoot: () => join(rootDir, 'data') });
});

const { listPlaces } = await import('../../server/services/writersRoom/places.js');

let rootDir;
let child;
const migrationName = '022-rename-bible-setting-to-place.js';
const migrationsDir = () => join(rootDir, 'migrations');
const workDir = () => join(rootDir, 'data/writers-room/works/wr-work-aaaa');
const legacyPath = () => join(workDir(), 'settings.json');
const placesPath = () => join(workDir(), 'places.json');
const exists = async (path) => stat(path).then(() => true, (error) => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'migration-022-'));
  await mkdir(workDir(), { recursive: true });
  await mkdir(migrationsDir());
  await writeFile(join(migrationsDir(), migrationName),
    `export { default } from ${JSON.stringify(new URL('./022-rename-bible-setting-to-place.js', import.meta.url).href)};`);
});

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill('SIGKILL');
    });
  }
  child = null;
  await rm(rootDir, { recursive: true, force: true });
});

describe('migration 022 Writers Room settings', () => {
  it('fails without replacing or deleting malformed legacy bytes', async () => {
    const malformed = Buffer.from('{"settings":[{"id":"set-1"}', 'utf8');
    await writeFile(legacyPath(), malformed);

    await expect(migration.up({ rootDir })).rejects.toThrow(/settings\.json/);

    expect(await readFile(legacyPath())).toEqual(malformed);
    expect(await exists(placesPath())).toBe(false);
  });

  it('does not treat a valid JSON envelope without settings as an empty bible', async () => {
    const unexpected = Buffer.from('{"entries":[{"id":"set-1"}]}\n');
    await writeFile(legacyPath(), unexpected);

    await expect(migration.up({ rootDir })).rejects.toThrow(/missing settings array/);

    expect(await readFile(legacyPath())).toEqual(unexpected);
    expect(await exists(placesPath())).toBe(false);
  });

  it('converts valid settings while preserving entries and envelope metadata', async () => {
    const original = {
      settings: [{ id: 'set-1', name: 'Example Place', details: { weather: 'rain' } }],
      updatedAt: '2024-01-01T00:00:00.000Z',
      customField: { retained: true },
    };
    await writeFile(legacyPath(), JSON.stringify(original));

    await migration.up({ rootDir });

    expect(JSON.parse(await readFile(placesPath(), 'utf8'))).toEqual({
      places: original.settings,
      updatedAt: original.updatedAt,
      customField: original.customField,
    });
    expect(await exists(legacyPath())).toBe(false);
  });

  it('retries a killed partial write through the runner without publishing incomplete places', async () => {
    const original = { settings: [{ id: 'set-1', name: 'Example Place', notes: 'Original notes' }] };
    const legacy = JSON.stringify(original);
    await writeFile(legacyPath(), legacy);
    const harness = join(rootDir, 'interrupted-runner.mjs');
    // Pause the actual filesystem write after its first byte, making the
    // interruption deterministic without a large fixture or timing race.
    await writeFile(harness, `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const writeFile = fs.writeFile;
fs.writeFile = async (path, content, ...args) => {
  if (String(path).includes('places.json')) {
    await writeFile(path, content.slice(0, 1), ...args);
    process.send('partial-write');
    await new Promise(() => {});
  }
  return writeFile(path, content, ...args);
};
syncBuiltinESMExports();
const { runMigrations } = await import(${JSON.stringify(new URL('../run-migrations.js', import.meta.url).href)});
await runMigrations({ rootDir: ${JSON.stringify(rootDir)}, migrationsDir: ${JSON.stringify(migrationsDir())} });
`);
    await new Promise((resolve, reject) => {
      let interrupted = false;
      const timer = setTimeout(() => reject(new Error('Runner did not reach the partial write')), 5000);
      child = fork(harness, [], {
        execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env, NODE_ENV: 'test', PORTOS_DATA_ROOT: join(rootDir, 'data'), MEMORY_BACKEND: 'file', PGDATABASE: 'portos_test' },
      });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('message', (message) => {
        interrupted = message === 'partial-write';
        child.kill('SIGKILL');
      });
      child.once('exit', (_code, signal) => {
        clearTimeout(timer);
        if (interrupted && signal === 'SIGKILL') resolve();
        else reject(new Error('Runner exited before the interrupted write'));
      });
    });

    expect(await exists(placesPath())).toBe(false);
    expect(await readFile(legacyPath(), 'utf8')).toBe(legacy);
    expect(await listPendingMigrations({ rootDir, migrationsDir: migrationsDir() })).toEqual([migrationName]);

    await expect(runMigrations({ rootDir, migrationsDir: migrationsDir() })).resolves.toBe(1);

    expect(JSON.parse(await readFile(placesPath(), 'utf8'))).toEqual({ places: original.settings });
    expect(await listPlaces('wr-work-aaaa')).toEqual([
      expect.objectContaining({ name: 'Example Place', notes: 'Original notes' }),
    ]);
    expect(await exists(legacyPath())).toBe(false);
    expect(await listPendingMigrations({ rootDir, migrationsDir: migrationsDir() })).toEqual([]);
  });

  it.each(['{"places":[', '{"settings":[]}', 'null'])(
    'keeps invalid existing places and legacy bytes untouched and pending: %s', async (places) => {
      const legacy = '{"settings":[{"id":"set-1","name":"Example Place"}]}';
      await writeFile(legacyPath(), legacy);
      await writeFile(placesPath(), places);

      await expect(runMigrations({ rootDir, migrationsDir: migrationsDir() })).rejects.toThrow(/places\.json.*repair or move/);

      expect(await readFile(placesPath(), 'utf8')).toBe(places);
      expect(await readFile(legacyPath(), 'utf8')).toBe(legacy);
      expect(await exists(`${legacyPath()}.bak-022`)).toBe(false);
      expect(await listPendingMigrations({ rootDir, migrationsDir: migrationsDir() })).toEqual([migrationName]);
    },
  );

  it('keeps existing places authoritative and retains the legacy bytes in a backup', async () => {
    const legacy = Buffer.from('{"settings":[{"id":"set-legacy"}]}\n');
    const places = Buffer.from('{"places":[{"id":"place-current"}]}\n');
    await writeFile(legacyPath(), legacy);
    await writeFile(placesPath(), places);

    await runMigrations({ rootDir, migrationsDir: migrationsDir() });

    expect(await readFile(placesPath())).toEqual(places);
    expect(await readFile(`${legacyPath()}.bak-022`)).toEqual(legacy);
    expect(await exists(legacyPath())).toBe(false);
    expect(await listPendingMigrations({ rootDir, migrationsDir: migrationsDir() })).toEqual([]);
  });

  it('does not overwrite an earlier backup when both files exist', async () => {
    const legacy = Buffer.from('{"settings":[{"id":"set-new"}]}\n');
    const places = Buffer.from('{"places":[{"id":"place-current"}]}\n');
    const backup = Buffer.from('{"settings":[{"id":"set-earlier"}]}\n');
    await writeFile(legacyPath(), legacy);
    await writeFile(placesPath(), places);
    await writeFile(`${legacyPath()}.bak-022`, backup);

    await expect(migration.up({ rootDir })).rejects.toThrow(/bak-022 already exists/);

    expect(await readFile(legacyPath())).toEqual(legacy);
    expect(await readFile(placesPath())).toEqual(places);
    expect(await readFile(`${legacyPath()}.bak-022`)).toEqual(backup);
  });
});
