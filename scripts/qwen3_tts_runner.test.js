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

// MLX uses a generator and a separate codec encoder; exercise its actual
// adapter shape without importing Metal or synthesizing real model audio.
const mlxFixture = String.raw`
runner.platform.system = lambda: "Darwin"
runner.platform.machine = lambda: "arm64"
mlx = types.ModuleType("mlx")
core = types.ModuleType("mlx.core")
core.random = types.SimpleNamespace(seed=lambda seed: events.append({"mlxSeed": seed}))
core.eval = lambda audio: events.append({"evaluated": True})
core.metal = types.SimpleNamespace(is_available=lambda: True)
mlx.core = core
sys.modules["mlx"] = mlx
sys.modules["mlx.core"] = core
class MlxModel:
    tokenizer = object()
    speech_tokenizer = types.SimpleNamespace(has_encoder=True)
    def generate_voice_design(self, **kwargs):
        events.append({"mlxDesign": kwargs})
        yield types.SimpleNamespace(audio=[1], sample_rate=24000)
    def generate(self, **kwargs):
        events.append({"mlxClone": kwargs})
        yield types.SimpleNamespace(audio=[1], sample_rate=24000)
def load_mlx(path, **kwargs):
    assert isinstance(path, Path) and path.name == revision
    assert os.environ["HF_HUB_OFFLINE"] == "1"
    assert os.environ["TRANSFORMERS_OFFLINE"] == "1"
    assert kwargs == {"strict": True}
    events.append({"mlxLoad": True})
    return MlxModel()
utils = types.ModuleType("mlx_audio.tts.utils")
utils.load_model = load_mlx
sys.modules["mlx_audio.tts.utils"] = utils
qwen_mlx = types.ModuleType("mlx_audio.tts.models.qwen3_tts")
qwen_mlx.Model = MlxModel
sys.modules["mlx_audio.tts.models.qwen3_tts"] = qwen_mlx
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

  it('refuses missing weights, unsupported controls/variants and missing MLX dependencies without calling the model', () => {
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
        sys.modules["mlx"] = None
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


describe.skipIf(!python)('Qwen3 Apple Silicon inference', () => {
  it('runs design and transcript-conditioned cloning through the verified MLX snapshot', () => {
    const result = run(inferenceFixture + mlxFixture + String.raw`
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    runner.download_model(model_id, root)
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        assert runner.run_synthesis(args_for(root, instructions="Warm natural alto")) == 0
    design = json.loads(output.getvalue())
    assert events == [{"mlxSeed": 42}, {"mlxLoad": True}, {"mlxDesign": {
        "text": "An invented sentence.", "language": "auto", "instruct": "Warm natural alto",
        "stream": False, "verbose": False}}, {"evaluated": True}]
    model_id = runner.SUPPORTED_MODELS[1]
    runner.download_model(model_id, root)
    reference = root / "reference.wav"
    reference.write_bytes(b"explicit test fixture")
    events.clear()
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        assert runner.run_synthesis(args_for(root, mode="clone", reference=str(reference), transcript="Reference words.")) == 0
    clone = json.loads(output.getvalue())
    assert events[2]["mlxClone"] == {
        "text": "An invented sentence.", "lang_code": "auto", "ref_audio": str(reference.resolve()),
        "ref_text": "Reference words.", "split_pattern": None, "stream": False, "verbose": False}
    with wave.open(str(root / "output.wav")) as audio:
        assert audio.getnframes() == 240 and audio.getframerate() == 24000
    print(json.dumps({"design": design, "clone": clone}))
`);
    expect(result.design).toMatchObject({ ok: true, effectiveControls: { mode: 'design', seed: 42 } });
    expect(result.clone).toMatchObject({ ok: true, modelRevision: `Qwen/Qwen3-TTS-12Hz-1.7B-Base@${'a'.repeat(40)}`, effectiveControls: { mode: 'clone' } });
  });

  it('refuses cloning without transcript or encoder instead of publishing unconditioned speech', () => {
    const result = run(inferenceFixture + mlxFixture + String.raw`
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    model_id = runner.SUPPORTED_MODELS[1]
    runner.download_model(model_id, root)
    reference = root / "reference.wav"
    reference.write_bytes(b"explicit test fixture")
    args = args_for(root, mode="clone", reference=str(reference))
    with contextlib.redirect_stderr(io.StringIO()):
        assert runner.run_synthesis(args) == 1
        assert events == []
        args.reference_transcript = "Reference words."
        MlxModel.speech_tokenizer.has_encoder = False
        assert runner.run_synthesis(args) == 1
        assert not any("mlxClone" in event for event in events)
        assert not (root / "output.wav").exists()
    print(json.dumps({"noUnconditionedAudio": True}))
