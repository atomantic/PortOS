import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createVitestTempFixture, runFixtureToCompletion } from './vitestTempRootFixture.js';
import { WORKSPACE_TEST_CACHE_ROOTS } from '../../server/lib/workspaceTestCacheRoots.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
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
  put(join(dependencies, '.vitest-cache/keep'), 'primary filesystem module cache');
  return dependencies;
}

function checkout(host, name, workspace, configName, dependencies) {
  const parent = join(host, name);
  mkdirSync(parent);
  put(join(parent, 'package.json'), '{"type":"module"}');
  const fixture = createVitestTempFixture(parent, workspace, 'expect(true).toBe(true);', configName);
  delete fixture.options.env.PORTOS_CI_BROWSER_OWNER;
  // Not a `_test` database: the DB run lock stands down, so the fixture neither needs `pg` nor queues behind a real run.
  fixture.options.env.PGTESTDATABASE = 'workspace_cache_fixture';
  const root = fixture.args[fixture.args.indexOf('--root') + 1];
  unlinkSync(join(root, 'node_modules'));
  link(dependencies, join(root, 'node_modules'));
  put(join(root, 'package.json'), '{"type":"module"}');
  // Copy the real config so import.meta.url names THIS checkout; its existing
  // helpers stay shared read-only, just like dependencies in an ordinary worktree.
  copyFileSync(join(REPO, workspace, configName), join(root, configName));
  for (const file of ['lib/vitestTempRoot.js', 'lib/testProcessAttribution.js', 'lib/dbTestFiles.js', 'lib/browserSuites.js', 'lib/workspaceTests.js', 'vitestCiPool.js', 'vitestTempRootSetup.js']) {
    link(join(REPO, 'scripts', file), join(parent, 'scripts', file));
  }
  put(join(parent, 'scripts/vitestProcessEnvironment.js'), `export { default } from ${JSON.stringify(pathToFileURL(join(REPO, 'scripts/vitestProcessEnvironment.js')).href)};\n`);
  // The data exclusion belongs to the synthetic checkout, like its cache paths.
  copyFileSync(join(REPO, 'scripts/lib/vitestWatch.js'), join(parent, 'scripts/lib/vitestWatch.js'));
  if (workspace === 'server') {
    // Both configs load this environment relative to themselves. Copy its
    // Node-only support closure intact so setup and teardown run in this checkout.
    for (const file of ['test/dbRunExclusivity.js', 'test/mediaRegistryEnvironment.js', 'test/ownedBrowserDiagnostics.js', 'lib/mockPathsDataRoot.js']) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      copyFileSync(join(REPO, 'server', file), join(root, file));
    }
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
  // This proof exercises cache publication, not DOM behavior. Three client
  // launches otherwise pay for happy-dom against one 15s enclosing budget.
  if (workspace === 'client') {
    args.push('--environment', 'node', '--project', 'parallel');
    // The synthetic test is Node-only even when project settings override CLI
    // environment defaults. Do not initialize DOM or an empty capture project.
    const test = join(root, 'src/lifecycle.test.js');
    put(test, `// @vitest-environment node\n${readFileSync(test, 'utf8')}`);
  }
  // Test roots and the caller's cwd differ from the config's parent directory.
  const cwd = join(parent, 'caller');
  mkdirSync(cwd);
  return { ...fixture, args: [fixture.args[0], ...args], options: { ...fixture.options, cwd }, root };
}

async function run(fixture, signal) {
  const result = await runFixtureToCompletion(fixture, undefined, { signal });
  if (result.error) {
    result.error.stdout = result.stdout;
    result.error.stderr = result.stderr;
    throw result.error;
  }
  const output = `${result.stdout}${result.stderr}`;
  if (result.status !== 0) throw new Error(`fixture failed (${result.status}): ${output}`);
  return output;
}

async function runTogether(fixtures, signal) {
  // Settle every owned child before the caller removes their shared host.
  const results = await Promise.allSettled(fixtures.map(fixture => run(fixture, signal)));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  return results.map(result => result.value);
}

