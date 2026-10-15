import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createVitestTempFixture } from './lib/vitestTempRootFixture.js';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const link = (target, path) => {
  mkdirSync(dirname(path), { recursive: true });
  if (statSync(target).isDirectory()) {
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
  } else {
    // Re-export real helpers without requiring Windows file-symlink privileges.
    writeFileSync(path, `export * from ${JSON.stringify(pathToFileURL(target).href)};\n`);
  }
};
const put = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

// Snapshot bytes and metadata: a replacement with identical contents is a write too.
function snapshot(root) {
  if (!existsSync(root)) return [];
  return [['.', statSync(root).mtimeMs, null], ...readdirSync(root, { recursive: true }).sort().map(name => {
    const path = join(root, name);
    const stat = statSync(path);
    return [name, stat.mtimeMs, stat.isFile() ? readFileSync(path, 'utf8') : null];
  })];
}

function primaryDependencies(host, workspace) {
  const dependencies = join(host, 'primary/node_modules');
  mkdirSync(dependencies, { recursive: true });
  for (const name of ['vite', 'vitest', ...(workspace === 'client' ? ['@vitejs', 'rollup-plugin-visualizer'] : [])]) {
    link(join(REPO, workspace, 'node_modules', name), join(dependencies, name));
  }
  put(join(dependencies, '.vite/keep'), 'primary persistent cache');
  put(join(dependencies, '.vite-temp/keep'), 'primary config scratch');
  return dependencies;
}

function checkout(host, name, workspace, configName, dependencies) {
  const parent = join(host, name);
  mkdirSync(parent);
  put(join(parent, 'package.json'), '{"type":"module"}');
  const fixture = createVitestTempFixture(parent, workspace, 'expect(true).toBe(true);', configName);
  const root = fixture.args[fixture.args.indexOf('--root') + 1];
  unlinkSync(join(root, 'node_modules'));
  link(dependencies, join(root, 'node_modules'));
  put(join(root, 'package.json'), '{"type":"module"}');
  // Copy the real config so import.meta.url names THIS checkout; its existing
  // helpers stay shared read-only, just like dependencies in an ordinary worktree.
  copyFileSync(join(REPO, workspace, configName), join(root, configName));
  for (const file of ['lib/vitestTempRoot.js', 'lib/dbTestFiles.js', 'vitestCiPool.js', 'vitestTempRootSetup.js']) {
    link(join(REPO, 'scripts', file), join(parent, 'scripts', file));
  }
  if (workspace === 'server') {
    mkdirSync(join(root, 'test'), { recursive: true });
    // Both server configs load this environment relative to themselves. Copy
    // its default export intact so registry setup and teardown still run.
    copyFileSync(join(REPO, 'server/test/mediaRegistryEnvironment.js'), join(root, 'test/mediaRegistryEnvironment.js'));
  }
  if (workspace === 'client') copyFileSync(join(REPO, 'client/src/test/timeouts.js'), join(root, 'src/test/timeouts.js'));
  if (workspace === 'server' && configName === 'vitest.config.js') {
    put(join(root, 'lib/filmLook.browser.test.js'), "import { test, expect } from 'vitest'; test('synthetic capture project', () => expect(true).toBe(true));");
  }
  // Exercise the documented npm command's loader, including the DB entry point.
  const scripts = JSON.parse(readFileSync(join(REPO, workspace, 'package.json'), 'utf8')).scripts;
  const args = scripts[configName === 'vitest.config.db.js' ? 'test:db' : 'test'].split(' ').slice(1);
  const configAt = args.indexOf('--config');
  if (configAt === -1) args.push('--config', join(root, configName));
  else args[configAt + 1] = join(root, configName);
  args.push('--root', root, '--maxWorkers', '1');
  // Test roots and the caller's cwd differ from the config's parent directory.
  const cwd = join(parent, 'caller');
  mkdirSync(cwd);
  return { ...fixture, args: [fixture.args[0], ...args], options: { ...fixture.options, cwd }, root };
}

function run({ args, options }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`fixture failed (${code ?? signal}): ${output}`));
    });
  });
}

async function runTogether(fixtures) {
  const results = await Promise.allSettled(fixtures.map(run));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  return results.map(result => result.value);
}

const cachedResults = root => snapshot(root).filter(([name]) => name.endsWith('results.json'));

