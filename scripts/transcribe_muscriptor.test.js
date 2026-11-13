import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const script = join(dirname(fileURLToPath(import.meta.url)), 'transcribe_muscriptor.py');
const python = resolveTestPython();

// Match the published muscriptor 0.4.0 API: transcribe_and_postprocess returns
// (MIDI bytes, optional beat grid). Deliberately no transcribe_to_midi method:
// the old runner called that nonexistent method after loading the weights.
const run = (scenario) => JSON.parse(execFileSync(python, ['-c', `
import json, pathlib, subprocess, sys, tempfile
script, scenario = sys.argv[1:]
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    audio = root / 'input.wav'
    if scenario != 'missing-input':
        audio.write_bytes(b'fixture audio')
    output = root / 'nested' / 'result.mid'
    (root / 'muscriptor.py').write_text('''
from pathlib import Path
class TranscriptionModel:
    @classmethod
    def load_model(cls, size):
        assert size == 'small'
        return cls()
    def transcribe_and_postprocess(self, audio):
        assert Path(audio).read_bytes() == b'fixture audio'
        SCENARIO
'''.replace('SCENARIO', {
        'empty': 'return b"", None',
        'failure': 'raise RuntimeError("fixture transcription failed")',
    }.get(scenario, 'return bytes.fromhex("4d546864000000060000000100604d54726b0000000400ff2f00"), {"bpm": 120}')))
    # The failure path uses the shared lazy error translator. Its HF-specific
    # behavior is covered separately; this fixture needs only the class shape.
    hub = root / 'huggingface_hub'
    hub.mkdir()
    (hub / '__init__.py').write_text('')
    (hub / 'errors.py').write_text('class HfHubHTTPError(Exception): pass\\nclass RepositoryNotFoundError(HfHubHTTPError): pass\\nclass GatedRepoError(RepositoryNotFoundError): pass\\n')
    env = __import__('os').environ.copy()
    env.update(HF_HOME=str(root / 'hf-home'), HF_HUB_CACHE=str(root / 'hf-cache'), PYTHONPATH=str(root))
    result = subprocess.run([sys.executable, script, '--audio', str(audio), '--output', str(output), '--model', 'small', '--runtime-dir', str(root)], capture_output=True, text=True, env=env)
    print(json.dumps({'status': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr, 'output': output.read_bytes().hex() if output.exists() else None, 'path': str(output)}))
`, script, scenario], { encoding: 'utf8' }));

describe.skipIf(!python)('MuScriptor transcription CLI', () => {
  it('uses the published tuple API and writes MIDI bytes, not the beat grid', () => {
    const result = run('success');
    expect(result.status).toBe(0);
    expect(result.output).toBe('4d546864000000060000000100604d54726b0000000400ff2f00');
    expect(JSON.parse(result.stdout.trim().replace(/^RESULT:/, ''))).toEqual({
      output: result.path, model: 'small', bytes: 26,
    });
    expect(result.stderr.trim().split(/\r?\n/)).toEqual([
      'STAGE:import-runtime', 'STAGE:download-model:small',
      'STAGE:transcribe:input.wav', 'STAGE:write-midi', 'STAGE:done',
    ]);
  });

  it('does not publish an empty MIDI result even when the API returns a tuple', () => {
    const result = run('empty');
    expect(result.status).toBe(1);
    expect(result.output).toBeNull();
    expect(result.stdout).not.toContain('RESULT:');
    expect(result.stderr).toContain('ERROR: muscriptor returned no MIDI data');
    expect(result.stderr).not.toContain('STAGE:write-midi');
  });

  it('preserves transcription failures without creating an output or success marker', () => {
    const result = run('failure');
    expect(result.status).not.toBe(0);
    expect(result.output).toBeNull();
    expect(result.stdout).not.toContain('RESULT:');
    expect(result.stderr).toContain('USER_ERROR:unknown');
    expect(result.stderr).toContain('fixture transcription failed');
    expect(result.stderr).not.toContain('STAGE:write-midi');
  });

  it('refuses missing audio before loading the runtime', () => {
    const result = run('missing-input');
    expect(result.status).toBe(2);
    expect(result.output).toBeNull();
    expect(result.stderr).toContain('ERROR: audio file not found');
    expect(result.stderr).not.toContain('STAGE:import-runtime');
  });
});
