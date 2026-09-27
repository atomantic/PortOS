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
    runner.verify_file = lambda *args: (_ for _ in ()).throw(AssertionError("rehashed unchanged file"))
    assert runner.installed_snapshot(model_dir, model_id) == snapshot
    runner.verify_file = verifier
    assert len(calls) == len(runner.REQUIRED_FILES)
    # A metadata-only directory or incomplete codec must never report installed.
    codec = snapshot / "speech_tokenizer/model.safetensors"
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