`);
    expect(result).toEqual({ noUnconditionedAudio: true });
  });

  it('probes MLX readiness without Torch or loading weights and refuses missing Metal', () => {
    const result = run(inferenceFixture + mlxFixture + String.raw`
sys.modules["torch"] = None
sys.modules["transformers"] = None
status = runner.probe_runtime()
assert events == []
core.metal.is_available = lambda: False
unavailable = runner.probe_runtime()
print(json.dumps({"status": status, "unavailable": unavailable}))
`);
    expect(result.status).toMatchObject({ ok: true, device: 'mlx', error: null, torch_installed: false, training_adapter: null });
    expect(result.unavailable).toMatchObject({ ok: false });
  });
});

// The official training recipe needs bf16 CUDA and its Torch/qwen-tts/librosa
// stack. These doubles stand in for that stack so the adapter's publication
// contract runs anywhere; the recipe's tensor math is not exercised here.
const trainingFixture = String.raw`
torch.cuda = types.SimpleNamespace(is_available=lambda: True, is_bf16_supported=lambda: True,
                                   empty_cache=lambda: None)
torch.__version__ = "fixture"
# Checkpoints rewrite the base config, so the fake Hub serves a JSON one.
payloads["config.json"] = json.dumps({"tts_model_type": "base", "talker_config": {"hidden_size": 8}}).encode()
for entry in entries:
    if entry.rfilename == "config.json":
        entry.size = len(payloads["config.json"])
        entry.blob_id = hashlib.sha1(f"blob {entry.size}\0".encode() + payloads["config.json"]).hexdigest()
for name in ("librosa", "safetensors", "safetensors.torch", "transformers", "qwen_tts.core",
             "qwen_tts.core.models", "qwen_tts.core.models.modeling_qwen3_tts"):
    sys.modules[name] = types.ModuleType(name)
sys.modules["transformers"].__version__ = "fixture"
sys.modules["safetensors.torch"].save_file = lambda *args: None
sys.modules["qwen_tts.core.models.modeling_qwen3_tts"].mel_spectrogram = lambda *args, **kwargs: None
def custom_voice(self, **kwargs):
    events.append({"custom": kwargs})
    if "step-1" in events[-2]["path"]:
        raise RuntimeError("private checkpoint failure")
    return [[1]], 24000
Model.generate_custom_voice = custom_voice
base_model = runner.SUPPORTED_MODELS[1]
def training_args(root, dataset, **kwargs):
    return types.SimpleNamespace(model_id=kwargs.get("model_id", base_model), models_dir=str(root),
        dataset_manifest=str(dataset), output_dir=str(root / "job"), epochs=1, checkpoint_interval=1, seed=7)
def write_dataset(root):
    clip = root / "clip.wav"
    clip.write_bytes(b"explicit test fixture")
    dataset = root / "dataset.json"
    dataset.write_text(json.dumps({"speaker": "portos_voice", "reference_audio": str(clip),
                                   "samples": [{"audio": str(clip), "text": "Invented training words."}]}))
    return dataset
trained = []
def fake_train(snapshot, dataset, args, staging, emit):
    trained.append(dataset)
    staged = []
    for step in (1, 2):
        emit({"stage": "training", "step": step, "total_steps": 2, "loss": 0.5, "progress": step * 50})
        target = staging / f"step-{step}"
        runner.write_checkpoint_files(snapshot, target, dataset["speaker"])
        (target / runner.CHECKPOINT_WEIGHTS).write_bytes(f"fixture weights {step}".encode())
        staged.append({"path": target, "step": step, "loss": 0.5})
    return staged
runner.train_checkpoints = fake_train
`;

describe.skipIf(!python)('Qwen3 fine-tuning adapter', () => {
  it('names the adapter only where the official recipe can run', () => {
    const result = run(inferenceFixture + trainingFixture + String.raw`
