import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isAlwaysPublicApiPath, isPeerApiRequestAllowed } from './apiAccessPolicy.js';

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path);
  return entry.name.endsWith('.js') && !entry.name.includes('.test.') ? [path] : [];
});

// Every `/api/…` or `/data/…` literal in a module that dials peers through
// peerFetch. An interpolation right after `/` is a path segment (`x`); any
// other interpolation (a query string or a caller-supplied sub-path) ends the
// literal, and the path is then checked both bare and with a sub-path.
const peerCallSitePaths = () => {
  const found = [];
  for (const file of [...walk(join(SERVER_ROOT, 'services')), ...walk(join(SERVER_ROOT, 'lib'))]) {
    const source = readFileSync(file, 'utf8');
    if (!/import[^;]*\bpeerFetch\b[^;]*from/.test(source)) continue;
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const match of code.matchAll(/(?<=['`}])\/(?:api|data)\/[^'`\s?]*/g)) {
      const literal = match[0].replace(/\/\$\{[^}]*\}/g, '/x').split('${')[0];
      found.push({ file: file.slice(SERVER_ROOT.length + 1), path: literal.toLowerCase() });
    }
  }
  return found;
};

const reachable = (path) => ['GET', 'POST'].some((method) => isAlwaysPublicApiPath(path)
  || isPeerApiRequestAllowed(method, path)
  || isPeerApiRequestAllowed(method, `${path}${path.endsWith('/') ? '' : '/'}x`));

describe('peer API surface (#8387)', () => {
  it('admits every endpoint this version of PortOS calls on a peer', () => {
    const sites = peerCallSitePaths();
    // Guard against a scanner that silently stops finding call sites.
    expect(sites.length).toBeGreaterThan(30);
    expect(sites.map((s) => s.path)).toContain('/api/peer-sync/push');
    expect(sites.filter((site) => !reachable(site.path))).toEqual([]);
  });

  it('scopes methods, exact paths, and prefixes', () => {
    expect(isPeerApiRequestAllowed('POST', '/api/peer-sync/push')).toBe(true);
    expect(isPeerApiRequestAllowed('GET', '/api/peer-sync/manifest')).toBe(true);
    expect(isPeerApiRequestAllowed('HEAD', '/data/images/example.png')).toBe(true);
    expect(isPeerApiRequestAllowed('GET', '/api/apps/')).toBe(true);
    // Operator mutations beside allowed reads stay closed.
    expect(isPeerApiRequestAllowed('POST', '/api/peer-sync/sync-now')).toBe(false);
    expect(isPeerApiRequestAllowed('POST', '/api/sync/brain/apply')).toBe(false);
    expect(isPeerApiRequestAllowed('POST', '/api/apps/example-app/restart')).toBe(false);
    expect(isPeerApiRequestAllowed('GET', '/api/apps/example-app')).toBe(false);
    expect(isPeerApiRequestAllowed('POST', '/api/cos/tasks')).toBe(false);
    expect(isPeerApiRequestAllowed('PUT', '/api/settings')).toBe(false);
    expect(isPeerApiRequestAllowed('POST', '/api/providers/fleet-host/stop')).toBe(false);
    expect(isPeerApiRequestAllowed('GET', '/data/voice-profiles/example.wav')).toBe(false);
    // A prefix rule never matches the bare prefix or a lookalike sibling.
    expect(isPeerApiRequestAllowed('GET', '/api/peer-sync/')).toBe(false);
    expect(isPeerApiRequestAllowed('GET', '/data/images-private/example.png')).toBe(false);
  });

  it('refuses dot, empty, and encoded separator segments', () => {
    for (const path of [
      '/api/peer-sync/../commands/execute',
      '/api/peer-sync/./manifest',
      '/api/peer-sync//manifest',
      '/data/images/%2e%2e/secret.json',
      '/data/images/a%2fb.png',
      '/data/images/..',
    ]) {
      expect(isPeerApiRequestAllowed('GET', path)).toBe(false);
    }
  });
});
