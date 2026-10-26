import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const dir = dirname(fileURLToPath(import.meta.url));
const script = join(dir, 'minimax_h3_cuda_history.py');
const python = resolveTestPython();
const run = (source) => execFileSync(python, ['-c', source, script], { encoding: 'utf8', timeout: 30_000 }).trim();
const imports = 'import sys\nfrom pathlib import Path\nsys.path.insert(0, str(Path(sys.argv[1]).parent))\nimport minimax_h3_cuda_history as history\n';
let native = false;
if (python) {
  try {
    execFileSync(python, ['-c', 'from importlib.metadata import version; import importlib.util as u; assert version("diffusers") == "0.42.0"; assert all(u.find_spec(p) for p in ("torch", "av"))'], { stdio: 'ignore', timeout: 30_000 });
    native = true;
  } catch { /* Native tensor/media fixtures require the optional installed CUDA dependencies. */ }
}

describe.skipIf(!python)('H3 CUDA history runner', () => {
  it('rejects incompatible packages and changed hooks before importing the pipeline', () => {
    expect(run(`${imports}
import tempfile, types
args = types.SimpleNamespace(model_repo=history.CONTRACT['model']['repo'], model_revision=history.CONTRACT['model']['revision'])
history.importlib.metadata.distribution = lambda p: types.SimpleNamespace(version='unsupported')
try:
    history.assert_runtime_contract(args)
except RuntimeError as exc:
    assert 'diffusers==0.42.0' in str(exc)
else:
    raise AssertionError('unverified version accepted')
assert 'diffusers' not in sys.modules
with tempfile.TemporaryDirectory() as temp:
    changed = Path(temp) / 'changed.py'
    changed.write_text('changed hook')
    history.CONTRACT['runtimePackages'] = {'diffusers': '0.42.0'}
    history.CONTRACT['sourceSha256'] = {'changed.py': '0' * 64}
    history.importlib.metadata.distribution = lambda p: types.SimpleNamespace(version='0.42.0', locate_file=lambda f: Path(temp) / f)
    try:
        history.assert_runtime_contract(args)
    except RuntimeError as exc:
        assert 'hook changed' in str(exc)
    else:
        raise AssertionError('changed hook accepted')
assert 'diffusers' not in sys.modules
print('pins refused before pipeline import')`)).toBe('pins refused before pipeline import');
  });

  it('validates absolute source/audio intervals and keeps history separate from acceleration and output geometry', () => {
    expect(run(`${imports}
import argparse, tempfile
import generate_minimax_h3_cuda as cuda
from _minimax_h3_common import validate_h3_history_args
with tempfile.TemporaryDirectory() as temp:
    source = Path(temp) / 'source.mp4'
    source.write_bytes(b'source')
    args = argparse.Namespace(source_video=str(source), history_end_frame=18, history_frames=17,
        output=str(Path(temp) / 'new.mp4'), fps=24, width=1344, height=768, num_frames=124,
        steps=8, image=[], anchor=[], repo_file=['modular_model_index.json'], lora=[], speed_profile=None)
    assert validate_h3_history_args(args, supported=True) == dict(start_frame=1, end_frame=18, frames=17, start_sample=1333, end_sample=24000)
    args.history_end_frame = 19
    assert validate_h3_history_args(args, supported=True)['start_sample'] == 2667
    cuda.validate_args(args)
    for field, value in [('num_frames', 107), ('num_frames', 362), ('num_frames', 125), ('steps', 1),
                         ('speed_profile', 'lightx2v-v1.3-4step'), ('lora', ['adapter']),
                         ('image', ['keyframe']), ('history_frames', 22), ('history_end_frame', 16),
                         ('output', str(source))]:
        old = getattr(args, field)
        setattr(args, field, value)
        try:
            cuda.validate_args(args)
        except SystemExit:
            pass
        else:
            raise AssertionError(f'incompatible {field} accepted')
        setattr(args, field, old)
    try:
        validate_h3_history_args(args, supported=False)
    except SystemExit:
        pass
    else:
        raise AssertionError('unverified backend accepted shared history flags')
print('bounded CUDA history contract')`)).toBe('bounded CUDA history contract');
  });

  it('publishes only complete owned mux output and preserves sources, completed clips and unrelated scratch on failure/cancel/races', () => {
    expect(run(`${imports}
import tempfile
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    source, completed, unrelated = (root / name for name in ('source.mp4', 'completed.mp4', 'new.wav'))
    for p in (source, completed, unrelated):
        p.write_bytes(b'preserve')
    output = root / 'new.mp4'
    for error in (RuntimeError, KeyboardInterrupt, SystemExit):
        def encode(frames, **kw):
            Path(kw['output_path']).write_bytes(b'partial')
            raise error()
        try:
            history.mux_owned_output(output, encode, [], [], 32000)
        except error:
            pass
        else:
            raise AssertionError('failure hidden')
        assert not output.exists()
        assert not list(root.glob('.portos-h3-*'))
    def racing_encode(frames, **kw):
        Path(kw['output_path']).write_bytes(b'ours')
        output.write_bytes(b'completed elsewhere')
    try:
        history.mux_owned_output(output, racing_encode, [], [], 32000)
    except FileExistsError:
        pass
    else:
        raise AssertionError('completed output overwritten')
    assert output.read_bytes() == b'completed elsewhere'
    def forbidden(*a, **kw):
        raise AssertionError('existing clip reached encoder')
    try:
        history.mux_owned_output(completed, forbidden, [], [], 32000)
    except RuntimeError:
        pass
    def success(frames, **kw):
        Path(kw['output_path']).write_bytes(b'complete')
    history.mux_owned_output(root / 'success.mp4', success, [], [], 32000)
    assert (root / 'success.mp4').read_bytes() == b'complete'
    assert not list(root.glob('.portos-h3-*'))
    assert all(p.read_bytes() == b'preserve' for p in (source, completed, unrelated))
print('owned scratch and no-clobber publication')`)).toBe('owned scratch and no-clobber publication');
  });

  it.skipIf(!native)('uses native modular denoising and media fixtures to retain clean history and decode target output only', () => {
    expect(execFileSync(python, [join(dir, 'minimax_h3_cuda_history_fixture.py'), dir], {
      encoding: 'utf8', timeout: 60_000,
    }).trim()).toBe('native CUDA history fixtures passed');
  });
});
