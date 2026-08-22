import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const script = join(dirname(fileURLToPath(import.meta.url)), 'generate_minimax_h3.py');

// Probe for an interpreter that actually RUNS rather than assuming a name.
// On Windows a machine with no Store-installed Python still has `python` on
// PATH as an alias STUB: it exists, exits non-zero, and prints "Python was
// not found". A name-only choice passes there and then every case dies with
// an opaque "Command failed" — and PortOS provisions its own interpreters
// (~/.portos venvs), so a box can be set up for image/video gen while the
// bare name is still a stub. Null when there is genuinely none, so the suite
// skips instead of failing.
const pyBin = resolveTestPython();
const runPython = (source) => execFileSync(pyBin, ['-c', source, script], {
  encoding: 'utf8',
});

// The final-norm synthesis is the one helper here that actually needs mlx (it
// writes a real safetensors). CI's bare python3 is Linux and has no mlx wheel,
// so probe once and skip just that case rather than making the whole file
// macOS-only — every other helper is import-free by design.
const hasMlx = (() => {
  try {
    execFileSync(pyBin, ['-c', 'import mlx.core'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// The pin facts these corrections guard against moved to `_minimax_h3_mlx_pins.py`
// so the install-time probe and these render-time guards read one copy. Reach the
// module the RUNNER imported rather than loading a second one by spec: a private
// copy would let a rebinding here pass while the code under test still read the
// shipped digest.
const importPins = 'pins = sys.modules["_minimax_h3_mlx_pins"]';

const importRunner = [
  'import importlib.util, sys',
  'from pathlib import Path',
  'script = Path(sys.argv[1])',
  'spec = importlib.util.spec_from_file_location("generate_minimax_h3", script)',
  'runner = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(runner)',
].join('\n');

// validate_args reads the namespace argparse produces, so every field it touches
// has to be present here — a hand-built literal per test drifts the moment a flag
// is added (and fails as an AttributeError rather than an assertion). One builder
// carries the parser's own defaults; each test overrides only what it exercises.
const VALIDATE_ARGS_DEFAULTS = {
  fps: 24,
  width: 512,
  height: 320,
  num_frames: 124,
  steps: 9,
  image: [],
  anchor: [],
  lora: [],
  lora_scale: [],
  text_encoder_id: null,
  text_encoder_file: [],
  text_encoder_shim_root: null,
  text_encoder_key_prefix: [],
  text_encoder_final_norm_key: null,
};
const argsExpr = (overrides = {}) => {
  const fields = Object.entries({ ...VALIDATE_ARGS_DEFAULTS, ...overrides })
    .map(([key, value]) => `${key}=${value === null ? 'None' : JSON.stringify(value)}`);
  return `args = SimpleNamespace(${fields.join(', ')})`;
};

// Stand-in for the pinned runtime: the installers below reach for
// `minimax_h3_mlx.text_encoder.MiniMaxH3TextEncoder`, so every case that
// exercises one has to put a class there first. `preamble` runs before the
// class body, for recorders the stub's methods close over.
const stubPin = (classBody, preamble = []) => [
  'import sys, types',
  ...preamble,
  'class MiniMaxH3TextEncoder:',
  ...classBody,
  'module = types.ModuleType("minimax_h3_mlx.text_encoder")',
  'module.MiniMaxH3TextEncoder = MiniMaxH3TextEncoder',
  'sys.modules["minimax_h3_mlx"] = types.ModuleType("minimax_h3_mlx")',
  'sys.modules["minimax_h3_mlx.text_encoder"] = module',
].join('\n');

// The merge correction guards itself with `inspect.getsource`, which needs a
// real file — so that stand-in is written out and imported rather than declared
// inline. Each `encodeBody` entry is a PYTHON expression evaluated against the
// already-imported runner, so the line under test comes from the runner's own
// constant instead of a copy that could drift from it. The result is carried as
// a COMMENT: the stub only has to look like the pin to `getsource`, not run.
const filePin = (encodeBody) => [
  'import atexit, importlib.util, shutil, sys, tempfile, types',
  'temp = tempfile.mkdtemp()',
  'atexit.register(shutil.rmtree, temp, True)',
  'pin = Path(temp) / "pinned_text_encoder.py"',
  'pin.write_text("\\n".join([',
  '    "class MiniMaxH3TextEncoder:",',
  '    "    def encode(self, prompt, images=None):",',
  ...encodeBody.map((expr) => `    "        # " + ${expr},`),
  '    "        return (\'pinned\', prompt, images)",',
  ']))',
  'spec = importlib.util.spec_from_file_location("minimax_h3_mlx.text_encoder", pin)',
  'module = importlib.util.module_from_spec(spec)',
  'sys.modules["minimax_h3_mlx"] = types.ModuleType("minimax_h3_mlx")',
  'sys.modules["minimax_h3_mlx.text_encoder"] = module',
  'spec.loader.exec_module(module)',
  'MiniMaxH3TextEncoder = module.MiniMaxH3TextEncoder',
].join('\n');

describe.skipIf(!pyBin)('generate_minimax_h3.py', () => {
  it('defaults the MLX runner to nine sigma points for eight forwards', () => {
    const output = runPython(`${importRunner}\n${[
      'import sys',
      'sys.argv = ["generate_minimax_h3.py", "--model-repo", "example/model", "--model-revision", "revision",',
      '    "--runtime-dir", "/tmp/runtime", "--runtime-revision", "revision",',
      '    "--checkpoint-repo", "example/checkpoint", "--checkpoint-revision", "revision",',
      '    "--prompt", "a test prompt", "--width", "1344", "--height", "768",',
      '    "--num-frames", "124", "--output", "test.mp4"]',
      'print(runner.parse_args().steps)',
    ].join('\n')}`);
    expect(output.trim()).toBe('9');
  });

  it('parses the optional bounded preview directory', () => {
    const output = runPython(`${importRunner}\n${[
      'import sys',
      'sys.argv = ["generate_minimax_h3.py", "--model-repo", "example/model", "--model-revision", "revision",',
      '    "--runtime-dir", "/tmp/runtime", "--runtime-revision", "revision",',
      '    "--checkpoint-repo", "example/checkpoint", "--checkpoint-revision", "revision",',
      '    "--prompt", "a test prompt", "--width", "1344", "--height", "768", "--num-frames", "124",',
      '    "--output", "test.mp4", "--preview-dir", "/tmp/previews"]',
      'print(runner.parse_args().preview_dir)',
    ].join('\n')}`);
    expect(output.trim()).toBe('/tmp/previews');
  });

  it('projects the DiT batch rows to the generated video rows before decoding', () => {
    const output = runPython(`${importRunner}\n${[
      'import json, sys, types',
      'packing = types.ModuleType("minimax_h3_mlx.packing")',
      'packing.align_num_frames = lambda value: value',
      'packing.video_latent_num_frames = lambda value: 2',
      'sys.modules["minimax_h3_mlx"] = types.ModuleType("minimax_h3_mlx")',
      'sys.modules["minimax_h3_mlx.packing"] = packing',
      'class Config:',
      '    spatial_compression_ratio = 2',
      'class DitConfig:',
      '    patch_size = (1, 2, 2)',
      'class VideoVae:',
      '    config = Config()',
      'class Dit:',
      '    config = DitConfig()',
      'class Rows:',
      '    def __init__(self, shape): self.shape = shape',
      '    def __getitem__(self, key):',
      '        if key == 0: return Rows((10, 4))',
      '        if isinstance(key, slice): return Rows((8, 4))',
      '        raise AssertionError(f"unexpected row key: {key!r}")',
      'class Frame:',
      '    shape = (4, 4, 3)',
      'class Frames:',
      '    def __len__(self): return 2',
      '    def __getitem__(self, key): return Frame()',
      'class Pipe:',
      '    video_vae = VideoVae()',
      '    dit = Dit()',
      '    def _decode_video(self, rows, *shape):',
      '        print(json.dumps({"rows": list(rows.shape), "shape": list(shape)}))',
      '        return Frames()',
      'seen = []',
      'runner.write_stepwise_preview = lambda directory, frame: seen.append((directory, list(frame.shape))) or True',
      'preview = runner._H3StepwisePreview(Pipe(), "/tmp/previews", 17, 8, 8)',
      'rows = Rows((1, 10, 4))',
      'proxy = runner._PreviewingDiT(lambda *args: "ok", preview)',
      'proxy(rows)',
      'preview.publish(1, 2)',
      'print(json.dumps({"seen": seen, "saved": preview.saved}))',
    ].join('\n')}`);
    const lines = output.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ rows: [8, 4], shape: [2, 4, 4] });
    expect(lines[1]).toEqual({ seen: [['/tmp/previews', [4, 4, 3]]], saved: 1 });
  });

  // Only this runner shells out to ffmpeg (the CUDA sibling muxes in-process
  // via PyAV), so the preflight lives here rather than in the shared module.
  // Tens of GB of weights load before the mux; discovering a missing ffmpeg
  // after that wastes the whole render.
  it('fails the ffmpeg preflight before any model load can begin', () => {
    const output = runPython(`${importRunner}\n${[
      'runner.shutil.which = lambda name: None',
      'try:',
      '    runner.require_ffmpeg()',
      'except RuntimeError as exc:',
      '    print(exc)',
    ].join('\n')}`);
    expect(output).toContain('ffmpeg is required');
  });

  it('preflights transformer config, quant config, index, and every indexed shard', () => {
    const output = runPython(`${importRunner}\n${[
      'import json, tempfile',
      'with tempfile.TemporaryDirectory() as temp:',
      '    root = Path(temp)',
      '    (root / "model.safetensors.index.json").write_text(json.dumps({"weight_map": {"a": "model-1.safetensors", "b": "model-2.safetensors"}}))',
      '    calls = []',
      '    def fake_resolve(repo, revision, files):',
      '        calls.append(files)',
      '        return root',
      '    runner.resolve_cached_snapshot = fake_resolve',
      '    resolved = runner.resolve_transformer_snapshot("example/model", "revision")',
      '    print(json.dumps({"calls": calls, "resolved": str(resolved)}))',
    ].join('\n')}`);
    const result = JSON.parse(output);
    expect(result.calls).toEqual([
      ['config.json', 'quant_config.json', 'model.safetensors.index.json'],
      ['model-1.safetensors', 'model-2.safetensors'],
    ]);
    expect(result.resolved).toBeTruthy();
  });

  // The duration window is the one output fact that is per-runner: the MLX port
  // takes H3's full documented 4-15s range, where the diffusers CUDA runner is
  // narrower. Everything else on the grid (fps, the 32px canvas, the 17n+5 step,
  // anchoring) is shared, and asserted once in _minimax_h3_common.test.js.
  it.each([107, 124, 362])('accepts the %i-frame grid point inside the MLX window', (frames) => {
    const output = runPython(`${importRunner}\n${[
      'from types import SimpleNamespace',
      argsExpr({ width: 1536, height: 672, num_frames: frames }),
      'runner.validate_args(args)',
      'print("ok")',
    ].join('\n')}`);
    expect(output.trim()).toBe('ok');
  });

  it('rejects a frame count outside the MLX window', () => {
    const output = runPython(`${importRunner}\n${[
      'from types import SimpleNamespace',
      argsExpr({ width: 1536, height: 672, num_frames: 90 }),
      'try:',
      '    runner.validate_args(args)',
      'except SystemExit as exc:',
      '    print(str(exc))',
      'else:',
      '    raise SystemExit("an out-of-window frame count was accepted")',
    ].join('\n')}`);
    expect(output).toMatch(/approximately 4-15 seconds \(107-362 aligned frames\)/i);
  });

  // An unpaired --lora/--lora-scale would apply the wrong strength (or none) to
  // an adapter, and a missing file would only surface after the ~83 GB load.
  it.each([
    [['a.safetensors'], [], /one --lora-scale per --lora/i],
    [['a.safetensors', 'b.safetensors'], [0.8], /one --lora-scale per --lora/i],
    [['/nonexistent/a.safetensors'], [0.8], /LoRA file is missing/i],
  ])('rejects mismatched or missing LoRA arguments (%j / %j)', (loras, scales, pattern) => {
    const output = runPython(`${importRunner}\n${[
      'from types import SimpleNamespace',
      argsExpr({ lora: loras, lora_scale: scales }),
      'try:',
      '    runner.validate_args(args)',
      'except SystemExit as exc:',
      '    print(str(exc))',
      'else:',
      '    raise SystemExit("bad LoRA args were accepted")',
    ].join('\n')}`);
    expect(output).toMatch(pattern);
  });

  // A partial flag set would silently fall back to the stock conditioner and
  // hand back a render the user has no way to tell apart from the one they asked
  // for, so the boundary rejects it instead of choosing for them.
  it.each([
    [{ text_encoder_id: 'heretic-bf16' }, /must be given together/i],
    [{ text_encoder_file: ['/tmp/e.safetensors'] }, /must be given together/i],
    [{ text_encoder_id: 'heretic-bf16', text_encoder_file: ['/tmp/e.safetensors'] }, /must be given together/i],
    // A traversal-shaped id would put the shim tree outside the root PortOS
    // chose (and `rmtree` it from there).
    [
      {
        text_encoder_id: '../escape',
        text_encoder_file: ['/tmp/e.safetensors'],
        text_encoder_shim_root: '/tmp/shims',
      },
      /bare directory-safe name/i,
    ],
    // Loader mechanics with nothing to apply them to: accepting these would
    // rewrite the STOCK conditioner's keys and fail deep inside the load.
    [{ text_encoder_key_prefix: ['model.=model.language_model.'] }, /need --text-encoder-file/i],
    [{ text_encoder_final_norm_key: 'model.norm.weight' }, /need --text-encoder-file/i],
  ])('rejects an incoherent text-encoder argument set (%j)', (overrides, pattern) => {
    const output = runPython(`${importRunner}\n${[
      'from types import SimpleNamespace',
      argsExpr(overrides),
      'try:',
      '    runner.validate_args(args)',
      'except SystemExit as exc:',
      '    print(str(exc))',
      'else:',
      '    raise SystemExit("incoherent text-encoder args were accepted")',
    ].join('\n')}`);
    expect(output).toMatch(pattern);
  });

  it('accepts a complete text-encoder argument set', () => {
    const output = runPython(`${importRunner}\n${[
      'from types import SimpleNamespace',
      argsExpr({
        text_encoder_id: 'heretic-bf16',
        text_encoder_file: ['/tmp/e.safetensors'],
        text_encoder_shim_root: '/tmp/shims',
        text_encoder_key_prefix: ['model.=model.language_model.', 'visual.=model.visual.'],
        text_encoder_final_norm_key: 'model.norm.weight',
      }),
      'runner.validate_args(args)',
      'print("ok")',
    ].join('\n')}`);
    expect(output.trim()).toBe('ok');
  });

  // Sorted longest-source-first so a broader rule can never shadow a narrower
  // one that also matches, whatever order PortOS declares them in.
  it('parses key-prefix rules longest-source-first', () => {
    const output = runPython(`${importRunner}\n${[
      'import json',
      'print(json.dumps(runner.parse_key_prefixes(["model.=A.", "model.layers.=B.", "visual.=C."])))',
    ].join('\n')}`);
    expect(JSON.parse(output)).toEqual([
      ['model.layers.', 'B.'],
      ['visual.', 'C.'],
      ['model.', 'A.'],
    ]);
  });

  it.each(['model.', 'model.=', '=model.'])('rejects a malformed key-prefix rule (%j)', (rule) => {
    const output = runPython(`${importRunner}\n${[
      'try:',
      `    print(runner.parse_key_prefixes(${JSON.stringify([rule])}))`,
      'except SystemExit as exc:',
      '    print("REJECTED", str(exc))',
    ].join('\n')}`);
    // `model.=` is a legal rule (strip the prefix), so only the two without a
    // usable source are rejected — assert the split rather than blanket-failing.
    if (rule === 'model.=') expect(output).toMatch(/\[\('model\.', ''\)\]/);
    else expect(output).toMatch(/REJECTED/);
  });

  // The remap has to translate the SUBSTITUTE's namespace onto the one the
  // pinned loader matches, then delegate every real decision (which layers are
  // past the conditioning depth, what lm_head maps to) back to it — so the
  // adapter can't drift from the port's own contract.
  it('remaps checkpoint keys through the pinned loader rather than replacing it', () => {
    const output = runPython(`${importRunner}\n${[
      'import json, sys, types',
      // Stand in for the pinned module: `_wanted` records what it was handed.
      'seen = []',
      'class FakeEncoder:',
      '    def _wanted(self, key):',
      '        seen.append(key)',
      '        return ("language", key) if key.startswith("model.language_model.") else None',
      'module = types.ModuleType("minimax_h3_mlx.text_encoder")',
      'module.MiniMaxH3TextEncoder = FakeEncoder',
      'package = types.ModuleType("minimax_h3_mlx")',
      'sys.modules["minimax_h3_mlx"] = package',
      'sys.modules["minimax_h3_mlx.text_encoder"] = module',
      'runner.install_key_prefix_map(runner.parse_key_prefixes(["model.=model.language_model.", "visual.=model.visual."]))',
      'encoder = FakeEncoder()',
      'results = [encoder._wanted(k) for k in ["model.layers.0.mlp.up_proj.weight", "visual.blocks.0.attn.qkv.weight", "unrelated.weight"]]',
      'print(json.dumps({"seen": seen, "results": results}))',
    ].join('\n')}`);
    const { seen, results } = JSON.parse(output);
    expect(seen).toEqual([
      'model.language_model.layers.0.mlp.up_proj.weight',
      'model.visual.blocks.0.attn.qkv.weight',
      'unrelated.weight',
    ]);
    // The delegate's verdict is returned untouched — including its `None` for a
    // key it doesn't want, which is what keeps unmapped tensors skipped.
    expect(results).toEqual([
      ['language', 'model.language_model.layers.0.mlp.up_proj.weight'],
      null,
      null,
    ]);
  });

  // A pin whose loader no longer exposes `_wanted` must say so, not swap in a
  // conditioner whose keys nothing will map.
  it('refuses to swap a conditioner onto a pin with no _wanted hook', () => {
    const output = runPython(`${importRunner}\n${[
      'import sys, types',
      'class Bare: pass',
      'module = types.ModuleType("minimax_h3_mlx.text_encoder")',
      'module.MiniMaxH3TextEncoder = Bare',
      'sys.modules["minimax_h3_mlx"] = types.ModuleType("minimax_h3_mlx")',
      'sys.modules["minimax_h3_mlx.text_encoder"] = module',
      'try:',
      '    runner.install_key_prefix_map([("model.", "model.language_model.")])',
      'except RuntimeError as exc:',
      '    print(str(exc))',
      'else:',
      '    raise SystemExit("a pin with no _wanted hook was accepted")',
    ].join('\n')}`);
    expect(output).toMatch(/no longer exposes MiniMaxH3TextEncoder\._wanted/);
  });

  // The shim is what lets the PINNED `from_pretrained` load a swapped
  // conditioner unmodified: everything but `text_encoder/` is linked straight
  // through, and the tokenizer/processor the encoder reads from its parent
  // directory have to come along or the load fails after the weights are read.
  it('composes a checkpoint root with only text_encoder swapped', () => {
    const output = runPython(`${importRunner}\n${[
      'import json, tempfile',
      'with tempfile.TemporaryDirectory() as temp:',
      '    root = Path(temp)',
      '    checkpoint = root / "FL2VA"',
      '    for name in ("video_vae", "audio_vae", "tokenizer", "processor", "text_encoder"):',
      '        (checkpoint / name).mkdir(parents=True)',
      '    (checkpoint / "model_index.json").write_text("{}")',
      '    (checkpoint / "text_encoder" / "config.json").write_text(json.dumps({"text_config": {"hidden_size": 8}}))',
      '    (checkpoint / "text_encoder" / "model-00001-of-00002.safetensors").write_text("stock")',
      '    substitute = root / "substitute.safetensors"',
      '    substitute.write_text("swapped")',
      '    shim = runner.build_encoder_shim(checkpoint, root / "shims", "heretic-bf16", [substitute], None)',
      '    print(json.dumps({',
      '        "name": shim.name,',
      '        "root": sorted(p.name for p in shim.iterdir()),',
      '        "encoder": sorted(p.name for p in (shim / "text_encoder").iterdir()),',
      '        "tokenizer_links": (shim / "tokenizer").resolve() == (checkpoint / "tokenizer").resolve(),',
      '    }))',
    ].join('\n')}`);
    const result = JSON.parse(output);
    expect(result.name).toBe('heretic-bf16');
    expect(result.root).toEqual(['audio_vae', 'model_index.json', 'processor', 'text_encoder', 'tokenizer', 'video_vae']);
    // The stock shards are NOT linked in — the loader globs *.safetensors, so
    // leaving them would load both conditioners' weights over each other.
    expect(result.encoder).toEqual(['config.json', 'substitute.safetensors']);
    // The encoder resolves its tokenizer/processor from `_model_dir.parent`.
    expect(result.tokenizer_links).toBe(true);
  });

  // H3 reads the hidden state BEFORE the final norm, so a conditioner published
  // for it correctly omits that tensor — but the pinned loader builds the whole
  // module tree and refuses to load with any parameter missing.
  it.skipIf(!hasMlx)('synthesizes the missing final norm in the substitute key namespace', () => {
    const output = runPython(`${importRunner}\n${[
      'import json, tempfile',
      'with tempfile.TemporaryDirectory() as temp:',
      '    root = Path(temp)',
      '    checkpoint = root / "FL2VA"',
      '    (checkpoint / "text_encoder").mkdir(parents=True)',
      '    (checkpoint / "text_encoder" / "config.json").write_text(json.dumps({"text_config": {"hidden_size": 8}}))',
      '    substitute = root / "substitute.safetensors"',
      '    substitute.write_text("swapped")',
      '    shim = runner.build_encoder_shim(checkpoint, root / "shims", "heretic-bf16", [substitute], "model.norm.weight")',
      '    import mlx.core as mx',
      '    loaded = mx.load(str(shim / "text_encoder" / "_portos_final_norm.safetensors"))',
      '    key = next(iter(loaded))',
      '    print(json.dumps({"key": key, "shape": list(loaded[key].shape), "values": loaded[key].tolist()}))',
    ].join('\n')}`);
    const result = JSON.parse(output);
    // Written under the SUBSTITUTE's namespace so the prefix map rewrites it
    // like every other key — writing the post-map name would leave it unmapped
    // and the parameter still missing.
    expect(result.key).toBe('model.norm.weight');
    expect(result.shape).toEqual([8]);
    expect(result.values).toEqual(Array(8).fill(1));
  });

  it('rebuilds the shim from scratch so a stale link cannot survive', () => {
    const output = runPython(`${importRunner}\n${[
      'import json, tempfile',
      'with tempfile.TemporaryDirectory() as temp:',
      '    root = Path(temp)',
      '    checkpoint = root / "FL2VA"',
      '    (checkpoint / "text_encoder").mkdir(parents=True)',
      '    (checkpoint / "text_encoder" / "config.json").write_text(json.dumps({"text_config": {"hidden_size": 8}}))',
      '    stale = root / "shims" / "heretic-bf16" / "text_encoder"',
      '    stale.mkdir(parents=True)',
      '    (stale / "old.safetensors").write_text("stale")',
      '    substitute = root / "substitute.safetensors"',
      '    substitute.write_text("swapped")',
      '    shim = runner.build_encoder_shim(checkpoint, root / "shims", "heretic-bf16", [substitute], None)',
      '    print(json.dumps(sorted(p.name for p in (shim / "text_encoder").iterdir())))',
    ].join('\n')}`);
    expect(JSON.parse(output)).toEqual(['config.json', 'substitute.safetensors']);
  });

  it('fails a missing substitute before anything is composed', () => {
    const output = runPython(`${importRunner}\n${[
      'import json, tempfile',
      'with tempfile.TemporaryDirectory() as temp:',
      '    root = Path(temp)',
      '    checkpoint = root / "FL2VA"',
      '    (checkpoint / "text_encoder").mkdir(parents=True)',
      '    try:',
      '        runner.build_encoder_shim(checkpoint, root / "shims", "heretic-bf16", [root / "absent.safetensors"], None)',
      '    except RuntimeError as exc:',
      '        print(json.dumps({"error": str(exc), "built": (root / "shims").exists()}))',
      '    else:',
      '        raise SystemExit("a missing substitute was accepted")',
    ].join('\n')}`);
    const result = JSON.parse(output);
    expect(result.error).toMatch(/Substituted text encoder is missing/);
    expect(result.built).toBe(false);
  });

  // An upstream (rather than repackaged) conditioner arrives as several shards.
  // The loader globs *.safetensors in the shim, so every shard has to be linked
  // in — a partial link set loads a module tree with missing parameters.
  it('links every shard of a multi-shard substitute into one text_encoder', () => {
    const output = runPython(`${importRunner}\n${[
      'import json, tempfile',
      'with tempfile.TemporaryDirectory() as temp:',
      '    root = Path(temp)',
      '    checkpoint = root / "FL2VA"',
      '    (checkpoint / "text_encoder").mkdir(parents=True)',
      '    (checkpoint / "text_encoder" / "config.json").write_text(json.dumps({"text_config": {"hidden_size": 8}}))',
      '    shards = []',
      '    for name in ("model-00001-of-00014.safetensors", "model-00002-of-00014.safetensors", "model-00014-of-00014.safetensors"):',
      '        shard = root / name',
      '        shard.write_text(name)',
      '        shards.append(shard)',
      '    shim = runner.build_encoder_shim(checkpoint, root / "shims", "huihui-abliterated", shards, None)',
      '    linked = sorted(p.name for p in (shim / "text_encoder").iterdir())',
      '    print(json.dumps({"linked": linked, "resolves": [(shim / "text_encoder" / s.name).read_text() for s in shards]}))',
    ].join('\n')}`);
    const result = JSON.parse(output);
    expect(result.linked).toEqual([
      'config.json',
      'model-00001-of-00014.safetensors',
      'model-00002-of-00014.safetensors',
      'model-00014-of-00014.safetensors',
    ]);
    expect(result.resolves).toEqual([
      'model-00001-of-00014.safetensors',
      'model-00002-of-00014.safetensors',
      'model-00014-of-00014.safetensors',
    ]);
  });

  // Two shards sharing a basename would collide on the single symlink name, and
  // whichever lost would be silently absent from the glob.
  it('refuses a substitute whose shards share a basename', () => {
    const output = runPython(`${importRunner}\n${[
      'import json, tempfile',
      'with tempfile.TemporaryDirectory() as temp:',
      '    root = Path(temp)',
      '    checkpoint = root / "FL2VA"',
      '    (checkpoint / "text_encoder").mkdir(parents=True)',
      '    shards = []',
      '    for parent in ("a", "b"):',
      '        (root / parent).mkdir()',
      '        shard = root / parent / "model-00001-of-00002.safetensors"',
      '        shard.write_text(parent)',
      '        shards.append(shard)',
      '    try:',
      '        runner.build_encoder_shim(checkpoint, root / "shims", "dupe", shards, None)',
      '    except RuntimeError as exc:',
      '        print(json.dumps({"error": str(exc), "built": (root / "shims").exists()}))',
      '    else:',
      '        raise SystemExit("colliding shard names were accepted")',
    ].join('\n')}`);
    const result = JSON.parse(output);
    expect(result.error).toMatch(/duplicate shard names/);
    expect(result.built).toBe(false);
  });

  it('loads only the pinned namespace and cannot import a root-level shadow module', () => {
    const output = runPython(`${importRunner}\n${[
      'import importlib, tempfile',
      'with tempfile.TemporaryDirectory() as temp:',
      '    root = Path(temp) / "runtime"',
      '    package = root / "minimax_h3_mlx"',
      '    trusted = Path(temp) / "venv"',
      '    package.mkdir(parents=True)',
      '    trusted.mkdir()',
      '    (root / "mlx_vlm.py").write_text("SOURCE = \'runtime-shadow\'")',
      '    (trusted / "mlx_vlm.py").write_text("SOURCE = \'locked-venv\'")',
      '    (package / "pipeline.py").write_text("from mlx_vlm import SOURCE")',
      '    sys.path.insert(0, str(trusted))',
      '    runner.register_source_namespace("minimax_h3_mlx", package)',
      '    pipeline = importlib.import_module("minimax_h3_mlx.pipeline")',
      '    print(pipeline.SOURCE)',
      '    print(str(root) in sys.path)',
    ].join('\n')}`);
    expect(output.trim().split(/\r?\n/)).toEqual(['locked-venv', 'False']);
  });

  it('bounds the git checkout verification probe', () => {
    const output = runPython(`${importRunner}\n${[
      'from types import SimpleNamespace',
      'seen = {}',
      'def fake_run(*_args, **kwargs):',
      '    seen.update(kwargs)',
      '    return SimpleNamespace(stdout="# branch.oid expected\\n# branch.head (detached)\\n")',
      'runner.subprocess.run = fake_run',
      'runner.verify_runtime_checkout(Path("/tmp/runtime"), "expected")',
      'print(seen["timeout"])',
    ].join('\n')}`);
    expect(output.trim()).toBe('10');
  });
  // Keyframe conditioning is the one path with no torch under it: the MLX lock
  // ships neither torch nor torchvision, and transformers 5 routes every auto
  // image-processor load through them. Text-only renders never touch it, which
  // is why image-to-video was the only mode that failed.
  it('reads the runtime for the torch stack the auto processor needs', () => {
    const output = runPython(`${importRunner}\n${[
      'import json',
      'present = {"torch": object(), "torchvision": object(), "numpy": object()}',
      'runner.importlib.util.find_spec = present.get',
      'both = runner.torch_image_stack_available()',
      'present.pop("torchvision")',
      'vision_only = runner.torch_image_stack_available()',
      'present.pop("torch")',
      'neither = runner.torch_image_stack_available()',
      'print(json.dumps([both, vision_only, neither]))',
    ].join('\n')}`);
    // torch alone is not enough: it is the torchvision-backed video processor
    // that `AutoProcessor.from_pretrained` builds and dies on.
    expect(JSON.parse(output)).toEqual([true, false, false]);
  });

  it('loads the PIL twin of the image processor the checkpoint declares', () => {
    const output = runPython(`${importRunner}\n${[
      'import json, sys, tempfile, types',
      'loaded = {}',
      'class FakePil:',
      '    @classmethod',
      '    def from_pretrained(cls, path):',
      '        loaded["path"] = path',
      '        return "pil-image-processor"',
      'transformers = types.ModuleType("transformers")',
      'transformers.__version__ = "5.14.1"',
      'transformers.Qwen2VLImageProcessorPil = FakePil',
      'sys.modules["transformers"] = transformers',
      'with tempfile.TemporaryDirectory() as temp:',
      '    processor = Path(temp) / "processor"',
      '    processor.mkdir()',
      // The checkpoint names the torchvision class; the twin is derived off the
      // `Fast`-stripped base name rather than hardcoded to one checkpoint.
      '    (processor / "preprocessor_config.json").write_text(json.dumps({"image_processor_type": "Qwen2VLImageProcessorFast"}))',
      '    result = runner.load_pil_image_processor(processor)',
      '    print(json.dumps({"result": result, "path": loaded["path"] == str(processor)}))',
    ].join('\n')}`);
    expect(JSON.parse(output)).toEqual({ result: 'pil-image-processor', path: true });
  });

  it.each([
    ['{}', /names no image_processor_type/],
    ['{"image_processor_type": "InventedImageProcessor"}', /exposes no InventedImageProcessorPil/],
  ])('refuses a processor config it cannot resolve a PIL twin from (%s)', (config, expected) => {
    const output = runPython(`${importRunner}\n${[
      'import sys, tempfile, types',
      'transformers = types.ModuleType("transformers")',
      'transformers.__version__ = "5.14.1"',
      'sys.modules["transformers"] = transformers',
      'with tempfile.TemporaryDirectory() as temp:',
      '    processor = Path(temp) / "processor"',
      '    processor.mkdir()',
      `    (processor / "preprocessor_config.json").write_text(${JSON.stringify(config)})`,
      '    try:',
      '        runner.load_pil_image_processor(processor)',
      '    except RuntimeError as exc:',
      '        print(str(exc))',
      '    else:',
      '        raise SystemExit("an unresolvable processor config was accepted")',
    ].join('\n')}`);
    expect(output).toMatch(expected);
  });

  // The encoder reads exactly one thing off its processor, so the twin is bound
  // to that one attribute: building the rest is what pulls in the video
  // processor nothing here uses.
  it('binds the PIL twin to the only sub-processor the pinned encoder reads', () => {
    const output = runPython(`${importRunner}\n${stubPin([
      '    def __init__(self, model_dir):',
      '        self._model_dir = Path(model_dir)',
      '        self._processor = None',
      '    @property',
      '    def processor(self):',
      '        raise AssertionError("the pinned auto-processor property must not run")',
    ])}\n${[
      'import json',
      'seen = []',
      'runner.load_pil_image_processor = lambda directory: seen.append(directory) or "pil-image-processor"',
      'runner.install_pil_image_processor()',
      'encoder = MiniMaxH3TextEncoder("/checkpoint/text_encoder")',
      'first = encoder.processor',
      'print(json.dumps({',
      '    "image_processor": first.image_processor,',
      '    "cached": encoder.processor is first,',
      '    "loads": [str(p) for p in seen],',
      '}))',
    ].join('\n')}`);
    const result = JSON.parse(output);
    expect(result.image_processor).toBe('pil-image-processor');
    // One load per encoder — the pinned property memoizes on `_processor` and
    // the twin has to keep doing that or every keyframe re-reads the config.
    expect(result.cached).toBe(true);
    // Resolved off the encoder's own model dir, so a composed text-encoder shim
    // root keeps pointing at the processor it linked through.
    expect(result.loads).toEqual([join('/checkpoint', 'processor')]);
  });

  // mlx-vlm's loader sanitizes `patch_embed.proj.weight` into MLX's conv layout;
  // the pinned port loads the safetensors itself and skips it, so the tower gets
  // torch's `(C_out, C_in, kD, kH, kW)` and conv3d rejects the first keyframe.
  it('sanitizes the vision tower after the pinned load, not instead of it', () => {
    const output = runPython(`${importRunner}\n${stubPin([
      '    def _load_weights(self, model_dir, dtype, verbose):',
      '        order.append(("pinned load", str(model_dir), str(dtype), verbose))',
      '        self.vision = "vision-tower"',
    ], ['order = []'])}\n${[
      'import json',
      'runner.sanitize_vision_weights = lambda vision: order.append(("sanitize", vision))',
      'runner.install_vision_weight_sanitizer()',
      'MiniMaxH3TextEncoder()._load_weights(Path("/checkpoint/text_encoder"), "bfloat16", False)',
      'print(json.dumps(order))',
    ].join('\n')}`);
    // The pinned load runs first and unchanged — the correction is applied to
    // what it produced, so a pin that starts loading a sanitized weight keeps
    // working (mlx-vlm's own shape check makes the second pass a no-op).
    expect(JSON.parse(output)).toEqual([
      ['pinned load', join('/checkpoint', 'text_encoder'), 'bfloat16', false],
      ['sanitize', 'vision-tower'],
    ]);
  });

  it('leaves the vision tower alone when the encoder built none', () => {
    const output = runPython(`${importRunner}\n${[
      'runner.sanitize_vision_weights(None)',
      'print("ok")',
    ].join('\n')}`);
    // Reached on a text-only encoder (`load_vision=False`); importing mlx to
    // sanitize nothing would cost a load the run does not need.
    expect(output.trim()).toBe('ok');
  });

  // Each adapter patches a different method, and each is only correct against
  // the implementation it was written for — so a pin that moved has to be told
  // apart from one that still fits, before a render spends minutes loading.
  it.each([
    ['install_pil_image_processor', 'processor'],
    ['install_vision_weight_sanitizer', '_load_weights'],
    ['install_vision_embed_merge', 'encode'],
  ])('refuses to install %s onto a pin with no %s hook', (installer, hook) => {
    const output = runPython(`${importRunner}\n${stubPin(['    pass'])}\n${[
      'try:',
      `    runner.${installer}()`,
      'except RuntimeError as exc:',
      '    print(str(exc))',
      'else:',
      `    raise SystemExit("a pin with no ${hook} hook was accepted")`,
    ].join('\n')}`);
    expect(output).toMatch(new RegExp(`no longer exposes MiniMaxH3TextEncoder\\.${hook}`));
  });

  // A `processor` that is no longer a property is as much a pin change as an
  // absent one: the pinned caller would start calling it, and the replacement
  // is a property.
  it('refuses to bind the twin onto a processor that is no longer a property', () => {
    const output = runPython(`${importRunner}\n${stubPin(['    processor = "not-a-property"'])}\n${[
      'try:',
      '    runner.install_pil_image_processor()',
      'except RuntimeError as exc:',
      '    print(str(exc))',
      'else:',
      '    raise SystemExit("a non-property processor was accepted")',
    ].join('\n')}`);
    expect(output).toMatch(/no longer exposes MiniMaxH3TextEncoder\.processor/);
  });

  // The pinned encode merges the keyframe's vision rows with a BROADCAST, which
  // only lines up when the request is nothing but image tokens — every real
  // prompt + keyframe pair dies in `[broadcast_shapes]`. The correction re-runs
  // the pinned body with that one line swapped, so it is guarded twice: by the
  // line it replaces, and by a digest over the whole body it copied.
  it('corrects a pin that still merges by broadcast, and hands its text-only path back', () => {
    const output = runPython(`${importRunner}\n${importPins}\n${filePin(["pins.PINNED_BROADCAST_MERGE"])}\n${[
      'import hashlib, inspect',
      'pins.PINNED_ENCODE_DIGEST = hashlib.sha256(',
      '    inspect.getsource(MiniMaxH3TextEncoder.encode).encode("utf-8")',
      ').hexdigest()',
      'runner.install_vision_embed_merge()',
      'print(MiniMaxH3TextEncoder().encode("a prompt"))',
    ].join('\n')}`);
    // A text-only request has no merge to correct, so it must come back from the
    // pinned implementation untouched.
    expect(output.trim()).toBe("('pinned', 'a prompt', None)");
  });

  it.each([
    // Upstream fixed the merge: the correction has to retire, not shadow it.
    [['pins.PINNED_BROADCAST_MERGE.replace("mx.where", "masked_scatter")'], 'digest-of-this-pin', /no longer merges keyframe embeddings/],
    // The merge is untouched but something else in the body moved — the copy is
    // stale in a way matching one line could never see.
    [['pins.PINNED_BROADCAST_MERGE'], `"${'0'.repeat(64)}"`, /changed MiniMaxH3TextEncoder\.encode outside the merge/],
  ])('refuses a pin the copied encode no longer matches (%j)', (body, digest, expected) => {
    const output = runPython(`${importRunner}\n${importPins}\n${filePin(body)}\n${[
      'import hashlib, inspect',
      `pins.PINNED_ENCODE_DIGEST = ${digest === 'digest-of-this-pin'
        ? 'hashlib.sha256(inspect.getsource(MiniMaxH3TextEncoder.encode).encode("utf-8")).hexdigest()'
        : digest}`,
      'try:',
      '    runner.install_vision_embed_merge()',
      'except RuntimeError as exc:',
      '    print(str(exc))',
      'else:',
      '    raise SystemExit("a drifted pin was accepted")',
    ].join('\n')}`);
    expect(output).toMatch(expected);
  });
});
