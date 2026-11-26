// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { build, createLogger } from 'vite';

import { CHUNK_GROUPS } from '../../vite.chunkGroups.js';
import viteConfig from '../../vite.config.js';

const CLIENT_DIR = resolve(import.meta.dirname, '../..');

// Resolve against the checked-in lockfiles, not an installed `node_modules`
// tree: the lockfile is deterministic, covers nested (unflattened) transitive
// dependencies the group regexes still match at any depth, and cannot be
// satisfied by a stale directory left behind by an uninstalled package.
const lockedPackageNames = () => {
  const names = new Set();
  for (const lockfile of ['package-lock.json', '../package-lock.json']) {
    const file = resolve(CLIENT_DIR, lockfile);
    if (!existsSync(file)) continue;
    for (const key of Object.keys(JSON.parse(readFileSync(file, 'utf-8')).packages ?? {})) {
      const marker = key.lastIndexOf('node_modules/');
      if (marker !== -1) names.add(key.slice(marker + 'node_modules/'.length));
    }
  }
  return [...names];
};

const LOCKED_PACKAGES = lockedPackageNames();

const isInstalled = (name) => {
  if (name.endsWith('*')) return LOCKED_PACKAGES.some((pkg) => pkg.startsWith(name.slice(0, -1)));
  // A bare `@scope` entry stands for every package published under it.
  if (name.startsWith('@') && !name.includes('/')) {
    return LOCKED_PACKAGES.some((pkg) => pkg.startsWith(`${name}/`));
  }
  return LOCKED_PACKAGES.includes(name);
};

const groupNamed = (name) => CHUNK_GROUPS.find((group) => group.name === name);

