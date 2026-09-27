import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const python = resolveTestPython();
const script = fileURLToPath(new URL('./diagnose_minimax_h3.py', import.meta.url));
const run = (source) => execFileSync(python, ['-c', source, script], { encoding: 'utf8' });
const load = `
import importlib.util, sys, tempfile, json
from pathlib import Path
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location('diagnostic', sys.argv[1])
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)
`;

describe.skipIf(!python)('H3 continuity diagnostic', () => {
  it('writes a reproducible synthetic plan without launching a process or accepting existing output', () => {
    expect(run(`${load}
def forbidden(*args, **kwargs):
    raise AssertionError('planning launched a process')
d.subprocess.run = forbidden
with tempfile.TemporaryDirectory() as root:
    output = Path(root) / 'comparison'
    sys.argv = [str(d.__file__), '--output-dir', str(output)]
    d.main()
    plan = json.loads((output / 'plan.json').read_text())
    assert plan['continuity'] == 'not_assessed'
    assert plan['sample_frames'] == [0, 1, 12, 60, 123]
    assert len(plan['cases']) == 3
    assert plan['cases'][0]['prompt'] == plan['cases'][1]['prompt']
    assert plan['cases'][1]['prompt'] != plan['cases'][2]['prompt']
    assert (output / 'source.ppm').read_bytes().startswith(b'P6\\n768 1344\\n255\\n')
    try:
        d.main()
    except FileExistsError:
        pass
    else:
        raise AssertionError('existing evidence was overwritten')
print('ok')
`)).toContain('ok');
  });

  it('observes real pipeline boundaries without replacing tensors and restores hooks after decode failure', () => {
    expect(run(`${load}
features = SimpleNamespace(shape=(1, 20, 5120))
tags = SimpleNamespace(tolist=lambda: [0, 1, 1])
rows = SimpleNamespace(shape=(576, 96))
encode_result = (features, tags)
def fail_decode(*args):
    raise ValueError('decode failed')
def dit(*args, **kwargs):
    return rows
pipe = SimpleNamespace(text_encoder=SimpleNamespace(encode=lambda *a: encode_result),
    _encode_keyframes=lambda *a: rows, dit=dit,
    _decode_video=fail_decode, _decode_audio=lambda *a: rows)
report = {'timings': {}}
ticks = iter([10, 13])
restore = d.instrument(pipe, report, clock=lambda: next(ticks))
assert pipe.text_encoder.encode('motion', [object()]) is encode_result
assert pipe._encode_keyframes([object()], 1024, 576) is rows
video = SimpleNamespace(shape=(1, 1000, 96))
audio = SimpleNamespace(shape=(1, 414, 32))
positions = SimpleNamespace(shape=(1500, 3))
indices = SimpleNamespace(size=10)
assert pipe.dit(video, audio, features, None, None, tags, positions, indices, indices, indices) is rows
try:
    pipe._decode_video(rows)
except ValueError:
    pass
finally:
    restore()
assert pipe.dit is dit and pipe._decode_video is fail_decode
assert report['timings']['decode_video_seconds'] == 3
assert report['vae_conditioning_shape'] == [576, 96]
assert report['packed_conditioning']['position_shape'] == [1500, 3]
assert report['vision_conditioning']['token_tag_counts'] == {'0': 1, '1': 2}
print('ok')
`)).toContain('ok');
  });

  it('stops comparisons at a failed render and never starts the next GPU job', () => {
    expect(run(`${load}
calls = []
def fail(command, **kwargs):
    calls.append(command)
    assert kwargs['check'] is True
    assert kwargs['env']['HF_HUB_OFFLINE'] == '1'
    raise d.subprocess.CalledProcessError(1, command)
with tempfile.TemporaryDirectory() as root:
    try:
        d.run_cases(Path(root), Path('runtime'), d.experiment_cases(), run=fail)
    except d.subprocess.CalledProcessError:
        pass
    else:
        raise AssertionError('failure was swallowed')
assert len(calls) == 1
print('ok')
`)).toContain('ok');
  });
});
