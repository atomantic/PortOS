import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const python = resolveTestPython();

it.skipIf(!python || process.platform === 'win32')('renders from an already detached Wan session', () => {
  const root = mkdtempSync(join(tmpdir(), 'portos-wan-session-'));
  try {
    const upstream = join(root, 'mflux/models/wan/cli/wan_generate.py');
    mkdirSync(dirname(upstream), { recursive: true });
    writeFileSync(join(root, 'mflux/__init__.py'), '');
    writeFileSync(upstream, `import json, sys
from pathlib import Path
Path(sys.argv[sys.argv.index("--output") + 1]).write_text("rendered")
print(json.dumps({"phase": "denoise", "step": 1, "total_steps": 1}))
`);
    const output = join(root, 'output.mp4');
    const script = fileURLToPath(new URL('./generate_wan22.py', import.meta.url));
    const result = spawnSync(python, [
      script, '--model-repo', 'fixture', '--prompt', 'Fixture',
      '--width', '320', '--height', '256', '--output', output,
    ], {
      cwd: root,
      env: { ...process.env, PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: '1' },
      detached: true,
      encoding: 'utf8',
      timeout: 10000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('STAGE:wan-denoise:step:1:1:denoise');
    expect(readFileSync(output, 'utf8')).toBe('rendered');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
