import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './374-grok-concrete-model.js';
import { buildCliArgs } from '../../server/lib/cliProviderArgs.js';
import { buildTuiInvocation } from '../../server/lib/tuiHandshake.js';

it('migrates stored placeholders to executable model IDs, preserving custom selections and reruns', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'grok-model-'));
  try {
    await mkdir(join(rootDir, 'data'));
    const path = join(rootDir, 'data/providers.json');
    const config = { providers: {
      'grok-cli': { id: 'grok-cli', command: 'grok', models: ['grok-configured-default', 'grok-4.6', 'custom'], defaultModel: 'grok-configured-default', lightModel: 'custom', mediumModel: 'grok-build', heavyModel: 'grok-configured-default', fallbackModel: 'custom', args: [] },
      'grok-tui': { id: 'grok-tui', type: 'tui', command: 'grok', models: ['custom'], defaultModel: 'custom', args: ['--model', 'custom'] },
      grok: { defaultModel: 'grok-build' }
    } };
    await writeFile(path, JSON.stringify(config));
    await migration.up({ rootDir });
    const first = await readFile(path, 'utf8');
    const { providers } = JSON.parse(first);
    expect(providers['grok-cli']).toMatchObject({ models: ['grok-4.6', 'custom'], defaultModel: 'grok-4.6', lightModel: 'custom', mediumModel: 'grok-4.6', heavyModel: 'grok-4.6', fallbackModel: 'custom' });
    expect(providers['grok-tui']).toEqual(config.providers['grok-tui']);
    expect(providers.grok).toEqual(config.providers.grok);
    expect(buildCliArgs(providers['grok-cli'])).toEqual(expect.arrayContaining(['--model', 'grok-4.6']));
    const tui = { ...providers['grok-cli'], id: 'grok-tui', type: 'tui' };
    expect(buildTuiInvocation(tui, tui.defaultModel).args).toEqual(expect.arrayContaining(['--model', 'grok-4.6']));
    await migration.up({ rootDir });
    expect(await readFile(path, 'utf8')).toBe(first);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
