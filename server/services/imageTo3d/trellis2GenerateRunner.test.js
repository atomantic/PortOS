import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trellis2GenerateRunnerScript } from './trellis2.js';
import { resolveTestPython } from '../../lib/testHelper.js';

// Probe for an interpreter that actually runs rather than assuming `python3`:
// on Windows that name is absent and `python` is a Store alias stub that exists
// but fails, so a hardcoded name turns "no Python here" into an opaque
// "Command failed" (see resolveTestPython).

const pyBin = resolveTestPython();

describe.skipIf(!pyBin)('trellis2GenerateRunner', () => {
  it('preserves direct-script imports while exposing the 4K texture size', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'portos-trellis2-runner-'));
    const generateScript = join(fixtureDir, 'generate.py');

    try {
      writeFileSync(join(fixtureDir, 'fixture_module.py'), 'VALUE = "local-import-ok"\n');
      writeFileSync(generateScript, [
        'import argparse',
        'from fixture_module import VALUE',
        'parser = argparse.ArgumentParser()',
        'parser.add_argument("--texture-size", type=int, choices=[512, 1024, 2048])',
        'args = parser.parse_args()',
        'print(f"{VALUE}:{args.texture_size}")',
        '',
      ].join('\n'));

      const output = execFileSync(pyBin, [
        trellis2GenerateRunnerScript(),
        generateScript,
        '--texture-size',
        '4096',
      ], { encoding: 'utf8' });

      expect(output.trim()).toBe('local-import-ok:4096');
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
