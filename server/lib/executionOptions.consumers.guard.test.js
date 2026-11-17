import { posixPath } from './testHelper.js';
import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function consumers(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await consumers(path));
    else if (entry.name.endsWith('.jsx') && !entry.name.includes('.test.')) {
      if (/<ProviderModelSelector\b/.test(await readFile(path, 'utf8'))) found.push(posixPath(relative(root, path)));
    }
  }
  return found;
}

describe('execution option consumer inventory', () => {
  it('keeps every shared selection surface in the persistence checklist', async () => {
    const inventory = await readFile(join(root, 'docs/EXECUTION_OPTIONS.md'), 'utf8');
    const files = await consumers(join(root, 'client/src'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(inventory, file).toContain('`' + file + '`');
  });
});
