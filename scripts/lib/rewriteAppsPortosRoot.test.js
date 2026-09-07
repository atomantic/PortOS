import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
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

  it('is a no-op when apps.json is missing', () => {
    expect(rewriteAppsPortosRoot(dataDir, '/opt/PortOS')).toEqual({
      rewritten: false,
      appsFile: join(dataDir, 'apps.json'),
    });
  });
});