const cachedResults = root => snapshot(root).filter(([name]) => name.endsWith('results.json'));
const cachedModules = root => snapshot(join(root, 'modules')).filter(([name]) => /^[a-f0-9]{40}$/.test(name));

// Assertions are supplied by the owning Vitest workspace; this shared fixture
// imports only Node builtins and dependency-free fixture support.
export async function checkWorkspaceCacheIsolation(workspace, configName, cacheName, expect, signal) {
  const contract = WORKSPACE_TEST_CACHE_ROOTS[configName === 'vitest.config.db.js' ? 'db' : workspace];
  expect(contract.workspace).toBe(workspace);
  expect(contract.cacheDir).toBe(`.cache/${cacheName}`);
    const host = mkdtempSync(join(tmpdir(), 'workspace-cache-'));
    try {
      const dependencies = primaryDependencies(host, workspace);
      const primary = [snapshot(join(dependencies, '.vite')), snapshot(join(dependencies, '.vite-temp'))];
      const a = checkout(host, 'a', workspace, configName, dependencies);
      const b = checkout(host, 'b', workspace, configName, dependencies);
      const primaryModules = snapshot(join(dependencies, '.vitest-cache'));
      await runTogether([a, b], signal);
      expect(snapshot(join(dependencies, '.vitest-cache'))).toEqual(primaryModules);
      const cacheA = join(a.root, '.cache', cacheName);
      const cacheB = join(b.root, '.cache', cacheName);
      expect(cachedResults(cacheA).length).toBeGreaterThan(0);
      expect(cachedResults(cacheB).length).toBeGreaterThan(0);
      // Actual transformed module files, not just a resolved config or metadata.
      for (const cache of [cacheA, cacheB]) {
        expect(cachedModules(cache).length).toBeGreaterThan(0);
      }
      const modules = cachedModules(cacheA);
      const sibling = snapshot(cacheB);
      const names = snapshot(cacheA).map(([name]) => name);
      await run(a, signal);
      expect(cachedModules(cacheA)).toEqual(modules);
      expect(snapshot(cacheA).map(([name]) => name)).toEqual(names);
      expect(snapshot(cacheB)).toEqual(sibling);
      expect(snapshot(join(dependencies, '.vitest-cache'))).toEqual(primaryModules);
      expect([snapshot(join(dependencies, '.vite')), snapshot(join(dependencies, '.vite-temp'))]).toEqual(primary);
      rmSync(a.root, { recursive: true });
      expect(existsSync(cacheA)).toBe(false);
      expect(snapshot(cacheB)).toEqual(sibling);
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
}

export async function checkDevCacheIsolation(expect, signal) {
    const host = mkdtempSync(join(tmpdir(), 'workspace-dev-cache-'));
    try {
      const dependencies = primaryDependencies(host, 'client');
      const primary = [snapshot(join(dependencies, '.vite')), snapshot(join(dependencies, '.vite-temp'))];
      const commands = {
        npm: JSON.parse(readFileSync(join(REPO, 'client/package.json'), 'utf8')).scripts.dev.split(' '),
        PM2: createRequire(import.meta.url)(join(REPO, 'ecosystem.config.cjs')).apps.find(app => app.name === 'portos-ui').args.split(' '),
      };
      // Both launchers load the same real config with the same loader. Inspect
      // each launch command, then resolve each checkout once rather than
      // repeating identical Vite startup for npm and PM2.
      for (const devArgs of Object.values(commands)) {
        const loaderAt = devArgs.indexOf('--configLoader');
        expect(loaderAt === -1 ? undefined : devArgs[loaderAt + 1]).toBe('runner');
      }
      const loader = 'runner';
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
      const outputs = await runTogether(fixtures, signal);
      expect(outputs[0]).not.toBe(outputs[1]);
      expect([snapshot(join(dependencies, '.vite')), snapshot(join(dependencies, '.vite-temp'))]).toEqual(primary);
      expect(fixtures.map(fixture => relative(host, fixture.options.cwd).replaceAll('\\', '/'))).toEqual(['a/caller', 'b/caller']);
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
}
