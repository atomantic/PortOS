import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import migration from './399-vllm-concise-default.js';

describe('vLLM concise default migration', () => {
  it('fills only unset vLLM wrapper defaults', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'vllm-concise-'));
    await mkdir(join(rootDir, 'data'));
    await writeFile(join(rootDir, 'data/providers.json'), JSON.stringify({ providers: {
      'opencode-vllm': { id: 'opencode-vllm' },
      'opencode-vllm-tui': { id: 'opencode-vllm-tui', thinking: true },
      other: { id: 'other' },
    }}));
    await migration.up({ rootDir });
    const providers = JSON.parse(await readFile(join(rootDir, 'data/providers.json'), 'utf8')).providers;
    expect(providers['opencode-vllm'].thinking).toBe(false);
    expect(providers['opencode-vllm-tui'].thinking).toBe(true);
    expect(providers.other.thinking).toBeUndefined();
    await rm(rootDir, { recursive: true });
  });
});
