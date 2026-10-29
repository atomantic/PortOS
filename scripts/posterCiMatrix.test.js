import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

it('runs the selected poster once in each requested project without moving other captures', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'poster-matrix-test-'));
  const server = fileURLToPath(new URL('../server/', import.meta.url));
  const poster = 'services/codeAnimation/poster.realBrowser.test.js';
  try {
    symlinkSync(join(server, 'node_modules'), join(scratch, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const [path, name] of [[poster, 'poster'], ['lib/filmLook.browser.test.js', 'film'], ['unit.test.js', 'unit']]) {
      const target = join(scratch, path);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, `import { test } from 'vitest'; import { appendFileSync } from 'node:fs'; test('${name}', ({ task }) => appendFileSync(${JSON.stringify(join(scratch, 'events'))}, '${name}:' + task.file.projectName + '\\n'));`);
    }
    const config = join(scratch, 'vitest.config.mjs');
    writeFileSync(config, `import { vitestCaptureProjects } from ${JSON.stringify(new URL('./vitestCiPool.js', import.meta.url).href)}; import { withPosterPlacement } from ${JSON.stringify(new URL('./posterCiMatrixConfig.js', import.meta.url).href)}; const test = { include: ['**/*.test.js'], exclude: ['**/node_modules/**'], maxWorkers: 2 }; test.projects = vitestCaptureProjects(test); export default withPosterPlacement({ test }, process.env.POSTER_MATRIX_PLACEMENT);`);
    for (const placement of ['parallel', 'capture']) {
      writeFileSync(join(scratch, 'events'), '');
      const result = spawnSync(process.execPath, [join(server, 'node_modules/vitest/vitest.mjs'), 'run', '--configLoader', 'runner', '--config', config, '--root', scratch], { cwd: server, encoding: 'utf8', timeout: 30000, env: { ...process.env, POSTER_MATRIX_PLACEMENT: placement } });
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readFileSync(join(scratch, 'events'), 'utf8').trim().split('\n').sort()).toEqual([`film:capture`, `poster:${placement}`, 'unit:parallel'].sort());
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 65000);
