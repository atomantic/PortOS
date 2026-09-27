import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const python = resolveTestPython();
const script = fileURLToPath(new URL('./qwen3_tts_runner.py', import.meta.url));

// Exercise the production download/probe boundary with a tool-free fake Hub;
// no model, provider, hardware, credentials, or real user directories are used.
const fixture = String.raw`
import hashlib, importlib.util, json, os, sys, tempfile, types
from pathlib import Path
spec = importlib.util.spec_from_file_location("qwen_runner", sys.argv[1])
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
model_id = runner.SUPPORTED_MODELS[0]
revision = "a" * 40
payloads = {name: ("fixture:" + name).encode() for name in runner.REQUIRED_FILES}
entries = []
for name, data in payloads.items():
    is_weight = name.endswith(".safetensors")
    entries.append(types.SimpleNamespace(
        rfilename=name, size=len(data),
        lfs=types.SimpleNamespace(sha256=hashlib.sha256(data).hexdigest()) if is_weight else None,
        blob_id=hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest(),
    ))
info = types.SimpleNamespace(sha=revision, siblings=entries)
calls = []
corrupt = None
hub = types.ModuleType("huggingface_hub")
hub.HfApi = lambda **kwargs: types.SimpleNamespace(model_info=lambda *args, **kwargs: info)
def download(**kwargs):
    calls.append(kwargs)
    assert kwargs["revision"] == revision
    assert kwargs["endpoint"] == "https://huggingface.co"
    path = kwargs["local_dir"] / kwargs["filename"]
    path.parent.mkdir(parents=True, exist_ok=True)
    data = payloads[kwargs["filename"]]
    path.write_bytes(b"x" * len(data) if kwargs["filename"] == corrupt else data)
    return str(path)
hub.hf_hub_download = download
sys.modules["huggingface_hub"] = hub
`;
const run = (source) => JSON.parse(execFileSync(python, ['-c', fixture + source, script], { encoding: 'utf8' }));

// Test doubles exercise the verified snapshot -> official adapter -> PCM WAV
// boundary. These fixture samples are deliberately not claimed to be speech.
const inferenceFixture = String.raw`
import contextlib, io, wave
runner.platform.system = lambda: "Linux"
runner.platform.machine = lambda: "x86_64"
events = []
class Array:
    ndim, size = 1, 240
numpy = types.ModuleType("numpy")
numpy.asarray = lambda values: Array()
numpy.isfinite = lambda values: types.SimpleNamespace(all=lambda: True)
numpy.any = lambda values: True
sys.modules["numpy"] = numpy
torch = types.ModuleType("torch")
torch.cuda = types.SimpleNamespace(is_available=lambda: False, is_bf16_supported=lambda: False)
torch.float32, torch.float16, torch.bfloat16 = "float32", "float16", "bfloat16"
torch.manual_seed = lambda seed: events.append({"seed": seed})
torch.inference_mode = contextlib.nullcontext
sys.modules["torch"] = torch
def write_wav(path, audio, sample_rate, **kwargs):
    assert kwargs == {"format": "WAV", "subtype": "PCM_16"}
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(b"\x01\x00" * 240)
soundfile = types.ModuleType("soundfile")
soundfile.write = write_wav
sys.modules["soundfile"] = soundfile
class Model:
    @classmethod
    def from_pretrained(cls, path, **kwargs):
        assert os.environ["HF_HUB_OFFLINE"] == "1"
        assert os.environ["TRANSFORMERS_OFFLINE"] == "1"
        events.append({"path": path, **kwargs})
        return cls()
    def generate_voice_design(self, **kwargs):
        events.append({"design": kwargs})
        return [[1]], 24000
    def generate_voice_clone(self, **kwargs):
        events.append({"clone": kwargs})
        return [[1]], 24000
qwen = types.ModuleType("qwen_tts")
qwen.Qwen3TTSModel = Model
sys.modules["qwen_tts"] = qwen
def args_for(root, **kwargs):
    return types.SimpleNamespace(checkpoint_path=None, model_path=None, rate=1.0,
        models_dir=str(root), model_id=model_id, text="An invented sentence.",
        reference_audio=kwargs.get("reference"), reference_transcript=kwargs.get("transcript"),
        mode=kwargs.get("mode", "design"), instructions=kwargs.get("instructions"),
        seed=42, output_wav=str(root / "output.wav"))
`;

