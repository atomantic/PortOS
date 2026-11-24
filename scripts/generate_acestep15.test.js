import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython, PY_SUBPROCESS_TIMEOUT_MS } from '../server/lib/testHelper.js';

const script = join(dirname(fileURLToPath(import.meta.url)), 'ml', 'generate_acestep15.py');
const pyBin = resolveTestPython();
const PINNED_REVISION = '19671f406d603126926c1b7e2adc169acbcade22';

const runPython = (body, extraArgs = []) => execFileSync(pyBin, ['-c', [
  'import importlib.util, json, sys',
  'spec = importlib.util.spec_from_file_location("acestep15_runner", sys.argv[1])',
  'mod = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(mod)',
  body,
].join('\n'), script, ...extraArgs], {
  encoding: 'utf8',
  timeout: PY_SUBPROCESS_TIMEOUT_MS,
}).trim();

describe.skipIf(!pyBin)('generate_acestep15 revision pinning', () => {
  it('requires --revision on the CLI', () => {
    const res = spawnSync(pyBin, [script, '--text', 'bright pop', '--output', '/tmp/out.wav'], {
      encoding: 'utf8',
      timeout: PY_SUBPROCESS_TIMEOUT_MS,
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('--revision');
  });

  it.each(['main', 'HEAD', 'abc123', 'g'.repeat(40), 'a'.repeat(39), `${PINNED_REVISION}-extra`])(
    'rejects non-40-hex revision %s before resolving snapshots',
    (badRevision) => {
      const res = spawnSync(pyBin, [
        script, '--model', 'ACE-Step/Ace-Step1.5', '--revision', badRevision,
        '--text', 'bright pop', '--output', '/tmp/out.wav',
      ], {
        encoding: 'utf8',
        timeout: PY_SUBPROCESS_TIMEOUT_MS,
      });
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('--revision');
      expect(() => runPython(`mod.cached_checkpoint_dir("ACE-Step/Ace-Step1.5", ${JSON.stringify(badRevision)})`)).toThrow();
    },
  );

  it('passes normalized revision and local_files_only=True to snapshot_download', () => {
    const out = runPython([
      'from types import SimpleNamespace',
      'calls = []',
      'def fake_snapshot_download(**kwargs):',
      '    calls.append(kwargs)',
      '    return "/tmp/fake-snapshot"',
      'sys.modules["huggingface_hub"] = SimpleNamespace(snapshot_download=fake_snapshot_download)',
      `path = mod.cached_checkpoint_dir("ACE-Step/Ace-Step1.5", ${JSON.stringify(PINNED_REVISION.toUpperCase())})`,
      'print(json.dumps({"path": path, "calls": calls}))',
    ].join('\n'));
    expect(JSON.parse(out)).toEqual({
      path: '/tmp/fake-snapshot',
      calls: [{
        repo_id: 'ACE-Step/Ace-Step1.5',
        revision: PINNED_REVISION,
        local_files_only: true,
      }],
    });
  });

  it('threads --revision from CLI args into snapshot_download before loading ace-step', () => {
    const out = runPython([
      'from types import SimpleNamespace',
      'calls = []',
      'def fake_snapshot_download(**kwargs):',
      '    calls.append(kwargs)',
      '    raise FileNotFoundError("not cached in test")',
      'sys.modules["huggingface_hub"] = SimpleNamespace(snapshot_download=fake_snapshot_download)',
      `sys.argv = ["generate_acestep15.py", "--model", "ACE-Step/Ace-Step1.5", "--revision", ${JSON.stringify(PINNED_REVISION)}, "--text", "bright pop", "--output", "/tmp/out.wav"]`,
      'rc = mod.main()',
      'print(json.dumps({"rc": rc, "calls": calls}))',
    ].join('\n'));
    expect(JSON.parse(out)).toEqual({
      rc: 1,
      calls: [{
        repo_id: 'ACE-Step/Ace-Step1.5',
        revision: PINNED_REVISION,
        local_files_only: true,
      }],
    });
  });
});
