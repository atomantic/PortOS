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
    expect(test.test('/app/node_modules/three-mesh-bvh/src/index.js')).toBe(true);
    expect(test.test('C:\\app\\node_modules\\@react-three\\fiber\\index.js')).toBe(true);
    // A `three`-prefixed package we do not depend on must not be swept in.
    expect(test.test('/app/node_modules/three-globe/index.js')).toBe(false);
    // three-stdlib (loaders/exporters) is split into its own chunk (#8146).
    expect(test.test('/app/node_modules/three-stdlib/index.js')).toBe(false);
  });

  it('isolates the three-stdlib loaders/exporters into their own chunk (#8146)', () => {
    const { test } = groupNamed('vendor-three-loaders');
    expect(test.test('/app/node_modules/three-stdlib/loaders/GLTFLoader.js')).toBe(true);
    expect(test.test('C:\\app\\node_modules\\three-stdlib\\exporters\\USDZExporter.js')).toBe(true);
    expect(test.test('/app/node_modules/three/build/three.module.js')).toBe(false);
  });

  // The regression this guards against is one step downstream of the two
  // above: `vite.config.js` once handed rolldown a narrowed `{ name, test }`
  // per group, silently dropping every OTHER field — including
  // `includeDependenciesRecursively`, which is what makes the
  // `vendor-three-loaders` split above actually take effect at build time
  // instead of being re-absorbed into `vendor-three` (#8146). The regex-level
  // tests above would keep passing even if this field were dropped again,
  // because they only exercise `vite.chunkGroups.js` in isolation.
  it('passes every CHUNK_GROUPS field through to rolldown, not just name/test', () => {
    const resolved = viteConfig({ command: 'build', mode: 'production' });
    const groups = resolved.build.rolldownOptions.output.codeSplitting.groups;
    expect(groups).toHaveLength(CHUNK_GROUPS.length);
    CHUNK_GROUPS.forEach(({ packages, ...expected }, i) => {
      expect(groups[i]).toEqual(expected);
    });
    // Pin the specific field the regression dropped: without it, this
    // assertion is silently vacuous (both sides simply lack the key).
    const loaders = groups.find((g) => g.name === 'vendor-three-loaders');
    expect(loaders.includeDependenciesRecursively).toBe(false);
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
      const lazyVendor = /\/vendor-(?:three(?:-loaders)?|charts|term)-/;
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
      expect(jsCount).toBeLessThanOrEqual(600);
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
    // Family prefixes still match every member.
    const charts = groupNamed('vendor-charts').test;
    expect(charts.test('/app/node_modules/d3-scale/src/band.js')).toBe(true);
    expect(charts.test('/app/node_modules/victory-vendor/d3-scale.js')).toBe(true);
  });
});
