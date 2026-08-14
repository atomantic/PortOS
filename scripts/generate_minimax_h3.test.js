import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const script = join(dirname(fileURLToPath(import.meta.url)), 'generate_minimax_h3.py');

// Resolve an interpreter that actually RUNS, rather than trusting a name on
// PATH. On Windows a machine with no Store-installed Python still has `python`
// on PATH as a Microsoft Store ALIAS STUB: it exists, exits non-zero, and
// prints "Python was not found; run without arguments to install from the
// Microsoft Store". A which/where-style check passes on that stub and every
// case then fails with an opaque "Command failed", so the probe has to execute
// something trivial. The `py` launcher is checked too — it is the standard
// Windows entry point — but it is itself a shim that can point at an
// uninstalled version, so it gets the same treatment.
//
// PORTOS_TEST_PYTHON overrides the whole search when a machine needs it.
//
// PortOS provisions its own interpreters (setup:image / setup:video build venvs
// under ~/.portos, and imageGen.local.pythonPath names whichever python the
// install was pointed at), so a machine can be fully set up for image/video gen
// while the BARE `python` name is still a Store stub. Fall back to those before
// concluding there is no interpreter — otherwise this suite silently skips on
// exactly the machines that exercise the script it covers.
const portosPythons = () => {
  const home = homedir();
  const venvBin = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python3'];
  const roots = ['venv-flux2', 'venv-mflux', 'venv-video', 'voice'];
  const found = roots.map((v) => join(home, '.portos', v, ...venvBin));
  if (process.platform === 'win32') found.push(join(home, 'miniconda3', 'python.exe'));
  return found.filter((p) => existsSync(p));
};

const PY_CANDIDATES = [
  process.env.PORTOS_TEST_PYTHON,
  process.platform === 'win32' ? 'python' : 'python3',
  process.platform === 'win32' ? 'python3' : 'python',
  ...(process.platform === 'win32' ? ['py'] : []),
  ...portosPythons(),
].filter(Boolean);

