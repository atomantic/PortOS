import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './390-kilo-openchamber-providers.js';

it('adds the disabled presets idempotently without replacing local configuration', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'kilo-openchamber-seed-'));
  await mkdir(join(rootDir, 'data'));
  const path = join(rootDir, 'data/providers.json');
  const custom = { id: 'kilo-cli', command: '/opt/bin/kilo', enabled: true };
  await writeFile(path, JSON.stringify({ activeProvider: 'kilo-cli', providers: { 'kilo-cli': custom } }));

  await migration.up({ rootDir });
  const once = await readFile(path, 'utf8');
  await migration.up({ rootDir });
  expect(await readFile(path, 'utf8')).toBe(once);

  const state = JSON.parse(once);
  expect(state.activeProvider).toBe('kilo-cli');
  expect(state.providers['kilo-cli']).toEqual(custom);
  expect(state.providers['kilo-tui']).toMatchObject({
    enabled: false, models: [], defaultModel: null, command: 'kilo', args: ['--auto'],
  });
  // `--dir`/`--prompt` are supplied at spawn time from the run's real cwd, so a
  // seeded record that baked either would pin the wrong directory forever.
  expect(state.providers['openchamber-cli'].args).toEqual(
    ['session', 'create', '--wait', '--last-assistant', '--quiet'],
  );
  expect(state.providers['openchamber-cli']).toMatchObject({ type: 'cli', enabled: false });
  // OpenChamber's interactive surface is a web app — no PTY record may ship.
  expect(state.providers['openchamber-tui']).toBeUndefined();

  await rm(rootDir, { recursive: true });
});
