import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const python = resolveTestPython();
const script = fileURLToPath(new URL('./auk_voice_worker.py', import.meta.url));

// Run the resident protocol with synthetic audio dependencies, never a model or hardware.
const fixture = String.raw`
import importlib.util, os, sys, tempfile, types
from pathlib import Path
spec = importlib.util.spec_from_file_location("auk_worker", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
soundfile = types.ModuleType("soundfile")
soundfile.write = lambda *args: None
sys.modules["soundfile"] = soundfile
numpy = types.ModuleType("numpy")
numpy.concatenate = lambda chunks, axis: chunks
sys.modules["numpy"] = numpy
infer = types.ModuleType("auk_mlx.infer")
class Engine:
    def __init__(self, *args, **kwargs):
        pass
    def generate(self, *args, **kwargs):
        return [1], 24000
infer.AukMLX = Engine
infer.GenerateOptions = lambda **kwargs: kwargs
sys.modules["auk_mlx.infer"] = infer
original_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as root:
    sys.argv = [sys.argv[1], root]
    try:
        os.chdir(root)
        worker.main()
    finally:
        # Windows cannot remove a directory while it is the process cwd.
        os.chdir(original_cwd)
`;

describe.skipIf(!python)('AuK resident request protocol', () => {
  it('responds to malformed JSON and still processes the next synthesis request', () => {
    const request = { output: 'fixture-output.wav', segments: [{ text: 'Invented words.', seconds: 1 }], instructions: 'Calm', seed: 42 };
    const result = spawnSync(python, ['-c', fixture, script], {
      encoding: 'utf8',
      input: `{malformed private-fixture-token\n${JSON.stringify(request)}\n`,
    });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(result.stderr).toBe('');
    const responses = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(responses).toHaveLength(2);
    expect(responses[0]).toEqual({ ok: false, error: 'JSONDecodeError' });
    expect(responses[1]).toEqual({ ok: true, latencyMs: expect.any(Number), firstAudioMs: expect.any(Number) });
    expect(result.stdout).not.toContain('private-fixture-token');
  });
});
