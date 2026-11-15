import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { md5 } from './migrations/_lib.js';
import { runCli } from './regen-shipped-prompt-hashes.js';

let rootDir;
const tablePath = () => join(rootDir, 'data.reference', 'prompts', 'shipped-hashes.json');
const readTable = () => JSON.parse(readFileSync(tablePath(), 'utf-8'));
const writePrompt = (key, body) => {
  const path = join(rootDir, 'data.reference', 'prompts', ...key.split('/'));
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
};

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'regen-shipped-prompt-hashes-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('regen-shipped-prompt-hashes', () => {
  it('records new prompts, then retires the outgoing hash of an edited one', async () => {
    writePrompt('stages/a.md', '# v1\n');
    writePrompt('_partials/p.md', '# p\n');
    writePrompt('skills/jobs/ignored.md', '# job\n');
    expect(await runCli({ rootDir })).toBe(0);
    expect(readTable()).toEqual({
      '_partials/p.md': { current: md5('# p\n'), retired: [] },
      'stages/a.md': { current: md5('# v1\n'), retired: [] },
    });

    writePrompt('stages/a.md', '# v2\n');
    expect(await runCli({ rootDir })).toBe(0);
    expect(readTable()['stages/a.md']).toEqual({ current: md5('# v2\n'), retired: [md5('# v1\n')] });
  });

  it('writes nothing when the table is already current', async () => {
    writePrompt('stages/a.md', '# v1\n');
    await runCli({ rootDir });
    const before = statSync(tablePath()).mtimeMs;
    const text = readFileSync(tablePath(), 'utf-8');
    expect(await runCli({ rootDir })).toBe(0);
    expect(readFileSync(tablePath(), 'utf-8')).toBe(text);
    expect(statSync(tablePath()).mtimeMs).toBe(before);
  });
});
