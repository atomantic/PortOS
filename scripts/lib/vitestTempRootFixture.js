// Dependency-free subprocess fixtures: each workspace runs its own lifecycle cases.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));

export function createVitestTempFixture(host, workspace, body) {
  const root = join(host, 'fixture');
  mkdirSync(root);
  symlinkSync(join(repo, workspace, 'node_modules'), join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  mkdirSync(join(root, 'src/test'), { recursive: true });
  writeFileSync(join(root, 'src/test/setup.js'), '');
  // Generated workflow suites need the same private, real coordinators as the
  // ordinary server runner, even though their setup omits unrelated mocks.
  writeFileSync(join(root, 'vitest.setup.js'), workspace === 'server'
    ? `import ${JSON.stringify(new URL('../../server/lib/admissionTestSetup.js', import.meta.url).href)};\n`
    : '');
  const testFile = workspace === 'client' ? 'src/lifecycle.test.js' : 'lifecycle.test.js';
  writeFileSync(join(root, testFile), `
    import { test, expect } from 'vitest';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { writeFileSync } from 'node:fs';
    import { bootstrapVitestTempRoot } from ${JSON.stringify(new URL('./vitestTempRoot.js', import.meta.url).href)};
    test('lifecycle', async () => {
      const first = tmpdir();
      expect(bootstrapVitestTempRoot()).toBe(first);
      expect(process.env.PORTOS_TEST_TEMP_ROOT).toBe(first);
      ${body}
    });
  `);
  const env = { ...process.env, TMPDIR: host, TMP: host, TEMP: host, NODE_DISABLE_COMPILE_CACHE: '1' };
  delete env.PORTOS_TEST_TEMP_ROOT;
  delete env.VITEST_FAST;
  return {
    args: [join(repo, workspace, 'node_modules/vitest/vitest.mjs'), 'run',
      '--config', join(repo, workspace, 'vitest.config.js'), '--root', root, '--maxWorkers', '1'],
    options: { cwd: join(repo, workspace), env, encoding: 'utf8', timeout: 20000 },
  };
}