cuda = runner.probe_runtime()["training_adapter"]
torch.cuda.is_bf16_supported = lambda: False
no_bf16 = runner.probe_runtime()["training_adapter"]
torch.cuda.is_bf16_supported = lambda: True
sys.modules["librosa"] = None
missing = runner.probe_runtime()["training_adapter"]
print(json.dumps([cuda, no_bf16, missing]))
`);
    expect(result).toEqual(['qwen-tts-sft-12hz', null, null]);
  });

  it('publishes only sealed checkpoints that reload and speak, then synthesizes from exactly those bytes', () => {
    const result = run(inferenceFixture + trainingFixture + String.raw`
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    runner.download_model(base_model, root)
    output, error = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
        status = runner.run_fine_tuning(training_args(root, write_dataset(root)))
    assert status == 0, error.getvalue()
    assert "private checkpoint failure" not in error.getvalue()
    frames = [json.loads(line) for line in output.getvalue().splitlines()]
    checkpoints = [frame for frame in frames if frame["stage"] == "checkpoint"]
    job = root / "job"
    # The checkpoint whose reload audition failed is discarded, not published.
    assert [frame["step"] for frame in checkpoints] == [2]
    assert not (job / "checkpoint-step-1").exists() and not (job / ".staging").exists()
    checkpoint = Path(checkpoints[0]["checkpoint_path"])
    assert checkpoint == job / "checkpoint-step-2" and Path(checkpoints[0]["sample_wav"]).is_file()
    config = json.loads((checkpoint / "config.json").read_text())
    assert config["tts_model_type"] == "custom_voice"
    assert config["talker_config"]["spk_id"] == {"portos_voice": 3000}
    # Auditions load the checkpoint offline through the synthesis loader.
    loads = [event for event in events if "path" in event]
    assert all(event["local_files_only"] is True for event in loads)
    assert events[-1] == {"custom": {"text": runner.AUDITION_TEXT, "speaker": "portos_voice", "language": "Auto"}}

    events.clear()
    args = args_for(root, mode="fine-tuned")
    args.checkpoint_path = str(checkpoint)
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        assert runner.run_synthesis(args) == 0
    synthesis = json.loads(output.getvalue())
    assert events[1]["path"] == str(checkpoint)
    assert events[2] == {"custom": {"text": "An invented sentence.", "speaker": "portos_voice", "language": "Auto"}}

    # Modified weights, even at the same size and mtime, and unsealed foreign
    # directories never load.
    weights = checkpoint / runner.CHECKPOINT_WEIGHTS
    stat = weights.stat()
    weights.write_bytes(b"x" * stat.st_size)
    os.utime(weights, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    events.clear()
    with contextlib.redirect_stderr(io.StringIO()):
        assert runner.run_synthesis(args) == 1
        args.checkpoint_path = str(root)
        assert runner.run_synthesis(args) == 1
    assert events == []
    print(json.dumps({"checkpoint": checkpoints[0], "synthesis": synthesis}))
`);
    const digest = /^Qwen\/Qwen3-TTS-12Hz-1\.7B-Base@a{40}\+sha256\.[0-9a-f]{64}$/;
    expect(result.checkpoint).toMatchObject({ checkpoint: 'checkpoint-step-2', model_revision: expect.stringMatching(digest) });
    expect(result.synthesis).toMatchObject({ ok: true, modelRevision: result.checkpoint.model_revision, effectiveControls: { mode: 'fine-tuned', seed: 42 } });
  });

  it('refuses unsupported hardware, models and datasets before training starts', () => {
    const result = run(inferenceFixture + trainingFixture + String.raw`
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    dataset = write_dataset(root)
    failures = []
    def attempt(args):
        error = io.StringIO()
        with contextlib.redirect_stderr(error), contextlib.redirect_stdout(io.StringIO()):
            assert runner.run_fine_tuning(args) == 1
        failures.append(json.loads(error.getvalue().splitlines()[-1])["code"])
    attempt(training_args(root, dataset))  # base weights not downloaded
    runner.download_model(base_model, root)
    attempt(training_args(root, dataset, model_id=runner.SUPPORTED_MODELS[0]))
    (root / "clip.wav").unlink()
    attempt(training_args(root, dataset))
    torch.cuda.is_available = lambda: False
    attempt(training_args(root, write_dataset(root)))
    runner.platform.system = lambda: "Darwin"
    runner.platform.machine = lambda: "arm64"
    torch.cuda.is_available = lambda: True
    attempt(training_args(root, dataset))
    assert trained == [] and not (root / "job").exists()
    # A run that fails mid-training leaves no staged full-model copies behind.
    runner.platform.system = lambda: "Linux"
    runner.platform.machine = lambda: "x86_64"
    def failing_train(snapshot, dataset, args, staging, emit):
        fake_train(snapshot, dataset, args, staging, emit)
        raise RuntimeError("private training failure")
    runner.train_checkpoints = failing_train
    attempt(training_args(root, write_dataset(root)))
    assert not (root / "job" / ".staging").exists()
    print(json.dumps(failures))
`);
    expect(result).toEqual([
      'QWEN3_RUNTIME_UNAVAILABLE',
      'QWEN3_RUNTIME_UNAVAILABLE',
      'QWEN3_TRAINING_INVALID_DATASET',
      'QWEN3_RUNTIME_UNAVAILABLE',
      'QWEN3_RUNTIME_UNAVAILABLE',
      'QWEN3_TRAINING_FAILED',
    ]);
  });
});