const pyBin = PY_CANDIDATES.find((candidate) => {
  try {
    execFileSync(candidate, ['-c', 'pass'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}) || null;

const runPython = (source) => execFileSync(pyBin, ['-c', source, script], {
  encoding: 'utf8',
});

const importRunner = [
  'import importlib.util, sys',
  'from pathlib import Path',
  'script = Path(sys.argv[1])',
  'spec = importlib.util.spec_from_file_location("generate_minimax_h3", script)',
  'runner = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(runner)',
].join('\n');

describe.skipIf(!pyBin)('generate_minimax_h3.py', () => {
  it('keeps the lexical HF snapshot root when cache entries are blob symlinks', () => {
    const output = runPython(`${importRunner}\n${[
      'import tempfile',
      'with tempfile.TemporaryDirectory() as temp:',
      '    root = Path(temp)',
      '    blob = root / "blobs" / "abc"',
      '    blob.parent.mkdir(parents=True)',
      '    blob.write_text("weights")',
      '    entry = root / "snapshots" / "revision" / "FL2VA" / "config.json"',
      '    entry.parent.mkdir(parents=True)',
      '    entry.symlink_to(blob)',
      '    print(runner.snapshot_root(entry, "FL2VA/config.json"))',
    ].join('\n')}`);
    expect(output.trim()).toMatch(/snapshots[/\\]revision$/);
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

  it('fails the ffmpeg preflight before any model load can begin', () => {
    const output = runPython(`${importRunner}\n${[
      'runner.shutil.which = lambda _name: None',
      'try:',
      '    runner.require_ffmpeg()',
      'except RuntimeError as exc:',
      '    print(str(exc))',
      'else:',
      '    raise SystemExit("missing preflight did not fail")',
    ].join('\n')}`);
    expect(output).toMatch(/ffmpeg is required/i);
  });

  it('rejects zero dimensions at the execution boundary', () => {
    const output = runPython(`${importRunner}\n${[
      'from types import SimpleNamespace',
      'args = SimpleNamespace(fps=24, width=0, height=320, num_frames=124, steps=8, lora=[], lora_scale=[], image=[], anchor=[])',
      'try:',
      '    runner.validate_args(args)',
      'except SystemExit as exc:',
      '    print(str(exc))',
      'else:',
      '    raise SystemExit("zero dimensions were accepted")',
    ].join('\n')}`);
    expect(output).toMatch(/dimensions must be positive multiples of 32/i);
  });

  // An unpaired or repeated anchor would silently mis-place a keyframe in the
  // packed sequence, so both fail at the boundary rather than rendering.
  it.each([
    [['a.png', 'b.png'], ['first'], /one --anchor per --image/i],
    [['a.png', 'b.png'], ['first', 'first'], /anchors must be distinct/i],
  ])('rejects mismatched keyframe anchors (%j / %j)', (images, anchors, pattern) => {
    const output = runPython(`${importRunner}\n${[
      'from types import SimpleNamespace',
      `args = SimpleNamespace(fps=24, width=512, height=320, num_frames=124, steps=8, lora=[], lora_scale=[], image=${JSON.stringify(images)}, anchor=${JSON.stringify(anchors)})`,
      'try:',
      '    runner.validate_args(args)',
      'except SystemExit as exc:',
      '    print(str(exc))',
      'else:',
      '    raise SystemExit("bad anchors were accepted")',
    ].join('\n')}`);
    expect(output).toMatch(pattern);
  });

  it('accepts a paired first/last keyframe request', () => {
    const output = runPython(`${importRunner}\n${[
      'from types import SimpleNamespace',
      'args = SimpleNamespace(fps=24, width=512, height=320, num_frames=124, steps=8, lora=[], lora_scale=[], image=["a.png", "b.png"], anchor=["first", "last"])',
      'runner.validate_args(args)',
      'print("ok")',
    ].join('\n')}`);
    expect(output.trim()).toBe('ok');
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
      `args = SimpleNamespace(fps=24, width=512, height=320, num_frames=124, steps=8, image=[], anchor=[], lora=${JSON.stringify(loras)}, lora_scale=${JSON.stringify(scales)})`,
      'try:',
      '    runner.validate_args(args)',
      'except SystemExit as exc:',
      '    print(str(exc))',
      'else:',
      '    raise SystemExit("bad LoRA args were accepted")',
    ].join('\n')}`);
    expect(output).toMatch(pattern);
  });

  // Reading the keyframes happens before the ~83 GB load, so a bad path costs
  // a second rather than an hour. Both branches asserted here run WITHOUT
  // Pillow — CI's bare python3 has no PIL, and blocking `import PIL` on them
  // would make a missing-file report (and every text-only run) need it.
  it('fails a missing conditioning image without importing Pillow', () => {
    const output = runPython(`${importRunner}\n${[
      'import sys',
      'sys.modules["PIL"] = None  # make any `from PIL import ...` fail loudly',
      'try:',
      '    runner.load_keyframes(["/nonexistent/first.png"])',
      'except RuntimeError as exc:',
      '    print(str(exc))',
      'else:',
      '    raise SystemExit("missing keyframe was accepted")',
    ].join('\n')}`);
    expect(output).toMatch(/Conditioning image is missing/i);
  });

  it('skips the Pillow import entirely for a text-only run', () => {
    const output = runPython(`${importRunner}\n${[
      'import sys',
      'sys.modules["PIL"] = None',
      'print(runner.load_keyframes([]))',
    ].join('\n')}`);
    expect(output.trim()).toBe('[]');
  });

  // A later keyframe's bad path must not cost a decode of the earlier one.
  it('validates every keyframe path before opening any of them', () => {
    const output = runPython(`${importRunner}\n${[
      'import sys, tempfile',
      'sys.modules["PIL"] = None',
      'with tempfile.NamedTemporaryFile(suffix=".png") as good:',
      '    try:',
      '        runner.load_keyframes([good.name, "/nonexistent/last.png"])',
      '    except RuntimeError as exc:',
      '        print(str(exc))',
      '    else:',
      '        raise SystemExit("missing second keyframe was accepted")',
    ].join('\n')}`);
    expect(output).toMatch(/Conditioning image is missing: \/nonexistent\/last\.png/);
  });

  it('emits the video_path JSON completion contract on stdout', () => {
    const output = runPython(`${importRunner}\nrunner.emit_result(Path("/tmp/example.mp4"))`);
    // The contract is "the output path, as JSON under video_path" — not
    // "the separators you typed". pathlib.Path normalizes to the host
    // separator, so on Windows this comes back '\tmp\example.mp4'. Compare on a
    // normalized copy rather than pinning POSIX.
    const { video_path: videoPath } = JSON.parse(output);
    expect(videoPath.split('\\').join('/')).toBe('/tmp/example.mp4');
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
