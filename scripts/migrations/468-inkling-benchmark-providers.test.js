import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import migration from './468-inkling-benchmark-providers.js';

it('adds each missing Inkling preset with fresh-install defaults and preserves a customized preset', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'portos-inkling-providers-'));
  try {
    const path = join(rootDir, 'data', 'providers.json');
    const { providers: seed } = JSON.parse(await readFile(new URL('../../data.reference/providers.json', import.meta.url), 'utf8'));
    await mkdir(join(rootDir, 'data'));
    await writeFile(path, JSON.stringify({ activeProvider: 'ollama', providers: {} }));

    const ids = ['opencode-splash-tui', 'mkserve', 'opencode-mkserve', 'opencode-mkserve-tui'];
    expect(await migration.up({ rootDir })).toMatchObject({ ok: true, added: ids.length });
    const data = JSON.parse(await readFile(path, 'utf8'));
    expect(data.activeProvider).toBe('ollama');
    for (const id of ids) {
      expect(data.providers[id]).toEqual(seed[id]);
      expect(data.providers[id].enabled).toBe(false);
    }

    data.providers.mkserve.enabled = true;
    await writeFile(path, JSON.stringify(data));
    expect(await migration.up({ rootDir })).toMatchObject({ ok: true, reason: 'already-present', added: 0 });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(data);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
