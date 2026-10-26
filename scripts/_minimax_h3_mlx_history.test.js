import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const pyBin = resolveTestPython();
const scripts = fileURLToPath(new URL('.', import.meta.url));
const run = (source) => execFileSync(pyBin, ['-c', `import sys\nsys.path.insert(0, sys.argv[1])\n${source}`, scripts], {
  encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
}).trim();

describe.skipIf(!pyBin)('H3 history runner admission and preservation', () => {
  it('resolves a bounded exclusive prior interval and refuses unsupported or ambiguous requests', () => {
    expect(run(`
import tempfile
from pathlib import Path
from types import SimpleNamespace as NS
from _minimax_h3_common import validate_h3_history_args
import generate_minimax_h3 as mlx
import generate_minimax_h3_cuda as cuda
with tempfile.TemporaryDirectory() as tmp:
    source = Path(tmp) / 'source.mp4'
    source.write_bytes(b'original')
    args = NS(source_video=str(source), history_end_frame=41, history_frames=17, output=str(Path(tmp) / 'next.mp4'))
    assert validate_h3_history_args(args, supported=True) == dict(start_frame=24, end_frame=41, frames=17, start_sample=32000, end_sample=54667)
    for changes, supported in [({}, False), ({'history_end_frame': 16}, True), ({'history_end_frame': None}, True),
                               ({'history_frames': 22}, True), ({'output': str(source)}, True)]:
        changed = NS(**(vars(args) | changes))
        try:
            validate_h3_history_args(changed, supported=supported)
            raise AssertionError('invalid history accepted')
        except SystemExit:
            pass
    args.image, args.anchor, args.draft_decoder_file = ['still.png'], ['first'], []
    try:
        mlx.validate_args(args)
        raise AssertionError('keyframes accepted with history')
    except SystemExit as exc:
        assert 'cannot be combined' in str(exc)
    try:
        cuda.validate_args(args)
        raise AssertionError('CUDA claimed MLX support')
    except SystemExit as exc:
        assert 'unavailable on this backend' in str(exc)
print('OK')`)).toBe('OK');
  });

  it('refuses a moved pin or missing seam before importing the backend or resolving model weights', () => {
    expect(run(`
import tempfile
from pathlib import Path
from _minimax_h3_mlx_history import PIN, verify_history_backend
import generate_minimax_h3 as runner
for revision, message in [('new-pin', 'unsupported runtime revision'), (PIN, 'pinned adaln.py seam differs')]:
    with tempfile.TemporaryDirectory() as tmp:
        try:
            verify_history_backend(Path(tmp), revision)
            raise AssertionError('invalid backend accepted')
        except RuntimeError as exc:
            assert message in str(exc), str(exc)
assert 'mlx.core' not in sys.modules
assert 'minimax_h3_mlx.pipeline' not in sys.modules
with tempfile.TemporaryDirectory() as tmp:
    source = Path(tmp) / 'source.mp4'
    source.write_bytes(b'example')
    sys.argv = ['h3', '--model-repo', 'example/model', '--model-revision', 'model-pin',
                '--runtime-dir', tmp, '--runtime-revision', 'unsupported',
                '--checkpoint-repo', 'example/checkpoint', '--checkpoint-revision', 'checkpoint-pin',
                '--prompt', 'Example', '--width', '512', '--height', '320', '--num-frames', '107',
                '--output', str(Path(tmp) / 'next.mp4'), '--source-video', str(source), '--history-end-frame', '41']
    runner.establish_process_group = lambda: None
    runner.require_ffmpeg = lambda: 'ffmpeg'
    runner.verify_runtime_checkout = lambda *_: None
    def unexpected_load(*_): raise AssertionError('model load/cache resolution reached before pin validation')
    runner.enforce_system_memory = unexpected_load
    runner.resolve_cached_snapshot = unexpected_load
    try:
        runner.main()
        raise AssertionError('unsupported pin accepted')
    except RuntimeError as exc:
        assert 'unsupported runtime revision' in str(exc)
print('OK')`)).toBe('OK');
  });

  it.each(['failure', 'cancel'])('preserves source, completed outputs and sibling WAVs on mux %s', (mode) => {
    expect(run(`
import contextlib, io, os, signal, tempfile
from pathlib import Path
from types import SimpleNamespace as NS
import generate_minimax_h3 as runner
runner.install_cancellation_handler()
runner.heartbeat = lambda *_: contextlib.nullcontext()
runner._install_h3_stepwise_preview = lambda *_: None
encoder = NS(encode=lambda *_: ('embedding', 'tags'))
class Pipe:
    text_encoder = encoder
    def __call__(self, *_a, **_kw):
        return NS(video=NS(shape=[124]), fps=24, audio=None, sample_rate=32000)
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    source, output, wav = root / 'source.mp4', root / 'clip.mp4', root / 'clip.wav'
    for path in (source, output, wav): path.write_bytes(b'keep-' + path.name.encode())
    original = {p: p.read_bytes() for p in (source, output, wav)}
    args = NS(source_video=str(source), output=str(output), seed=0, prompt='Example', num_frames=124,
              steps=9, anchor=[], height=768, width=1344)
    scratch = []
    def cancel():
        # Windows os.kill(SIGTERM) uses TerminateProcess without dispatching
        # Python's handler. Exercise the handler there and a process signal on POSIX.
        if sys.platform == 'win32':
            signal.raise_signal(signal.SIGTERM)
        else:
            os.kill(os.getpid(), signal.SIGTERM)
    def save(path, *_):
        scratch.append(path.parent)
        path.write_bytes(b'partial')
        path.with_suffix('.wav').write_bytes(b'owned temporary audio')
        ${mode === 'cancel' ? 'cancel()' : "raise RuntimeError('example interruption')"}
    try:
        with contextlib.redirect_stdout(io.StringIO()): runner.render_outputs(Pipe(), args, [], save)
        raise AssertionError('interruption lost')
    except ${mode === 'cancel' ? 'SystemExit' : 'RuntimeError'}:
        pass
    assert all(p.read_bytes() == data for p, data in original.items())
    assert scratch and all(not p.exists() for p in scratch)
    assert sorted(p.name for p in root.iterdir()) == ['clip.mp4', 'clip.wav', 'source.mp4']
print('OK')`)).toBe('OK');
  });
});