describe.skipIf(!python)('Qwen3 explicit model acquisition', () => {
  it('publishes only complete immutable snapshots and detects missing/truncated required weights', () => {
    const result = run(String.raw`
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    model_dir = root / model_id.replace("/", "--")
    model_dir.mkdir()
    (model_dir / "metadata.json").write_text("{}")
    assert runner.installed_snapshot(model_dir, model_id) is None
    result = runner.download_model(model_id, root)
    snapshot = runner.installed_snapshot(model_dir, model_id)
    assert snapshot == Path(result["path"])
    # Repeated status checks do not rehash unchanged multi-GB weights.
    verifier = runner.verify_file
    if sys.platform != "win32":
        runner.verify_file = lambda *args: (_ for _ in ()).throw(AssertionError("rehashed unchanged file"))
        assert runner.installed_snapshot(model_dir, model_id) == snapshot
        runner.verify_file = verifier
    assert len(calls) == len(runner.REQUIRED_FILES)
    # A harmless touch refreshes the cache after one verification.
    codec = snapshot / "speech_tokenizer/model.safetensors"
    stat = codec.stat()
    os.utime(codec, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1000000))
    assert runner.installed_snapshot(model_dir, model_id) == snapshot
    if sys.platform != "win32":
        runner.verify_file = lambda *args: (_ for _ in ()).throw(AssertionError("rehashed refreshed file"))
        assert runner.installed_snapshot(model_dir, model_id) == snapshot
        runner.verify_file = verifier
    # A metadata-only directory or incomplete codec must never report installed.
    original = codec.stat()
    codec.write_bytes(b"x" * original.st_size)
    os.utime(codec, ns=(original.st_atime_ns, original.st_mtime_ns))
    assert runner.installed_snapshot(model_dir, model_id) is None
    codec.write_bytes(b"truncated")
    assert runner.installed_snapshot(model_dir, model_id) is None
    codec.unlink()
    assert runner.installed_snapshot(model_dir, model_id) is None
    print(json.dumps({"ok": result["ok"], "revision": result["revision"]}))
`);
    expect(result).toEqual({ ok: true, revision: 'a'.repeat(40) });
  });

  it('rejects corrupt content and incomplete upstream repositories without publishing readiness', () => {
    const result = run(String.raw`
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    model_dir = root / model_id.replace("/", "--")
    failures = []
    for name in ("config.json", "model.safetensors"):
        corrupt = name
        try:
            runner.download_model(model_id, root)
            raise AssertionError("accepted corrupt file")
        except ValueError as error:
            failures.append(str(error))
        assert not (model_dir / "verified.json").exists()
    corrupt = None
    info.siblings = entries[:-1]
    try:
        runner.download_model(model_id, root)
        raise AssertionError("accepted missing codec configuration")
    except ValueError as error:
        failures.append(str(error))
    assert runner.installed_snapshot(model_dir, model_id) is None
    print(json.dumps(failures))
`);
    expect(result).toEqual([
      'Model file checksum mismatch: config.json',
      'Model file checksum mismatch: model.safetensors',
      'Model repository is missing required Qwen3-TTS files',
    ]);
  });
});

describe.skipIf(!python)('Qwen3 verified local inference', () => {
  it('loads the immutable local snapshot and invokes design/clone with accurate revision evidence', () => {
    const result = run(inferenceFixture + String.raw`
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    runner.download_model(model_id, root)
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        assert runner.run_synthesis(args_for(root, instructions="Warm natural alto")) == 0
    design_result = json.loads(output.getvalue())
    assert events[1]["local_files_only"] is True
    assert events[1]["device_map"] == "cpu"
    assert events[1]["dtype"] == "float32"
    assert Path(events[1]["path"]).name == revision
    assert events[2]["design"]["instruct"] == "Warm natural alto"
    with wave.open(str(root / "output.wav")) as audio:
        assert audio.getnframes() == 240 and audio.getframerate() == 24000
    reference = root / "reference.wav"
    reference.write_bytes(b"explicit test fixture")
    model_id = runner.SUPPORTED_MODELS[1]
    runner.download_model(model_id, root)
    events.clear()
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        assert runner.run_synthesis(args_for(root, mode="clone", reference=str(reference), transcript="Reference words.")) == 0
    clone_result = json.loads(output.getvalue())
    assert events[2]["clone"]["ref_audio"] == str(reference.resolve())
    assert events[2]["clone"]["ref_text"] == "Reference words."
    assert events[2]["clone"]["x_vector_only_mode"] is False
    print(json.dumps({"design": design_result, "clone": clone_result}))
`);
    expect(result.design).toMatchObject({ ok: true, modelRevision: `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign@${'a'.repeat(40)}`, effectiveControls: { mode: 'design', rate: 1 } });
    expect(result.clone).toMatchObject({ ok: true, modelRevision: `Qwen/Qwen3-TTS-12Hz-1.7B-Base@${'a'.repeat(40)}`, effectiveControls: { mode: 'clone' } });
  });

  it('refuses missing weights, unsupported controls/variants and Apple Silicon without calling the model', () => {
    const result = run(inferenceFixture + String.raw`
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    args = args_for(root)
    with contextlib.redirect_stderr(io.StringIO()):
        assert runner.run_synthesis(args) == 1
        runner.download_model(model_id, root)
        args.rate = 1.2
        assert runner.run_synthesis(args) == 1
        args.rate = 1.0
        args.mode = "clone"
        assert runner.run_synthesis(args) == 1
        args.mode = "design"
        args.checkpoint_path = str(root / "bogus.safetensors")
        assert runner.run_synthesis(args) == 1
        args.checkpoint_path = None
        runner.platform.system = lambda: "Darwin"
        runner.platform.machine = lambda: "arm64"
        assert runner.run_synthesis(args) == 1
        assert runner.run_fine_tuning(args) == 1
    assert events == []
    assert not (root / "output.wav").exists()
    print(json.dumps({"noModelCalls": True}))
`);
    expect(result).toEqual({ noModelCalls: true });
  });

  it('fails instead of publishing invalid model audio or exposing a private inference error', () => {
    const result = run(inferenceFixture + String.raw`
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    runner.download_model(model_id, root)
    args = args_for(root)
    failures = []
    numpy.any = lambda values: False
    error = io.StringIO()
    with contextlib.redirect_stderr(error):
        assert runner.run_synthesis(args) == 1
    failures.append(json.loads(error.getvalue()))
    numpy.any = lambda values: True
    def private_failure(*args, **kwargs):
        raise RuntimeError("private reference transcript")
    Model.generate_voice_design = private_failure
    error = io.StringIO()
    with contextlib.redirect_stderr(error):
        assert runner.run_synthesis(args) == 1
    assert "private reference transcript" not in error.getvalue()
    failures.append(json.loads(error.getvalue()))
    assert not (root / "output.wav").exists()
    print(json.dumps(failures))
`);
    expect(result.every((failure) => failure.code === 'QWEN3_SYNTHESIS_FAILED')).toBe(true);
  });
});
