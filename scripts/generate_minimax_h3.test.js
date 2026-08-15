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
  steps: 8,
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

describe.skipIf(!pyBin)('generate_minimax_h3.py', () => {
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
});