describe('checkout-owned Vite caches with shared dependencies', () => {
  it('keeps CI artifact-cache restores pointed at the owned test cache roots', () => {
    const workflow = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
    const caches = workflow.split('- name: Cache Vitest transform artifacts').slice(1)
      .map(block => block.split('\n      - name:')[0]);
    expect(caches).toHaveLength(4);
    for (const cache of caches) {
      expect(cache).not.toContain('node_modules/.vite');
      if (cache.includes('key: vitest-server-')) {
        expect(cache).toContain('server/.cache/vitest\n');
        expect(cache).toContain('server/.cache/vitest-db\n');
      } else expect(cache).toContain('client/.cache/vitest\n');
    }
  });

  it.each([
    ['server', 'vitest.config.js', 'vitest'],
    ['server', 'vitest.config.db.js', 'vitest-db'],
    ['client', 'vitest.config.js', 'vitest'],
  ])('%s %s keeps concurrent publications separate and reuses its owned cache', async (workspace, configName, cacheName) => {
    const host = mkdtempSync(join(tmpdir(), 'workspace-cache-'));
    try {
      const dependencies = primaryDependencies(host, workspace);
      const primary = [snapshot(join(dependencies, '.vite')), snapshot(join(dependencies, '.vite-temp'))];
      const a = checkout(host, 'a', workspace, configName, dependencies);
      const b = checkout(host, 'b', workspace, configName, dependencies);
      await runTogether([a, b]);
      const cacheA = join(a.root, '.cache', cacheName);
      const cacheB = join(b.root, '.cache', cacheName);
      expect(cachedResults(cacheA).length).toBeGreaterThan(0);
      expect(cachedResults(cacheB).length).toBeGreaterThan(0);
      const sibling = snapshot(cacheB);
      const names = snapshot(cacheA).map(([name]) => name);
      await run(a);
      expect(snapshot(cacheA).map(([name]) => name)).toEqual(names);
      expect(snapshot(cacheB)).toEqual(sibling);
      expect([snapshot(join(dependencies, '.vite')), snapshot(join(dependencies, '.vite-temp'))]).toEqual(primary);
      rmSync(a.root, { recursive: true });
      expect(existsSync(cacheA)).toBe(false);
      expect(snapshot(cacheB)).toEqual(sibling);
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });

  it('resolves real dev configs relative to each checkout without config-bundle scratch', async () => {
    const host = mkdtempSync(join(tmpdir(), 'workspace-dev-cache-'));
    try {
      const dependencies = primaryDependencies(host, 'client');
      const primary = [snapshot(join(dependencies, '.vite')), snapshot(join(dependencies, '.vite-temp'))];
      const devArgs = JSON.parse(readFileSync(join(REPO, 'client/package.json'), 'utf8')).scripts.dev.split(' ');
      const loaderAt = devArgs.indexOf('--configLoader');
      const loader = loaderAt === -1 ? undefined : devArgs[loaderAt + 1];
      const fixtures = ['a', 'b'].map(name => checkout(host, name, 'client', 'vitest.config.js', dependencies));
      for (const fixture of fixtures) {
        const parent = dirname(fixture.root);
        for (const file of ['vite.config.js', 'vite.buildEnv.js', 'vite.chunkGroups.js']) {
          copyFileSync(join(REPO, 'client', file), join(fixture.root, file));
        }
        put(join(parent, 'package.json'), '{"type":"module","version":"0.0.0"}');
        for (const file of ['lib/portosAuthCore.js', 'server/lib/eidoverseProxyRoutes.js']) link(join(REPO, file), join(parent, file));
        const cache = join(realpathSync(fixture.root), '.cache/vite').replaceAll('\\', '/');
        const script = join(fixture.root, 'inspect-dev.mjs');
        put(script, `import { resolveConfig } from 'vite';
          const config = await resolveConfig({ configFile: ${JSON.stringify(join(fixture.root, 'vite.config.js'))}, configLoader: ${JSON.stringify(loader)} }, 'serve');
          if (config.cacheDir !== ${JSON.stringify(cache)}) throw Error('dev cache escaped its config owner');
          process.stdout.write(config.cacheDir);`);
        fixture.args = [script];
      }
      const outputs = await runTogether(fixtures);
      expect(outputs[0]).not.toBe(outputs[1]);
      expect([snapshot(join(dependencies, '.vite')), snapshot(join(dependencies, '.vite-temp'))]).toEqual(primary);
      expect(fixtures.map(fixture => relative(host, fixture.options.cwd).replaceAll('\\', '/'))).toEqual(['a/caller', 'b/caller']);
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });
});
