import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchHomebrewLatestVersion, homebrewPackageFor } from './homebrewPackage.js';

describe('homebrewPackageFor', () => {
  it('tells casks and formulae apart and ignores everything else', () => {
    expect(homebrewPackageFor('/example/Caskroom/claude-code/2.1.0/claude')).toEqual({ manager: 'homebrew', kind: 'cask', name: 'claude-code', thirdPartyTap: false });
    expect(homebrewPackageFor('/example/Cellar/opencode/1.2.3/bin/opencode')).toEqual({ manager: 'homebrew', kind: 'formula', name: 'opencode', thirdPartyTap: false });
    expect(homebrewPackageFor('/example/node/v26/bin/codex')).toBeNull();
    expect(homebrewPackageFor(null)).toBeNull();
  });
});

describe('a formula from a third-party tap', () => {
  // homebrew-core can publish a different formula under the same name, so its
  // version says nothing about what the tap's copy can upgrade to.
  it('is marked and never read from the core API', async () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-brew-'));
    try {
      const keg = join(root, 'Cellar', 'opencode', '1.2.3');
      mkdirSync(join(keg, 'bin'), { recursive: true });
      writeFileSync(join(keg, 'bin', 'opencode'), '');
      writeFileSync(join(keg, 'INSTALL_RECEIPT.json'), JSON.stringify({ source: { tap: 'example/tap' } }));
      const pkg = homebrewPackageFor(join(keg, 'bin', 'opencode'));
      expect(pkg.thirdPartyTap).toBe(true);
      expect(await fetchHomebrewLatestVersion(pkg, { fetchImpl: () => { throw new Error('fetched'); } })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('fetchHomebrewLatestVersion', () => {
  it('reads a formula from its stable version', async () => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ versions: { stable: '1.2.3' } }));
    };
    expect(await fetchHomebrewLatestVersion({ kind: 'formula', name: 'opencode' }, { fetchImpl })).toBe('1.2.3');
    expect(urls).toEqual(['https://formulae.brew.sh/api/formula/opencode.json']);
  });

  it('answers null for a package the API does not list', async () => {
    const fetchImpl = async () => new Response('{}', { status: 404 });
    expect(await fetchHomebrewLatestVersion({ kind: 'cask', name: 'tapped' }, { fetchImpl })).toBeNull();
  });
});
