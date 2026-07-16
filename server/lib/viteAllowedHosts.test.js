import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseAllowedHosts,
  hostIsAllowed,
  rewriteAllowedHosts,
  findViteConfig,
  checkViteHost
} from './viteAllowedHosts.js';

describe('parseAllowedHosts', () => {
  it('reports absent when there is no allowedHosts key', () => {
    const p = parseAllowedHosts('export default defineConfig({ server: { port: 5173 } })');
    expect(p).toMatchObject({ present: false, allowsAll: false, hosts: [] });
  });

  it('detects allowedHosts: true as allow-all', () => {
    const p = parseAllowedHosts('server: { allowedHosts: true }');
    expect(p).toMatchObject({ present: true, allowsAll: true });
  });

  it("detects the 'all' string sentinel", () => {
    const p = parseAllowedHosts("server: { allowedHosts: 'all' }");
    expect(p.allowsAll).toBe(true);
  });

  it('extracts array entries', () => {
    const p = parseAllowedHosts("server: { allowedHosts: ['.ts.net', 'localhost'] }");
    expect(p).toMatchObject({ present: true, allowsAll: false, hosts: ['.ts.net', 'localhost'] });
  });

  it('ignores a commented-out allowedHosts', () => {
    const src = `server: {
      // allowedHosts: true,
      port: 5173
    }`;
    expect(parseAllowedHosts(src).present).toBe(false);
  });

  it('ignores a block-commented allowedHosts', () => {
    const src = 'server: { /* allowedHosts: true */ port: 5173 }';
    expect(parseAllowedHosts(src).present).toBe(false);
  });
});

describe('hostIsAllowed', () => {
  const all = { allowsAll: true, hosts: [] };
  const none = { allowsAll: false, hosts: [] };
  const tailnet = { allowsAll: false, hosts: ['.ts.net'] };

  it('blocks an unknown host when allowedHosts is empty', () => {
    expect(hostIsAllowed(none, 'box.taile8179.ts.net')).toBe(false);
  });

  it('allows everything when allowsAll', () => {
    expect(hostIsAllowed(all, 'null.taile8179.ts.net')).toBe(true);
  });

  it('always allows localhost regardless of config', () => {
    expect(hostIsAllowed(none, 'localhost')).toBe(true);
  });

  it('always allows IPv4 literals (the launch-by-IP escape hatch)', () => {
    expect(hostIsAllowed(none, '100.64.0.1')).toBe(true);
  });

  it('allows an IPv6 literal', () => {
    expect(hostIsAllowed(none, 'fd7a:115c:a1e0::1')).toBe(true);
  });

  it('matches a leading-dot suffix entry against subdomains', () => {
    expect(hostIsAllowed(tailnet, 'box.taile8179.ts.net')).toBe(true);
    expect(hostIsAllowed(tailnet, 'null.taile8179.ts.net')).toBe(true);
  });

  it('matches a leading-dot entry against the bare domain', () => {
    expect(hostIsAllowed(tailnet, 'ts.net')).toBe(true);
  });

  it('does not match an unrelated domain', () => {
    expect(hostIsAllowed(tailnet, 'evil.example.com')).toBe(false);
  });

  it('matches an exact array entry', () => {
    expect(hostIsAllowed({ allowsAll: false, hosts: ['box.taile8179.ts.net'] }, 'box.taile8179.ts.net')).toBe(true);
  });

  it('returns false for an empty hostname', () => {
    expect(hostIsAllowed(all, '')).toBe(false);
  });
});

