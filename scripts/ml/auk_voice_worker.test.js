import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../../server/lib/testHelper.js';

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

  it('registers an audio-only qwen_omni_utils.process_mm_info shim over soundfile and soxr', () => {
    const shimHarness = String.raw`
import importlib.util, json, sys, types

spec = importlib.util.spec_from_file_location("auk_worker", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class FakeArray(list):
    def __init__(self, data, ndim=1):
        super().__init__(data)
        self.ndim = ndim
        self.size = len(data)
    def mean(self, axis=None):
        assert axis == 1
        return FakeArray([(a + b) / 2.0 for a, b in self], ndim=1)

numpy = types.ModuleType("numpy")
numpy.ndarray = FakeArray
numpy.float32 = float
numpy.ascontiguousarray = lambda data, dtype=None: FakeArray([float(x) for x in data], ndim=1)
sys.modules["numpy"] = numpy

seeks = []
reads = []
class FakeSoundFile:
    def __init__(self, path):
        self.path = path
        self.samplerate = 24000
    def __len__(self):
        return 48000
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False
    def seek(self, frame):
        seeks.append(frame)
    def read(self, frames=-1, dtype="float32", always_2d=True):
        reads.append((self.path, frames, dtype, always_2d))
        return FakeArray([[0.25, 0.75], [0.5, 0.5]], ndim=2)

soundfile = types.ModuleType("soundfile")
soundfile.SoundFile = FakeSoundFile
sys.modules["soundfile"] = soundfile

resampled = []
soxr = types.ModuleType("soxr")
def fake_resample(wav, src_sr, dst_sr, quality="VHQ"):
    resampled.append((list(wav), src_sr, dst_sr, quality))
    return FakeArray([round(x * 2, 3) for x in wav], ndim=1)
soxr.resample = fake_resample
sys.modules["soxr"] = soxr

sys.modules.pop("qwen_omni_utils", None)
mod = worker.install_audio_only_qwen_omni_utils()
from qwen_omni_utils import process_mm_info
assert mod.process_mm_info is process_mm_info

audios, images, videos = process_mm_info(
    [[{"role": "user", "content": [
        {"type": "text", "text": "hello"},
        {"type": "audio", "audio": "file:///example/my%20ref.wav", "audio_start": 0.5, "audio_end": 1.5},
        {"type": "audio", "audio": None, "audio_url": "/example/eof.wav", "audio_start": 10.0},
    ]}]],
    use_audio_in_video=True,
)
assert images is None and videos is None
assert seeks == [12000, 48000]
assert reads == [("/example/my ref.wav", 24000, "float32", True), ("/example/eof.wav", -1, "float32", True)]
assert resampled[0] == ([0.5, 0.5], 24000, 16000, "VHQ")
assert list(audios[0]) == [1.0, 1.0]

# 1-D ndarray slicing & empty conversation handling
arr = FakeArray([float(i) for i in range(32000)], ndim=1)
arr_audios, arr_images, arr_videos = process_mm_info(
    [{"role": "user", "content": [{"type": "audio", "audio": arr, "audio_start": 0.5, "audio_end": 1.0}]}],
    use_audio_in_video=False,
)
assert arr_images is None and arr_videos is None
assert len(arr_audios[0]) == 8000 and arr_audios[0][0] == 8000.0
assert process_mm_info([[{"role": "user", "content": [{"type": "text", "text": "only text"}]}]], True) == (None, None, None)

# Refuses remote URLs (including non-local file://) and unsupported video/image modalities
rejected = []
for payload in [
    [{"role": "user", "content": [{"type": "audio", "audio": "HTTPS://example.com/a.wav"}]}],
    [{"role": "user", "content": [{"type": "audio", "audio": "file://remote-host/a.wav"}]}],
    [{"role": "user", "content": [{"type": "video", "video": "/example/clip.mp4"}]}],
    [{"role": "user", "content": [{"type": "image", "image": "/example/pic.png"}]}],
]:
    try:
        process_mm_info([payload], True)
    except ValueError as exc:
        rejected.append(str(exc))
print(json.dumps({"rejected": rejected}))
`;
    const result = spawnSync(python, ['-c', shimHarness, script], { encoding: 'utf8' });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout.trim()).rejected).toHaveLength(4);
  });
});
