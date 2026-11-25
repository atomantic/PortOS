import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import migration from './465-splash-providers.js';

it('seeds disabled Splash routes exactly like a fresh install without replacing the active or customized routes', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'portos-splash-migration-'));
  try {
    const providerPath = join(rootDir, 'data', 'providers.json');
    const custom = { id: 'splash', name: 'My custom runtime', enabled: true };
    const ollama = { id: 'ollama', enabled: true };
    await mkdir(join(rootDir, 'data'));
    await writeFile(providerPath, JSON.stringify({ activeProvider: 'ollama', providers: { splash: custom, ollama } }));
    expect(await migration.up({ rootDir })).toMatchObject({ ok: true, added: 2 });
    const data = JSON.parse(await readFile(providerPath, 'utf8'));
    const { providers: seed } = JSON.parse(await readFile(new URL('../../data.reference/providers.json', import.meta.url), 'utf8'));
    expect(data).toMatchObject({
      activeProvider: 'ollama', providers: { ollama, splash: custom, 'opencode-splash': seed['opencode-splash'], 'claude-splash': seed['claude-splash'] },
    });
    expect(data.providers['opencode-splash'].enabled).toBe(false);
    expect(data.providers['claude-splash'].enabled).toBe(false);
    expect(await migration.up({ rootDir })).toMatchObject({ ok: true, reason: 'already-present', added: 0 });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
