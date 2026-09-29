import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const SCRIPTS = ['setup.sh', 'setup.ps1', 'update.sh', 'update.ps1'];

describe('slash-do install pin', () => {
  it('SLASHDO_VERSION is an exact semver', () => {
    expect(read('scripts/SLASHDO_VERSION').trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each(SCRIPTS)('%s installs the pinned version from scripts/SLASHDO_VERSION', (file) => {
    const src = read(file);
    expect(src).not.toMatch(/slash-do@latest/);
    expect(src).toMatch(/scripts[\\/]SLASHDO_VERSION/);
    expect(src).toMatch(/npx --yes "slash-do@\$\{?SlashdoVersion\}?"|npx --yes "slash-do@\$\{?SLASHDO_VERSION\}?"/i);
  });
});