// Static import graph of the emitted chunks. A lazy entry is the target of a
// dynamic `import("./x.js")` or of a `__vite__mapDeps` list; its closure is
// every chunk reachable through static `from"./x.js"` / `import"./x.js"`.
// This is what a route downloads before it can run, which the modulepreload
// tags in index.html do not show (#18630).
const staticClosures = (outDir) => {
  const assets = join(outDir, 'assets');
  const files = readdirSync(assets).filter((name) => name.endsWith('.js'));
  const known = new Set(files);
  const sizes = new Map();
  const edges = new Map();
  const lazy = new Set();
  for (const file of files) {
    const code = readFileSync(join(assets, file), 'utf8');
    sizes.set(file, statSync(join(assets, file)).size);
    const targets = (re) => [...code.matchAll(re)].map((m) => m[1]).filter((name) => known.has(name));
    edges.set(file, new Set(targets(/(?:\bfrom\s*|\bimport\s*)["']\.\/([^"']+\.js)["']/g)));
    for (const name of targets(/import\(\s*["']\.\/([^"']+\.js)["']\s*\)/g)) lazy.add(name);
    for (const list of code.matchAll(/__vite__mapDeps=[^[]*\[([^\]]*)\]/g)) {
      for (const dep of list[1].matchAll(/assets\/([^"']+\.js)/g)) if (known.has(dep[1])) lazy.add(dep[1]);
    }
  }
  const closure = (entry) => {
    const seen = new Set();
    const stack = [entry];
    while (stack.length) {
      const file = stack.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      for (const next of edges.get(file)) stack.push(next);
    }
    return seen;
  };
  return { files, lazy, sizes, closure };
};

const assertRouteClosures = (outDir, preloads) => {
  const { files, lazy, sizes, closure } = staticClosures(outDir);
  const initial = new Set();
  for (const href of preloads) for (const file of closure(href.split('/').pop())) initial.add(file);
  const reaches = (set, prefix) => [...set].some((file) => file.startsWith(prefix));
  const reachCount = (prefix) => [...lazy].filter((entry) => reaches(closure(entry), prefix)).length;
  expect(files.some(file => file.startsWith('vendor-charts-'))).toBe(false);
  expect(reachCount('vendor-three-')).toBeLessThanOrEqual(40);
  expect(reachCount('vendor-term-')).toBeLessThanOrEqual(3);
  for (const route of ['Dashboard-', 'Settings-', 'NotFound-']) {
    const entry = files.find((file) => file.startsWith(route) && lazy.has(file));
    expect(entry, route).toBeDefined();
    const extra = [...closure(entry)].filter((file) => !initial.has(file));
    for (const vendor of ['vendor-three-', 'vendor-term-']) {
      expect(reaches(new Set(extra), vendor), `${route} reaches ${vendor}`).toBe(false);
    }
    if (route === 'Dashboard-') {
      const bytes = extra.reduce((sum, file) => sum + sizes.get(file), 0);
      expect(bytes).toBeLessThan(1_500_000);
    }
  }
};

describe('vite chunk groups', () => {
  // The regression: a group regex naming a package that is not installed matches
  // nothing, so the named chunk quietly stops capturing what its comment claims.
  // `vendor-three` shipped that way against the removed `three-fenestra` (#5725).
  it('only names packages that are actually installed', () => {
    const missing = CHUNK_GROUPS.flatMap(({ name, packages }) =>
      (packages ?? []).filter((pkg) => !isInstalled(pkg)).map((pkg) => `${name} -> ${pkg}`));
    expect(LOCKED_PACKAGES.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it('captures the whole three stack on both path separators', () => {
    const { test } = groupNamed('vendor-three');
    expect(test.test('/app/node_modules/three/build/three.module.js')).toBe(true);
    expect(test.test('/app/node_modules/three/examples/jsm/loaders/GLTFLoader.js')).toBe(false);
    expect(test.test('C:\\app\\node_modules\\@react-three\\fiber\\index.js')).toBe(true);
    // A `three`-prefixed package we do not depend on must not be swept in.
    expect(test.test('/app/node_modules/three-globe/index.js')).toBe(false);
  });

  it('passes every CHUNK_GROUPS field through to rolldown, not just name/test', () => {
    const resolved = viteConfig({ command: 'build', mode: 'production' });
    const groups = resolved.build.rolldownOptions.output.codeSplitting.groups;
    expect(groups).toHaveLength(CHUNK_GROUPS.length);
    CHUNK_GROUPS.forEach(({ packages, ...expected }, i) => {
      expect(groups[i]).toEqual(expected);
    });
    // Pin the specific field the regression dropped: without it, this
    // assertion is silently vacuous (both sides simply lack the key).
    const shared = groups.find((g) => g.name === 'app-shared');
    expect(shared.includeDependenciesRecursively).toBe(false);
  });

  it('preserves module execution order when a group opts out of recursive capture', () => {
    const resolved = viteConfig({ command: 'build', mode: 'production' });
    expect(CHUNK_GROUPS.some((group) => group.includeDependenciesRecursively === false)).toBe(true);
    expect(resolved.build.rolldownOptions.output.strictExecutionOrder).toBe(true);
  });

  it('executes cross-chunk superclass modules before their lazy subclass', async () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-chunk-order-'));
    const outputDir = join(root, 'dist');

    try {
      writeFileSync(join(root, 'package.json'), '{"type":"module"}');
      writeFileSync(join(root, 'entry.js'), "globalThis.__portosFeaturePromise = import('./feature.js');\n");
      writeFileSync(join(root, 'base.js'), "globalThis.__portosChunkOrder.push('base'); export class Base {}\n");
      writeFileSync(join(root, 'feature.js'), [
        "import { Base } from './base.js';",
        "globalThis.__portosChunkOrder.push('feature');",
        'export class Feature extends Base {}',
        'export { Base };',
      ].join('\n'));
      writeFileSync(join(root, 'run.mjs'), [
        'globalThis.__portosChunkOrder = [];',
        "await import('./dist/entry.js');",
        'const { Base, Feature } = await globalThis.__portosFeaturePromise;',
        "console.log(JSON.stringify({ order: globalThis.__portosChunkOrder, instanceOfBase: new Feature() instanceof Base }));",
      ].join('\n'));

      await build({
        configFile: false,
        root,
        logLevel: 'silent',
        build: {
          outDir: outputDir,
          emptyOutDir: true,
          minify: false,
          modulePreload: false,
          rolldownOptions: {
            input: resolve(root, 'entry.js'),
            output: {
              strictExecutionOrder: true,
              entryFileNames: '[name].js',
              chunkFileNames: '[name].js',
              codeSplitting: {
                groups: [{
                  name: 'shared-base',
                  test: (id) => /[/\\]base\.js$/.test(id),
                  includeDependenciesRecursively: false,
                }],
              },
            },
          },
        },
      });

      expect(readdirSync(outputDir)).toContain('shared-base.js');
      const result = execFileSync(process.execPath, [join(root, 'run.mjs')], { encoding: 'utf-8', timeout: 10_000 });
      expect(JSON.parse(result)).toEqual({ order: ['base', 'feature'], instanceOfBase: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Cold boot is HTTP/1.1 (six connections per origin). Shared helpers must
  // coalesce, and the lazy vendor chunks must stay out of index.html (#17620).
  it('sets a shared-app size floor below every vendor group', () => {
    const resolved = viteConfig({ command: 'build', mode: 'production' });
    const { minSize, groups } = resolved.build.rolldownOptions.output.codeSplitting;
    expect(minSize).toBe(15_000);
    const initial = groups.find((group) => group.name === 'app-initial');
    const shared = groups.find((group) => group.name === 'app-shared');
    expect(initial.tags).toEqual(['$initial']);
    expect(initial.priority).toBeLessThan(0);
    expect(shared.minShareCount).toBe(2);
    expect(shared.minSize).toBe(15_000);
    expect(shared.entriesAware).toBe(true);
    expect(shared.entriesAwareMergeThreshold).toBe(3_000);
    expect(shared.priority).toBeLessThan(initial.priority);
    for (const group of groups) {
      if (!group.name.startsWith('vendor-')) continue;
      expect(group.priority ?? 0).toBeGreaterThan(initial.priority);
      expect(group.minSize).toBe(0);
    }
    expect(groups.map((group) => group.name)).toEqual(CHUNK_GROUPS.map((group) => group.name));
  });

  it('keeps the cold-boot preload set small and free of lazy vendors', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'portos-chunk-boot-'));
    const warnings = [];
    const logger = createLogger('warn', { allowClearScreen: false });
    const record = (msg) => {
      warnings.push(String(msg));
    };
    logger.warn = record;
    logger.warnOnce = record;
    try {
      await build({
        configFile: resolve(CLIENT_DIR, 'vite.config.js'),
        root: CLIENT_DIR,
        logLevel: 'warn',
        customLogger: logger,
        build: { outDir, emptyOutDir: true },
      });
      const html = readFileSync(join(outDir, 'index.html'), 'utf8');
      const preloads = [...html.matchAll(/<link\b[^>]*>/g)]
        .map((match) => match[0])
        .filter((tag) => /\brel="modulepreload"/.test(tag))
        .map((tag) => tag.match(/\bhref="([^"]+)"/)[1]);
      expect(preloads.length).toBeLessThanOrEqual(12);
      const lazyVendor = /\/vendor-(?:three|term)-/;
      for (const href of preloads) {
        expect(href, href).not.toMatch(lazyVendor);
        const file = join(outDir, href.replace(/^\//, ''));
        const bytes = statSync(file).size;
        const name = href.split('/').pop();
        // Rolldown's runtime, Vite's preload helper, and the shell wrapper that
        // calls `app-initial` are bundler plumbing, not shared app utilities.
        if (bytes < 2048) expect(name, name).toMatch(/^(?:rolldown-runtime|preload-helper|client)-/);
      }
      const jsCount = readdirSync(join(outDir, 'assets')).filter((name) => name.endsWith('.js')).length;
      expect(jsCount).toBeLessThanOrEqual(1000);
      assertRouteClosures(outDir, preloads);
      expect(warnings, warnings.join('\n')).toEqual([]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('keeps package names from bleeding across the separator', () => {
    // A declared name must match a whole path segment: `react` must not swallow
    // `react-redux`. The trailing separator is what enforces that.
    const { test } = groupNamed('vendor-react');
    expect(test.test('/app/node_modules/react/index.js')).toBe(true);
    expect(test.test('/app/node_modules/react-redux/index.js')).toBe(false);
  });
});
