import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rewriteAppsPortosRoot } from './rewriteAppsPortosRoot.js';

describe('rewriteAppsPortosRoot', () => {
  let dataDir;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'portos-apps-root-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('rewrites leftover placeholders in an existing data/apps.json', () => {
    writeFileSync(join(dataDir, 'apps.json'), JSON.stringify({
      apps: {
        'portos-default': {
          repoPath: '__PORTOS_ROOT__',
          appIconPath: '__PORTOS_ROOT__/client/public/portos-logo.png',
        },
      },
    }, null, 2));

    const result = rewriteAppsPortosRoot(dataDir, '/opt/PortOS');
    expect(result.rewritten).toBe(true);

    const parsed = JSON.parse(readFileSync(join(dataDir, 'apps.json'), 'utf8'));
    expect(parsed.apps['portos-default'].repoPath).toBe('/opt/PortOS');
    expect(parsed.apps['portos-default'].appIconPath)
      .toBe('/opt/PortOS/client/public/portos-logo.png');
  });

  it('is a no-op when placeholders are already expanded', () => {
    const body = JSON.stringify({
      apps: { 'portos-default': { repoPath: '/opt/PortOS' } },
    });
    writeFileSync(join(dataDir, 'apps.json'), body);

    const result = rewriteAppsPortosRoot(dataDir, '/opt/PortOS');
    expect(result.rewritten).toBe(false);
    expect(readFileSync(join(dataDir, 'apps.json'), 'utf8')).toBe(body);
  });

  it.each([
    String.raw`C:\apps\PortOS`,
    String.raw`\\example-server\apps\PortOS`,
    '/opt/Example "quoted" checkout',
  ])('round-trips JSON-sensitive checkout paths: %s', (rootDir) => {
    const registry = {
      apps: {
        example: {
          repoPath: '__PORTOS_ROOT__',
          appIconPath: '__PORTOS_ROOT__/client/public/portos-logo.png',
          nested: { command: '__PORTOS_ROOT__/scripts/run' },
          args: ['__PORTOS_ROOT__', '--example'],
        },
        custom: { repoPath: '/opt/custom-checkout', enabled: false },
      },
      version: 1,
    };
    const appsFile = join(dataDir, 'apps.json');
    writeFileSync(appsFile, JSON.stringify(registry));

    rewriteAppsPortosRoot(dataDir, rootDir);

    expect(JSON.parse(readFileSync(appsFile, 'utf8'))).toEqual({
      ...registry,
      apps: {
        ...registry.apps,
        example: {
          repoPath: rootDir,
          appIconPath: `${rootDir}/client/public/portos-logo.png`,
          nested: { command: `${rootDir}/scripts/run` },
          args: [rootDir, '--example'],
        },
      },
    });
    expect(rewriteAppsPortosRoot(dataDir, rootDir).rewritten).toBe(false);
  });

  it('leaves malformed input untouched', () => {
    const appsFile = join(dataDir, 'apps.json');
    const body = '{"apps":{"example":{"repoPath":"__PORTOS_ROOT__"}';
    writeFileSync(appsFile, body);
    expect(() => rewriteAppsPortosRoot(dataDir, '/opt/PortOS')).toThrow(SyntaxError);
    expect(readFileSync(appsFile, 'utf8')).toBe(body);
  });

  it('is a no-op when apps.json is missing', () => {
    expect(rewriteAppsPortosRoot(dataDir, '/opt/PortOS')).toEqual({
      rewritten: false,
      appsFile: join(dataDir, 'apps.json'),
    });
  });
});
