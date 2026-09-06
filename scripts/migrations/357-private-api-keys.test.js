import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './357-private-api-keys.js';

it('migrates from input even with an existing destination and preserves newer stored keys on retry', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'keys-migration-'));
  try {
    await mkdir(join(rootDir, 'data/private'), { recursive: true });
    await writeFile(join(rootDir, 'data/private/api-keys.json'), JSON.stringify({ schemaVersion: 1, keys: { civitai: 'example-new' } }));
    await writeFile(join(rootDir, 'data/settings.json'), JSON.stringify({ civitai: { apiKey: 'example-old' }, imageGen: { hfToken: 'hf_example', mode: 'local' } }));
    await migration.up({ rootDir });
    await migration.up({ rootDir });
    const store = JSON.parse(await readFile(join(rootDir, 'data/private/api-keys.json'), 'utf8'));
    expect(store.keys).toEqual({ civitai: 'example-new', huggingface: 'hf_example' });
    expect(JSON.parse(await readFile(join(rootDir, 'data/settings.json'), 'utf8'))).toEqual({ civitai: {}, imageGen: { mode: 'local' } });
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});
