import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

it.each(['run', 'skip', 'collection-failure'])('isolates boot imports and explicit fixtures when suites %s', (mode) => {
  const root = mkdtempSync(join(tmpdir(), 'media-setup-contract-'));
  const setup = fileURLToPath(new URL('./vitest.setup.js', import.meta.url));
  const environment = fileURLToPath(new URL('./test/mediaRegistryEnvironment.js', import.meta.url));
  const consumer = fileURLToPath(new URL('./test/fixtures/mediaRegistryImport.js', import.meta.url));
  const vitest = fileURLToPath(new URL('./node_modules/vitest/vitest.mjs', import.meta.url));
  const vitestApi = fileURLToPath(new URL('./node_modules/vitest/dist/index.js', import.meta.url));
  const wrappedEnvironment = join(root, 'environment.mjs');
  writeFileSync(wrappedEnvironment, `
    import environment from ${JSON.stringify(environment)};
    import { channel } from 'node:diagnostics_channel';
    import { writeFileSync } from 'node:fs';
    const lifecycle = channel('portos.composition-browser.lifecycle');
    export default { ...environment, async setup(global, options) {
      const priorSubscriber = lifecycle.hasSubscribers;
      const owner = await environment.setup(global, options);
      return { async teardown() {
        await owner.teardown();
        const child = lifecycle[Symbol.for('portos.synthetic-disposal-child')];
        writeFileSync(child.mark, JSON.stringify({ priorSubscriber, afterSubscriber: lifecycle.hasSubscribers,
          exit: child.listenerCount('exit'), close: child.listenerCount('close') }));
      } };
    } };
  `);
  const config = join(root, 'vitest.config.mjs');
  writeFileSync(config, `export default { test: { environment: ${JSON.stringify(wrappedEnvironment)}, setupFiles: [${JSON.stringify(setup)}], maxWorkers: 1, fileParallelism: false } };`);
  for (const name of ['first', 'second']) {
    writeFileSync(join(root, `${name}.test.mjs`), `
      import { it, expect } from ${JSON.stringify(vitestApi)};
      import { readFileSync, writeFileSync } from 'node:fs';
      import { channel } from 'node:diagnostics_channel';
      import { EventEmitter } from 'node:events';
      const lifecycle = channel('portos.composition-browser.lifecycle');
      const child = new EventEmitter();
      child.mark = ${JSON.stringify(join(root, `${name}-disposal.json`))};
      lifecycle[Symbol.for('portos.synthetic-disposal-child')] = child;
      const profile = process.env.PORTOS_TEST_TEMP_ROOT + '/portos-composition-browser-${name}';
      lifecycle.publish({ event: 'allocated', profile });
      lifecycle.publish({ event: 'child', profile, child });
      import { registry } from ${JSON.stringify(consumer)};
      writeFileSync(${JSON.stringify(join(root, `${name}.json`))}, JSON.stringify({ path: process.env.PORTOS_MEDIA_MODELS_FILE, registry }));
      ${mode === 'collection-failure' ? 'throw new Error("synthetic collection failure");' : ''}
      ${mode === 'skip' ? 'it.skip' : 'it'}('loads during collection', () => {
        const path = process.env.PORTOS_MEDIA_MODELS_FILE;
        expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(registry);
      });
    `);
  }
  const env = { ...process.env, NODE_ENV: 'test', NODE_DISABLE_COMPILE_CACHE: '1' };
  delete env.PORTOS_MEDIA_MODELS_FILE;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  const run = () => spawnSync(process.execPath, [vitest, 'run', '--configLoader', 'native', '--config', config, '--root', root], {
    env, encoding: 'utf8', timeout: 20000,
  });
  try {
    const result = run();
    expect(result.status, result.stdout + result.stderr).toBe(mode === 'collection-failure' ? 1 : 0);
    if (mode === 'collection-failure') expect(result.stderr).toContain('synthetic collection failure');
    for (const name of ['first', 'second']) {
      expect(JSON.parse(readFileSync(join(root, `${name}-disposal.json`), 'utf8')))
        .toEqual({ priorSubscriber: false, afterSubscriber: false, exit: 0, close: 0 });
    }
    const first = JSON.parse(readFileSync(join(root, 'first.json'), 'utf8'));
    const second = JSON.parse(readFileSync(join(root, 'second.json'), 'utf8'));
    expect(first.path).not.toBe(second.path);
    // Both registries were test-owned and removed by their suite teardown.
    expect(() => readFileSync(first.path)).toThrow();
    expect(() => readFileSync(second.path)).toThrow();
    env.PORTOS_MEDIA_MODELS_FILE = join(root, 'explicit.json');
    writeFileSync(env.PORTOS_MEDIA_MODELS_FILE, JSON.stringify({ ...first.registry, fixtureMarker: 'explicit' }));
    const explicit = run();
    expect(explicit.status, explicit.stdout + explicit.stderr).toBe(mode === 'collection-failure' ? 1 : 0);
    expect(JSON.parse(readFileSync(join(root, 'first.json'), 'utf8')).path).toBe(env.PORTOS_MEDIA_MODELS_FILE);
    expect(JSON.parse(readFileSync(env.PORTOS_MEDIA_MODELS_FILE, 'utf8')).fixtureMarker).toBe('explicit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


it('disposes a partial observation subscription when environment setup fails and preserves its error', () => {
  const root = mkdtempSync(join(tmpdir(), 'media-setup-failure-'));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { channel } from 'node:diagnostics_channel';
      import { EventEmitter } from 'node:events';
      const lifecycle = channel('portos.composition-browser.lifecycle');
      const child = new EventEmitter();
      const original = fs.mkdtempSync;
      const failure = new Error('synthetic registry allocation failure');
      fs.mkdtempSync = () => {
        const profile = process.env.PORTOS_TEST_TEMP_ROOT + '/portos-composition-browser-setup';
        lifecycle.publish({ event: 'allocated', profile });
        lifecycle.publish({ event: 'child', profile, child });
        throw failure;
      };
      syncBuiltinESMExports();
      const { default: environment } = await import(${JSON.stringify(new URL('./test/mediaRegistryEnvironment.js', import.meta.url).href)});
      await assert.rejects(environment.setup({ console: {} }, {}), error => error === failure);
      assert.equal(lifecycle.hasSubscribers, false);
      assert.equal(child.listenerCount('exit'), 0);
      assert.equal(child.listenerCount('close'), 0);
      fs.mkdtempSync = original;
      syncBuiltinESMExports();
      const next = await environment.setup({ console: {} }, {});
      assert.equal(lifecycle.hasSubscribers, true);
      await next.teardown();
      assert.equal(lifecycle.hasSubscribers, false);
    `], {
      env: { ...process.env, PORTOS_TEST_TEMP_ROOT: root, PORTOS_MEDIA_MODELS_FILE: '' },
      encoding: 'utf8', timeout: 20000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
