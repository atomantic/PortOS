/**
 * The boot smoke's isolation contract (#8343). Running the real smoke is too
 * slow for the suite (CI runs it as its own step), so these pin the two halves
 * a regression would silently undo: the child environment is an allowlist, and
 * the disposable root is seeded like a fresh install, resolvable from a
 * worktree, and never left behind by a failed setup.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildSmokeEnv, createSmokeRoot, SMOKE_DATABASE } from './smoke-boot.js';
import { DATA_ROOT_ENV, resolveInstallRoot } from '../server/lib/dataRoot.js';

const scratch = [];
const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};

afterEach(() => {
  delete process.env[DATA_ROOT_ENV];
  while (scratch.length) rmSync(scratch.pop(), { recursive: true, force: true });
});

describe('buildSmokeEnv', () => {
  it('passes no provider key, token, database credential, or escape hatch to the child', () => {
    const root = join(tmpdir(), 'portos-smoke-example');
    const env = buildSmokeEnv({
      root,
      parentEnv: {
        PATH: '/usr/bin',
        NODE_OPTIONS: '--max-old-space-size=4096',
        ANTHROPIC_API_KEY: 'sk-example',
        OPENAI_API_KEY: 'sk-example',
        PORTOS_API_TOKEN: 'token-example',
        PGPASSWORD: 'secret-example',
        PGDATABASE: 'portos',
        TEST_DB_OK: '1',
        MEMORY_BACKEND: 'postgres',
        PORTOS_DATA_ROOT: '/srv/live-install',
        HOME: '/home/example'
      }
    });

    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PORTOS_API_TOKEN', 'PGPASSWORD', 'TEST_DB_OK', 'MEMORY_BACKEND']) {
      expect(env, key).not.toHaveProperty(key);
    }
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      NODE_ENV: 'test',
      PORTOS_SMOKE_BOOT: '1',
      [DATA_ROOT_ENV]: root,
      HOME: join(root, 'home'),
      TMPDIR: join(root, 'tmp'),
      PGDATABASE: SMOKE_DATABASE,
      HOST: '127.0.0.1',
      NODE_OPTIONS: '--max-old-space-size=4096 --unhandled-rejections=strict'
    });
    expect(SMOKE_DATABASE).toMatch(/_test$/);
  });
});

describe('createSmokeRoot', () => {
  const buildCodeRoot = () => {
    const codeRoot = tempDir('portos-smoke-code-');
    const reference = join(codeRoot, 'data.reference');
    mkdirSync(join(reference, 'private'), { recursive: true });
    writeFileSync(join(reference, 'providers.json'), '{"providers":{}}\n');
    writeFileSync(join(reference, 'apps.json'), '{"apps":{"portos-default":{"repoPath":"__PORTOS_ROOT__"}}}\n');
    // Migration-owned: setup-data never seeds it, so neither may the smoke.
    writeFileSync(join(reference, 'private', 'api-keys.json'), '{}\n');
    return codeRoot;
  };

  it('seeds a fresh-install tree that a worktree-executing server resolves to', () => {
    const codeRoot = buildCodeRoot();
    const root = createSmokeRoot({ codeRoot, tmpBase: tempDir('portos-smoke-base-') });

    expect(existsSync(join(root, 'data.reference', 'providers.json'))).toBe(true);
    expect(existsSync(join(root, 'data', 'providers.json'))).toBe(true);
    expect(existsSync(join(root, 'data', 'private', 'api-keys.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, 'data', 'apps.json'), 'utf8')).apps['portos-default'].repoPath).toBe(codeRoot);
    for (const dir of ['home', 'tmp']) expect(existsSync(join(root, dir)), dir).toBe(true);

    process.env[DATA_ROOT_ENV] = root;
    expect(resolveInstallRoot(join(codeRoot, 'data', 'cos', 'worktrees', 'claim-issue-1'))).toBe(root);
  });

  it('removes its partial tree when seeding fails', () => {
    const codeRoot = tempDir('portos-smoke-code-'); // no data.reference/
    const tmpBase = tempDir('portos-smoke-base-');
    expect(() => createSmokeRoot({ codeRoot, tmpBase })).toThrow();
    expect(readdirSync(tmpBase)).toEqual([]);
  });
});