describe('rewriteAllowedHosts', () => {
  it('replaces an existing array value with true', () => {
    const src = "export default defineConfig({ server: { allowedHosts: ['localhost'] } })";
    const out = rewriteAllowedHosts(src);
    expect(out.ok).toBe(true);
    expect(out.strategy).toBe('replace-value');
    expect(out.content).toContain('allowedHosts: true');
    expect(out.content).not.toContain("['localhost']");
  });

  it('replaces allowedHosts: false with true', () => {
    const out = rewriteAllowedHosts('server: { allowedHosts: false }');
    expect(out.ok).toBe(true);
    expect(out.content).toContain('allowedHosts: true');
  });

  it('bails when the config already allows all hosts', () => {
    const out = rewriteAllowedHosts('server: { allowedHosts: true }');
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/already allows all/);
  });

  it('injects allowedHosts into an existing server block', () => {
    const src = `import { defineConfig } from 'vite';
export default defineConfig({
  server: {
    port: 5173,
  },
});`;
    const out = rewriteAllowedHosts(src);
    expect(out.ok).toBe(true);
    expect(out.strategy).toBe('inject-into-server');
    expect(out.content).toContain('allowedHosts: true,');
    expect(out.content).toContain('port: 5173');
  });

  it('injects a server block into a defineConfig object literal', () => {
    const src = `import { defineConfig } from 'vite';
export default defineConfig({
  plugins: [],
});`;
    const out = rewriteAllowedHosts(src);
    expect(out.ok).toBe(true);
    expect(out.strategy).toBe('inject-server-block');
    expect(out.content).toContain('server: { allowedHosts: true }');
  });

  it('injects a server block into an arrow-returned config object', () => {
    const src = `import { defineConfig } from 'vite';
export default defineConfig(({ mode }) => ({
  plugins: [],
}));`;
    const out = rewriteAllowedHosts(src);
    expect(out.ok).toBe(true);
    expect(out.content).toContain('server: { allowedHosts: true }');
  });

  it('bails on multiple server blocks as ambiguous', () => {
    const src = `defineConfig({ server: { port: 1 }, test: { server: { port: 2 } } })`;
    const out = rewriteAllowedHosts(src);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/multiple server blocks/);
  });

  it('bails when it cannot find a config object', () => {
    const out = rewriteAllowedHosts('const x = 1; module.exports = x;');
    expect(out.ok).toBe(false);
  });
});

describe('findViteConfig', () => {
  let repo;
  const ALLOW_ALL = `import { defineConfig } from 'vite';
export default defineConfig({ server: { allowedHosts: true } });`;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'vite-cfg-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('finds a config at the repo root', async () => {
    await writeFile(join(repo, 'vite.config.js'), ALLOW_ALL);
    const cfg = await findViteConfig(repo);
    expect(cfg?.filename).toBe('vite.config.js');
    expect(cfg?.dir).toBe(repo);
  });

  it('finds a config in the admin/ subdir (critical-mass — the original false-negative)', async () => {
    // `admin` is the critical-mass Vite client dir that produced a bogus
    // "no vite.config was found" warning. It is now a fast-path subdir; the
    // recursive-fallback contract is pinned separately by the nested test below.
    await mkdir(join(repo, 'admin'), { recursive: true });
    await writeFile(join(repo, 'admin', 'vite.config.js'), ALLOW_ALL);
    const cfg = await findViteConfig(repo);
    expect(cfg?.path).toBe(join(repo, 'admin', 'vite.config.js'));
  });

  it('finds a config nested two levels deep via the recursive fallback (unlisted subdir)', async () => {
    // `packages/dashboard` is NOT in the fast-path subdir list, so this only
    // passes if discoverViteConfig actually walks the tree — it pins the fallback.
    await mkdir(join(repo, 'packages', 'dashboard'), { recursive: true });
    await writeFile(join(repo, 'packages', 'dashboard', 'vite.config.ts'), ALLOW_ALL);
    const cfg = await findViteConfig(repo);
    expect(cfg?.path).toBe(join(repo, 'packages', 'dashboard', 'vite.config.ts'));
  });

  it('ignores configs inside node_modules', async () => {
    await mkdir(join(repo, 'node_modules', 'some-dep'), { recursive: true });
    await writeFile(join(repo, 'node_modules', 'some-dep', 'vite.config.js'), ALLOW_ALL);
    const cfg = await findViteConfig(repo);
    expect(cfg).toBeNull();
  });

  it('ignores a stray config inside an example/fixture dir', async () => {
    // A demo/example app's vite config must not be mistaken for the real one.
    await mkdir(join(repo, 'examples', 'demo'), { recursive: true });
    await writeFile(join(repo, 'examples', 'demo', 'vite.config.js'), ALLOW_ALL);
    const cfg = await findViteConfig(repo);
    expect(cfg).toBeNull();
  });

  it('returns null when no config exists', async () => {
    const cfg = await findViteConfig(repo);
    expect(cfg).toBeNull();
  });

  it('reports host allowed for an admin/ config that allows all hosts', async () => {
    await mkdir(join(repo, 'admin'), { recursive: true });
    await writeFile(join(repo, 'admin', 'vite.config.js'), ALLOW_ALL);
    const status = await checkViteHost(repo, 'void.taile8179.ts.net');
    expect(status.hasViteConfig).toBe(true);
    expect(status.allowsAll).toBe(true);
    expect(status.hostAllowed).toBe(true);
  });
});
