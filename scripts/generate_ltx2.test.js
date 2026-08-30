import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const script = join(dirname(fileURLToPath(import.meta.url)), 'generate_ltx2.py');

// Probe for an interpreter that actually RUNS rather than assuming a name — on
// Windows a bare `python` can be a Store alias STUB that exists and exits
// non-zero. Null when there is genuinely none, so the suite skips rather than
// failing. Every helper exercised here is import-free by design (stdlib only),
// so no mlx/ltx wheel is needed.
const pyBin = resolveTestPython();
const runPython = (source) => execFileSync(pyBin, ['-c', source, script], { encoding: 'utf8' });

const importRunner = [
  'import importlib.util, sys',
  'from pathlib import Path',
  'script = Path(sys.argv[1])',
  'spec = importlib.util.spec_from_file_location("generate_ltx2", script)',
  'runner = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(runner)',
].join('\n');

// validate_text_encoder_args reads the namespace argparse produces, so every
// field it touches has to be present — a hand-built literal per test drifts the
// moment a flag is added (and fails as an AttributeError rather than an
// assertion). One builder carries the parser's own defaults; each test overrides
// only what it exercises.
const VALIDATE_ARGS_DEFAULTS = {
  gemma: null,
  text_encoder_id: null,
  text_encoder_file: [],
  text_encoder_shim_root: null,
  text_encoder_config_json: null,
};
const argsExpr = (overrides = {}) => {
  const fields = Object.entries({ ...VALIDATE_ARGS_DEFAULTS, ...overrides })
    .map(([key, value]) => `${key}=${value === null ? 'None' : JSON.stringify(value)}`);
  return `args = SimpleNamespace(${fields.join(', ')})`;
};

describe.skipIf(!pyBin)('generate_ltx2.py', () => {
  // A partial flag set would silently fall back to the conditioner packed in the
  // 2.5 model and hand back a render the user has no way to tell apart from the
  // one they asked for, so the boundary rejects it instead of choosing for them.
  it.each([
    [{ text_encoder_id: 'ltx25-heretic-8bit' }, /must be given together/i],
    [{ text_encoder_file: ['/tmp/config.json'] }, /must be given together/i],
    [
      { text_encoder_id: 'ltx25-heretic-8bit', text_encoder_file: ['/tmp/config.json'] },
      /must be given together/i,
    ],
    // A traversal-shaped id would put the shim tree outside the root PortOS
    // chose — and `rmtree` it from there on the next render.
    [
      {
        text_encoder_id: '../escape',
        text_encoder_file: ['/tmp/config.json'],
        text_encoder_shim_root: '/tmp/shims',
      },
      /bare directory-safe name/i,
    ],
    // A config rewrite with nothing to rewrite: accepting it would imply the
    // stock conditioner's config gets patched, which the shim never touches.
    [{ text_encoder_config_json: '{"model_type": "gemma4"}' }, /needs --text-encoder-file/i],
    // --gemma is only read when the pack ships no local gemma4 tower, which is
    // exactly the case where the override has nothing to replace.
    [
      {
        gemma: 'mlx-community/gemma-3-12b-it-4bit',
        text_encoder_id: 'ltx25-heretic-8bit',
        text_encoder_file: ['/tmp/config.json'],
        text_encoder_shim_root: '/tmp/shims',
      },
      /--gemma cannot apply/i,
    ],
    [
      {
        text_encoder_id: 'ltx25-heretic-8bit',
        text_encoder_file: ['/tmp/config.json'],
        text_encoder_shim_root: '/tmp/shims',
        text_encoder_config_json: 'not json',
      },
      /must be valid JSON/i,
    ],
    // A bare array/string would silently contribute no keys to the merge.
    [
      {
        text_encoder_id: 'ltx25-heretic-8bit',
        text_encoder_file: ['/tmp/config.json'],
        text_encoder_shim_root: '/tmp/shims',
        text_encoder_config_json: '["model_type"]',
      },
      /must be a JSON object/i,
    ],
  ])('rejects an incoherent text-encoder argument set (%j)', (overrides, pattern) => {
    const output = runPython(`${importRunner}\n${[
      'from types import SimpleNamespace',
      argsExpr(overrides),
      'try:',
      '    runner.validate_text_encoder_args(args)',
      'except SystemExit as exc:',
      '    print(str(exc))',
      'else:',
      '    raise SystemExit("incoherent text-encoder args were accepted")',
    ].join('\n')}`);
    expect(output).toMatch(pattern);
  });

  it.each([
    ['a complete set', {
      text_encoder_id: 'ltx25-heretic-8bit',
      text_encoder_file: ['/tmp/config.json', '/tmp/model-00001-of-00003.safetensors'],
      text_encoder_shim_root: '/tmp/shims',
      text_encoder_config_json: '{"model_type": "gemma4"}',
    }],
    // The stock choice: no flags at all, and --gemma still allowed because that
    // is the untouched LTX-2.3 path through the same runner.
    ['no flags at all', {}],
    ['the 2.3 shared encoder alone', { gemma: 'mlx-community/gemma-3-12b-it-4bit' }],
  ])('accepts %s', (_label, overrides) => {
    const output = runPython(`${importRunner}\n${[
      'from types import SimpleNamespace',
      argsExpr(overrides),
      'runner.validate_text_encoder_args(args)',
      'print("ok")',
    ].join('\n')}`);
    expect(output.trim()).toBe('ok');
  });

  // The shim is a STANDALONE Gemma 4 checkpoint dir — unlike the H3 sibling it
  // links nothing through from the model pack, because mlx-lm loads a Gemma 4
  // tower from one self-describing directory.
  it('links every pinned file and generates config.json from the substitute', () => {
    const output = runPython(`${importRunner}\n${[
      'import json, tempfile',
      'with tempfile.TemporaryDirectory() as temp:',
      '    root = Path(temp)',
      '    src = root / "src"',
      '    src.mkdir()',
      '    (src / "config.json").write_text(json.dumps({',
      '        "model_type": "gemma4_unified",',
      '        "text_config": {"num_hidden_layers": 48, "hidden_size": 3840},',
      '        "quantization": {"group_size": 32, "bits": 8},',
      '        "vision_config": {"drop": True},',
      '        "audio_config": {"drop": True},',
      '    }))',
      '    for name in ("model-00001-of-00002.safetensors", "model-00002-of-00002.safetensors",',
      '                 "model.safetensors.index.json", "tokenizer.json", "tokenizer_config.json"):',
      '        (src / name).write_text(name)',
      '    files = sorted(src.iterdir())',
      '    shim = runner.build_ltx25_encoder_shim(',
      '        root / "shims", "ltx25-heretic-8bit", files, {"model_type": "gemma4"})',
      '    print(json.dumps({',
      '        "name": shim.name,',
      '        "linked": sorted(p.name for p in shim.iterdir()),',
      '        "config": json.loads((shim / "config.json").read_text()),',
      '        "config_is_link": (shim / "config.json").is_symlink(),',
      '        "shard_resolves": (shim / "tokenizer.json").read_text(),',
      '    }))',
    ].join('\n')}`);
    const result = JSON.parse(output);
    expect(result.name).toBe('ltx25-heretic-8bit');
    // Every pinned file is present, config.json among them — but generated.
    expect(result.linked).toEqual([
      'config.json',
      'model-00001-of-00002.safetensors',
      'model-00002-of-00002.safetensors',
      'model.safetensors.index.json',
      'tokenizer.json',
      'tokenizer_config.json',
    ]);
    expect(result.config_is_link).toBe(false);
    expect(result.shard_resolves).toBe('tokenizer.json');
    // The one label Gemma4LanguageModel.load() hard-rejects, corrected…
    expect(result.config.model_type).toBe('gemma4');
    // …the towers mlx-lm's sanitizer discards anyway, dropped so what remains
    // matches what the fork's own converter emits…
    expect(result.config.vision_config).toBeUndefined();
    expect(result.config.audio_config).toBeUndefined();
    // …and the packing metadata copied verbatim: a group-size mismatch
    // dequantizes to noise.
    expect(result.config.quantization).toEqual({ group_size: 32, bits: 8 });
    expect(result.config.text_config).toEqual({ num_hidden_layers: 48, hidden_size: 3840 });
  });

  // A text-only export already reports `gemma4`, so it declares no overrides —
  // the shim still regenerates config.json (to drop the towers), it just changes
  // no label.
  it('generates config.json unchanged when there are no overrides', () => {
    const output = runPython(`${importRunner}\n${[
      'import json, tempfile',
      'with tempfile.TemporaryDirectory() as temp:',
      '    root = Path(temp)',
      '    src = root / "src"',
      '    src.mkdir()',
      '    (src / "config.json").write_text(json.dumps({"model_type": "gemma4", "text_config": {"a": 1}}))',
      '    (src / "model.safetensors").write_text("w")',
      '    shim = runner.build_ltx25_encoder_shim(root / "shims", "ltx25-abliterated-4bit",',
      '                                           sorted(src.iterdir()), {})',
      '    print(json.dumps(json.loads((shim / "config.json").read_text())))',
    ].join('\n')}`);
    expect(JSON.parse(output)).toEqual({ model_type: 'gemma4', text_config: { a: 1 } });
  });

  it('drops only the unified checkpoint visual embedder before strict loading', () => {
    const output = runPython(`${importRunner}\n${[
      'import json',
      'weights = {',
      '    "model.vision_embedder.patch_dense.weight": "drop-prefixed",',
      '    "vision_embedder.pos_embedding": "drop-flat",',
      '    "model.language_model.model.embed_tokens.weight": "keep-language",',
      '    "vision_embedderish.weight": "keep-near-match",',
      '}',
      'print(json.dumps(runner.filter_ltx25_unified_weights(weights), sort_keys=True))',
    ].join('\n')}`);
    expect(JSON.parse(output)).toEqual({
      'model.language_model.model.embed_tokens.weight': 'keep-language',
      'vision_embedderish.weight': 'keep-near-match',
    });
  });

  // Rebuilt from scratch every render: a stale shim pointing at a blob the user
  // has since re-downloaded would otherwise load silently-wrong weights.
  it('replaces a stale shim rather than merging into it', () => {
    const output = runPython(`${importRunner}\n${[
      'import json, tempfile',
      'with tempfile.TemporaryDirectory() as temp:',
      '    root = Path(temp)',
      '    src = root / "src"',
      '    src.mkdir()',
      '    (src / "config.json").write_text(json.dumps({"model_type": "gemma4"}))',
      '    (src / "model.safetensors").write_text("fresh")',
      '    stale = root / "shims" / "ltx25-abliterated-4bit"',
      '    stale.mkdir(parents=True)',
      '    (stale / "model-00009-of-00009.safetensors").write_text("stale")',
      '    shim = runner.build_ltx25_encoder_shim(root / "shims", "ltx25-abliterated-4bit",',
      '                                           sorted(src.iterdir()), {})',
      '    print(json.dumps(sorted(p.name for p in shim.iterdir())))',
    ].join('\n')}`);
    expect(JSON.parse(output)).toEqual(['config.json', 'model.safetensors']);
  });

  it.each([
    [
      'a file that is not on disk',
      ['    files = [src / "config.json", root / "absent.safetensors"]'],
      /Substituted text encoder is missing/,
    ],
    // Every file is linked by basename, so two same-named files from different
    // subdirectories would collide on one symlink name.
    [
      'two files with the same basename',
      [
        '    (src / "nested").mkdir()',
        '    (src / "nested" / "config.json").write_text("{}")',
        '    files = [src / "config.json", src / "nested" / "config.json"]',
      ],
      /duplicate file names/,
    ],
    // The generated config.json is derived from the substitute's own, so an
    // entry that never pinned it has nothing to derive from.
    [
      'a file set with no config.json',
      ['    files = [src / "model.safetensors"]'],
      /must pin its own config\.json/,
    ],
  ])('refuses to build a shim from %s', (_label, setup, pattern) => {
    const output = runPython(`${importRunner}\n${[
      'import json, tempfile',
      'with tempfile.TemporaryDirectory() as temp:',
      '    root = Path(temp)',
      '    src = root / "src"',
      '    src.mkdir()',
      '    (src / "config.json").write_text(json.dumps({"model_type": "gemma4"}))',
      '    (src / "model.safetensors").write_text("w")',
      ...setup,
      '    try:',
      '        runner.build_ltx25_encoder_shim(root / "shims", "e", files, {})',
      '    except RuntimeError as exc:',
      '        print(str(exc))',
      '    else:',
      '        raise SystemExit("an unbuildable shim was accepted")',
    ].join('\n')}`);
    expect(output).toMatch(pattern);
  });

  // Patched on the CLASS, not on a constructed pipeline, so no mode — present or
  // added later — can build a pipeline that skips the substitution.
  const stubPromptEncoder = (encoderClassName) => [
    'import sys, types',
    'pkg = types.ModuleType("ltx_pipelines_mlx")',
    'utils = types.ModuleType("ltx_pipelines_mlx.utils")',
    'blocks = types.ModuleType("ltx_pipelines_mlx.utils.blocks")',
    `class ${encoderClassName}: pass`,
    'class PromptEncoder:',
    '    def _text_encoder_source(self):',
    `        return "/packed/text_encoder", ${encoderClassName}`,
    'blocks.PromptEncoder = PromptEncoder',
    'sys.modules["ltx_pipelines_mlx"] = pkg',
    'sys.modules["ltx_pipelines_mlx.utils"] = utils',
    'sys.modules["ltx_pipelines_mlx.utils.blocks"] = blocks',
  ];

  it('redirects the packed conditioner resolution at the shim for every instance', () => {
    const output = runPython(`${importRunner}\n${[
      ...stubPromptEncoder('Gemma4LanguageModel'),
      'runner.install_ltx25_encoder_override(Path("/shims/ltx25-heretic-8bit"))',
      // A pipeline constructed AFTER the patch and one whose class was captured
      // before it both resolve to the shim — that is the point of patching the
      // class rather than an instance.
      'path, cls = PromptEncoder()._text_encoder_source()',
      'print(path)',
      // The encoder CLASS still comes from the pinned fork's own resolution, so
      // nothing here imports it from a path the fork could move.
      'print(cls.__name__)',
    ].join('\n')}`);
    // Split on \r?\n: Python's print writes CRLF on Windows, and a trailing \r
    // on the first line would fail an equality that passes everywhere else.
    expect(output.trim().split(/\r?\n/)).toEqual([
      join('/shims', 'ltx25-heretic-8bit'),
      'Gemma4LanguageModel',
    ]);
  });

  // Reaching this flag on an LTX-2.3 model dir would condition on a Gemma 3
  // tower loaded from a Gemma 4 shim — fail loudly instead.
  it('refuses to substitute into a pack whose own conditioner is not gemma4', () => {
    const output = runPython(`${importRunner}\n${[
      ...stubPromptEncoder('GemmaLanguageModel'),
      'runner.install_ltx25_encoder_override(Path("/shims/e"))',
      'try:',
      '    PromptEncoder()._text_encoder_source()',
      'except RuntimeError as exc:',
      '    print(str(exc))',
      'else:',
      '    raise SystemExit("a non-gemma4 pack was substituted into")',
    ].join('\n')}`);
    expect(output).toMatch(/needs an LTX-2\.5 pack whose own conditioner is gemma4/);
    expect(output).toMatch(/GemmaLanguageModel/);
  });

  // ── Gemma prompt-encode budget + boundary markers (#4589) ──────────────────
  // The markers are what lets PortOS tell "the Metal watchdog killed the prompt
  // encoder" (worth one relaunch at a smaller budget) from "it killed the
  // denoise loop" (not worth anything), so their exact text and their emission
  // on BOTH the success and the failure path are load-bearing.
  const stubPromptEncoderModule = (body) => [
    'import sys, types',
    'pkg = types.ModuleType("ltx_pipelines_mlx")',
    'utils = types.ModuleType("ltx_pipelines_mlx.utils")',
    'blocks = types.ModuleType("ltx_pipelines_mlx.utils.blocks")',
    'class PromptEncoder:',
    ...body,
    'blocks.PromptEncoder = PromptEncoder',
    'sys.modules["ltx_pipelines_mlx"] = pkg',
    'sys.modules["ltx_pipelines_mlx.utils"] = utils',
    'sys.modules["ltx_pipelines_mlx.utils.blocks"] = blocks',
  ];

  it('brackets a successful prompt encode with the two markers, once per install', () => {
    const output = runPython(`${importRunner}\n${[
      ...stubPromptEncoderModule([
        '    def encode(self, prompt):',
        '        print("ENCODED:" + prompt)',
        '        return ("video", "audio")',
      ]),
      'import contextlib',
      // Installed twice on purpose: main() runs once, but an idempotent patch is
      // what keeps a future second install from nesting the brackets and
      // emitting the begin marker twice for one encode.
      'runner.install_prompt_encode_markers()',
      'runner.install_prompt_encode_markers()',
      'with contextlib.redirect_stderr(sys.stdout):',
      '    result = PromptEncoder().encode("a cat")',
      'print(result)',
    ].join('\n')}`);
    const lines = output.trim().split(/\r?\n/);
    expect(lines).toEqual([
      'STAGE:encode-prompt',
      'ENCODED:a cat',
      'STAGE:encode-prompt-done',
      "('video', 'audio')",
    ]);
  });

  // The end marker means "control left the encoder", not "the encode succeeded".
  // Emitting it from `finally` biases PortOS AWAY from relaunching, which is the
  // safe direction — a hard Metal abort kills the process outright, so `finally`
  // never runs and the phase correctly stays open.
  it('still emits the end marker when the encode raises', () => {
    const output = runPython(`${importRunner}\n${[
      ...stubPromptEncoderModule([
        '    def encode(self, prompt):',
        '        raise RuntimeError("gemma exploded")',
      ]),
      'import contextlib',
      'runner.install_prompt_encode_markers()',
      'with contextlib.redirect_stderr(sys.stdout):',
      '    try:',
      '        PromptEncoder().encode("a cat")',
      '    except RuntimeError as exc:',
      '        print("RAISED:" + str(exc))',
    ].join('\n')}`);
    expect(output.trim().split(/\r?\n/)).toEqual([
      'STAGE:encode-prompt',
      'STAGE:encode-prompt-done',
      'RAISED:gemma exploded',
    ]);
  });

  // A pin without PromptEncoder must not crash the render — PortOS simply never
  // sees an encode phase there, and so never arms the retry.
  it('is a no-op when the pin exposes no PromptEncoder', () => {
    const output = runPython(`${importRunner}\n${[
      'import sys',
      'sys.modules.pop("ltx_pipelines_mlx.utils.blocks", None)',
      'runner.install_prompt_encode_markers()',
      'print("ok")',
    ].join('\n')}`);
    expect(output.trim()).toBe('ok');
  });

  // ltx-2-mlx reads LTX2_GEMMA_MAX_LENGTH at encode time and defaults it to
  // 1024, so the flag has to ASSIGN — a setdefault would be swallowed by the
  // ambient value the parent already exported and the relaunch would re-run at
  // the budget that just aborted.
  it.each([
    ['None', 'None', null, '1024'],
    ['a lowered budget', '512', null, '512'],
    ['a lowered budget over an ambient value', '512', '1024', '512'],
  ])('configure_gemma_max_length(%s) resolves LTX2_GEMMA_MAX_LENGTH to the expected value', (_label, flag, ambient, expected) => {
    const output = runPython(`${importRunner}\n${[
      'import os',
      ambient === null
        ? 'os.environ.pop("LTX2_GEMMA_MAX_LENGTH", None)'
        : `os.environ["LTX2_GEMMA_MAX_LENGTH"] = ${JSON.stringify(ambient)}`,
      `runner.configure_gemma_max_length(${flag})`,
      // Read back through the same default upstream applies, so "unset" and
      // "explicitly 1024" are both expressed as the value the encoder would use.
      'print(os.environ.get("LTX2_GEMMA_MAX_LENGTH", "1024"))',
    ].join('\n')}`);
    expect(output.trim()).toBe(expected);
  });

  it.each([['0'], ['-1']])('rejects a non-positive --gemma-max-length (%s)', (value) => {
    const output = runPython(`${importRunner}\n${[
      'try:',
      `    runner.configure_gemma_max_length(${value})`,
      'except SystemExit as exc:',
      '    print(str(exc))',
      'else:',
      '    raise SystemExit("a non-positive gemma budget was accepted")',
    ].join('\n')}`);
    expect(output).toMatch(/must be a positive integer/);
  });

  it.each([
    ['omitted', [], 'None'],
    ['given', ['--gemma-max-length', '512'], '512'],
  ])('parses --gemma-max-length when %s', (_label, extra, expected) => {
    const output = runPython(`${importRunner}\n${[
      'import sys',
      `sys.argv = ["generate_ltx2.py", "--mode", "text", "--prompt", "p", "--output", "/tmp/o.mp4", "--model", "m"] + ${JSON.stringify(extra)}`,
      'print(runner.parse_args().gemma_max_length)',
    ].join('\n')}`);
    expect(output.trim()).toBe(expected);
  });

  // The reference-mode promise (#4874). "inspire" is only expressible where the
  // pin carries a per-image conditioning strength; everywhere else the helper has
  // to FAIL, because falling back to a bare `image=` would anchor the very frame
  // the user asked not to be anchored.
  describe('i2v reference mode', () => {
    // A fake generate_and_save whose signature decides which pin the helper sees:
    // `images=` present is the v0.14.x API, absent is a pre-rename pin.
    const condKwargs = ({ hasImagesParam, referenceMode, imageStrength }) => runPython(`${importRunner}\n${[
      'import sys, types',
      hasImagesParam
        ? 'def gen(prompt=None, images=None, image=None): pass'
        : 'def gen(prompt=None, image=None): pass',
      // Stand in for the ltx wheel: the helper only needs a constructor whose
      // instances it can hand back, and repr is what we assert against.
      'class ICI:',
      '    def __init__(self, path, frame_idx, strength):',
      '        self.path, self.frame_idx, self.strength = path, frame_idx, strength',
      '    def __repr__(self):',
      '        return f"ICI({self.path},{self.frame_idx},{self.strength})"',
      hasImagesParam
        ? 'runner._import_image_conditioning_input = lambda: ICI'
        : 'runner._import_image_conditioning_input = lambda: None',
      // The legacy monkey-patch needs the real ltx modules; report "absent" so
      // the anchored fallback path is exercised without them.
      'runner._apply_legacy_image_strength = lambda strength: False',
      'try:',
      `    print(repr(runner._image_conditioning_kwargs(gen, "/tmp/ref.png", ${imageStrength === null ? 'None' : imageStrength}, "${referenceMode}")))`,
      'except SystemExit as exc:',
      '    print("SystemExit:", str(exc))',
    ].join('\n')}`);

    it('leaves an unset anchored reference exactly as it was before the flag existed', () => {
      const out = condKwargs({ hasImagesParam: true, referenceMode: 'anchor', imageStrength: null });
      expect(out.trim()).toBe("{'image': '/tmp/ref.png'}");
    });

    it('resolves the loose default when no strength was given', () => {
      const out = condKwargs({ hasImagesParam: true, referenceMode: 'inspire', imageStrength: null });
      expect(out).toMatch(/ICI\(\/tmp\/ref\.png,0,0\.35\)/);
    });

    it('honors an explicit strength under a loose reference', () => {
      const out = condKwargs({ hasImagesParam: true, referenceMode: 'inspire', imageStrength: 0.8 });
      expect(out).toMatch(/ICI\(\/tmp\/ref\.png,0,0\.8\)/);
    });

    it('FAILS rather than anchoring when the pin has no per-image strength', () => {
      const out = condKwargs({ hasImagesParam: false, referenceMode: 'inspire', imageStrength: 0.5 });
      expect(out).toMatch(/SystemExit:/);
      expect(out).toMatch(/does not expose/i);
    });

    it('still degrades gracefully for an anchored reference on the same old pin', () => {
      const out = condKwargs({ hasImagesParam: false, referenceMode: 'anchor', imageStrength: 0.5 });
      expect(out.trim()).toContain("{'image': '/tmp/ref.png'}");
    });

    it.each(['text', 'fflf', 'extend', 'a2v', 'ic'])('rejects a loose reference in %s mode', (mode) => {
      const out = runPython(`${importRunner}\n${[
        'from types import SimpleNamespace',
        `args = SimpleNamespace(i2v_reference_mode="inspire", mode="${mode}")`,
        'try:',
        '    runner.validate_reference_mode_args(args)',
        'except SystemExit as exc:',
        '    print(str(exc))',
        'else:',
        '    raise SystemExit("a loose reference was accepted outside image mode")',
      ].join('\n')}`);
      expect(out).toMatch(/applies to --mode image only/);
    });

    it('accepts a loose reference in image mode, and anchor anywhere', () => {
      const out = runPython(`${importRunner}\n${[
        'from types import SimpleNamespace',
        'runner.validate_reference_mode_args(SimpleNamespace(i2v_reference_mode="inspire", mode="image"))',
        'runner.validate_reference_mode_args(SimpleNamespace(i2v_reference_mode="anchor", mode="a2v"))',
        'print("ok")',
      ].join('\n')}`);
      expect(out.trim()).toBe('ok');
    });

    it('defaults the flag to anchor and rejects an unknown value at the parser', () => {
      const parsed = runPython(`${importRunner}\n${[
        'import sys',
        'sys.argv = ["generate_ltx2.py", "--mode", "image", "--prompt", "p", "--output", "/tmp/o.mp4", "--model", "m"]',
        'print(runner.parse_args().i2v_reference_mode)',
      ].join('\n')}`);
      expect(parsed.trim()).toBe('anchor');
    });
  });

  it('parses the optional bounded preview directory', () => {
    const output = runPython(`${importRunner}\n${[
      'import sys',
      'sys.argv = ["generate_ltx2.py", "--mode", "text", "--prompt", "p", "--output", "/tmp/o.mp4", "--model", "m", "--preview-dir", "/tmp/previews"]',
      'print(runner.parse_args().preview_dir)',
    ].join('\n')}`);
    expect(output.trim()).toBe('/tmp/previews');
  });
});

// Speed profiles (#4875). The Node side decides the schedule declaratively;
// this process owns the two questions only it can answer — is the pinned
// pipeline new enough for `enable_teacache`, and is the required distilled
// adapter in the pack — and reports both back on one SPEEDPROFILE: line. All
// stdlib-only, so no mlx/ltx wheel is needed here.
describe.skipIf(!pyBin)('generate_ltx2.py speed-profile reporting', () => {
  const PROFILE_ARGS = [
    'import argparse',
    'def ns(**kw):',
    "    d = dict(speed_profile='fast', steps=8, stage2_steps=3, cfg_scale=1.0,",
    "             teacache=True, teacache_thresh=None, require_adapter='needed.safetensors', mode='text')",
    '    d.update(kw)',
    '    return argparse.Namespace(**d)',
    // Capture the STATUS:/SPEEDPROFILE: lines the helper writes to stderr.
    'import contextlib, io',
    'ERR = io.StringIO()',
  ].join('\n');

  const runProfile = (body) => runPython(`${importRunner}\n${PROFILE_ARGS}\n${body}`);

  // Python's print() ends lines with \r\n on Windows, so a plain split('\n')
  // leaves a trailing \r that trim()-ing the whole output cannot reach.
  const outLines = (out) => out.trim().split(/\r?\n/).map((l) => l.trimEnd());

  // A pin that HAS the kwarg (the shipped one) vs a pre-rename pin that does
  // not. The second case is the one that matters: passing the kwarg there is a
  // TypeError mid-render, not a slow render.
  const PIN_DEFS = [
    'def modern(self, prompt, output_path, *, frame_rate, stage1_steps=None, enable_teacache=False, teacache_thresh=None): ...',
    'def legacy(self, prompt, output_path, *, frame_rate, stage1_steps=None): ...',
    'def kwargs_pin(self, prompt, output_path, **kw): ...',
  ].join('\n');

  it('passes the TeaCache kwargs through on a pin that accepts them', () => {
    const out = runProfile([
      PIN_DEFS,
      'runner.speed_profile_begin(ns())',
      'with contextlib.redirect_stderr(ERR):',
      '    kw = runner._two_stage_teacache_kwargs(modern, ns())',
      "print(sorted(kw.items()))",
      "print(runner._SPEED_PROFILE_REPORT['teacache'], runner._SPEED_PROFILE_REPORT['degraded'])",
    ].join('\n'));
    // No threshold override declared, so the kwarg is omitted entirely and
    // the pin applies its own calibrated default (0.5) — passing None would
    // just re-state the default through an argument some pins don't have.
    expect(out).toContain("[('enable_teacache', True)]");
    expect(out).toContain('True []');
  });

  // A bare **kwargs wrapper ACCEPTS the argument without erroring, but nothing
  // says it forwards it — so claiming the speed-up would be exactly the
  // misleading claim this whole path exists to prevent. Degrade instead.
  it('degrades on a bare **kwargs pin rather than claiming an unverifiable speed-up', () => {
    const out = runProfile([
      PIN_DEFS,
      'runner.speed_profile_begin(ns())',
      'with contextlib.redirect_stderr(ERR):',
      '    kw = runner._two_stage_teacache_kwargs(kwargs_pin, ns())',
      "print(kw, runner._SPEED_PROFILE_REPORT['teacache'], runner._SPEED_PROFILE_REPORT['degraded'])",
    ].join('\n'));
    expect(out.trim()).toBe("{} False ['teacache']");
  });

  // A pin carrying enable_teacache but NOT teacache_thresh must not be handed
  // the second kwarg — that is a TypeError mid-render, i.e. a lever we could
  // not apply turned into a failed render.
  // A positional-only parameter (or a `**name` catch-all spelled the same)
  // matches by NAME but cannot be passed by keyword — accepting it would raise
  // TypeError at the call, the very outcome the probe exists to avoid.
  it('rejects a same-named parameter that cannot actually be passed by keyword', () => {
    const out = runProfile([
      // positional-only (PEP 570) and a catch-all that happens to share the name
      'def positional_only(self, enable_teacache=False, /, *, frame_rate=24): ...',
      'def catch_all(self, *, frame_rate=24, **enable_teacache): ...',
      'def keyword_ok(self, *, frame_rate=24, enable_teacache=False): ...',
      "print(runner._accepts_kwarg(positional_only, 'enable_teacache'))",
      "print(runner._accepts_kwarg(catch_all, 'enable_teacache'))",
      "print(runner._accepts_kwarg(keyword_ok, 'enable_teacache'))",
    ].join('\n'));
    expect(outLines(out)).toEqual(['False', 'False', 'True']);
  });

  it('probes teacache_thresh separately from enable_teacache', () => {
    const out = runProfile([
      'def enable_only(self, prompt, output_path, *, frame_rate, stage1_steps=None, enable_teacache=False): ...',
      'runner.speed_profile_begin(ns(teacache_thresh=0.8))',
      'with contextlib.redirect_stderr(ERR):',
      '    kw = runner._two_stage_teacache_kwargs(enable_only, ns(teacache_thresh=0.8))',
      'print(sorted(kw.items()))',
      // TeaCache itself applied, but the profile asked to sample at 0.8 and the
      // render did not — a partly-applied profile, so it is recorded as such
      // rather than reported as a clean full run.
      "print(runner._SPEED_PROFILE_REPORT['teacache'], runner._SPEED_PROFILE_REPORT['degraded'])",
      "print(runner._SPEED_PROFILE_REPORT['teacacheThresh'])",
    ].join('\n'));
    const [kw, state, thresh] = outLines(out);
    expect(kw).toBe("[('enable_teacache', True)]");
    expect(state).toBe("True ['teacacheThresh']");
    expect(thresh).toBe('None');
  });

  // The mirror case: NO override declared means nothing was lost — the pin's
  // own calibrated default is exactly what the profile wanted, so this must
  // NOT be reported as degraded.
  it('does not degrade when the profile declared no threshold to lose', () => {
    const out = runProfile([
      'def enable_only(self, prompt, output_path, *, frame_rate, stage1_steps=None, enable_teacache=False): ...',
      'runner.speed_profile_begin(ns(teacache_thresh=None))',
      'with contextlib.redirect_stderr(ERR):',
      '    kw = runner._two_stage_teacache_kwargs(enable_only, ns(teacache_thresh=None))',
      "print(sorted(kw.items()), runner._SPEED_PROFILE_REPORT['degraded'])",
    ].join('\n'));
    expect(out.trim()).toBe("[('enable_teacache', True)] []");
  });

  it('omits teacache_thresh entirely when the profile declares no override', () => {
    const out = runProfile([
      PIN_DEFS,
      'runner.speed_profile_begin(ns())',
      'with contextlib.redirect_stderr(ERR):',
      '    kw = runner._two_stage_teacache_kwargs(modern, ns())',
      "print(sorted(kw.items()))",
    ].join('\n'));
    expect(out.trim()).toBe("[('enable_teacache', True)]");
  });

  // The core honesty rule: an unavailable lever degrades LOUDLY. The render
  // still happens at the profile's step schedule; it just isn't presented as
  // the full speed-up.
  it('degrades with an explicit status when the pin predates the kwarg', () => {
    const out = runProfile([
      PIN_DEFS,
      'runner.speed_profile_begin(ns())',
      'with contextlib.redirect_stderr(ERR):',
      '    kw = runner._two_stage_teacache_kwargs(legacy, ns())',
      'print(kw)',
      "print(runner._SPEED_PROFILE_REPORT['degraded'])",
      "print([l for l in ERR.getvalue().splitlines() if l.startswith('STATUS:')])",
    ].join('\n'));
    expect(out).toContain('{}');
    expect(out).toContain("['teacache']");
    expect(out).toMatch(/STATUS:TeaCache unavailable/);
  });

  it('passes an explicit threshold override through', () => {
    const out = runProfile([
      PIN_DEFS,
      'runner.speed_profile_begin(ns(teacache_thresh=0.8))',
      'with contextlib.redirect_stderr(ERR):',
      '    kw = runner._two_stage_teacache_kwargs(modern, ns(teacache_thresh=0.8))',
      "print(kw['teacache_thresh'])",
    ].join('\n'));
    expect(out.trim()).toBe('0.8');
  });

  // DEFAULT PRESERVATION: without --speed-profile the whole mechanism is inert.
  it('is completely silent and emits nothing without a profile', () => {
    const out = runProfile([
      PIN_DEFS,
      'runner.speed_profile_begin(ns(speed_profile=None))',
      'with contextlib.redirect_stderr(ERR):',
      '    kw = runner._two_stage_teacache_kwargs(modern, ns(speed_profile=None, teacache=False))',
      "    runner.speed_profile_degrade('teacache', 'should not appear')",
      '    runner.speed_profile_emit()',
      'print(kw, runner._SPEED_PROFILE_REPORT, repr(ERR.getvalue()))',
    ].join('\n'));
    expect(out.trim()).toBe("{} {} ''");
  });

  it('never enables TeaCache when the profile did not ask for it', () => {
    const out = runProfile([
      PIN_DEFS,
      'runner.speed_profile_begin(ns(teacache=False))',
      'with contextlib.redirect_stderr(ERR):',
      '    kw = runner._two_stage_teacache_kwargs(modern, ns(teacache=False))',
      "print(kw, runner._SPEED_PROFILE_REPORT['degraded'])",
    ].join('\n'));
    expect(out.trim()).toBe('{} []');
  });

  it('emits a single parseable SPEEDPROFILE: line naming what applied', () => {
    const out = runProfile([
      PIN_DEFS,
      'import json',
      'runner.speed_profile_begin(ns())',
      'with contextlib.redirect_stderr(ERR):',
      '    runner._two_stage_teacache_kwargs(modern, ns())',
      "    runner.speed_profile_applied(adapter='needed.safetensors')",
      '    runner.speed_profile_emit()',
      "lines = [l for l in ERR.getvalue().splitlines() if l.startswith('SPEEDPROFILE:')]",
      'print(len(lines))',
      "print(json.dumps(json.loads(lines[0][len('SPEEDPROFILE:'):]), sort_keys=True))",
    ].join('\n'));
    const [count, payload] = outLines(out);
    expect(count).toBe('1');
    expect(JSON.parse(payload)).toEqual({
      id: 'fast',
      steps: 8,
      stage2Steps: 3,
      cfgScale: 1.0,
      teacache: true,
      teacacheThresh: null,
      adapter: 'needed.safetensors',
      degraded: [],
    });
  });

  it('does not repeat a lever already recorded as degraded', () => {
    const out = runProfile([
      'runner.speed_profile_begin(ns())',
      'with contextlib.redirect_stderr(ERR):',
      "    runner.speed_profile_degrade('teacache', 'first')",
      "    runner.speed_profile_degrade('teacache', 'second')",
      "print(runner._SPEED_PROFILE_REPORT['degraded'])",
    ].join('\n'));
    expect(out.trim()).toBe("['teacache']");
  });

  it.each([
    ['omitted', [], ['None', 'False', 'None']],
    ['given', ['--speed-profile', 'fast', '--teacache', '--require-adapter', 'a.safetensors'], ['fast', 'True', 'a.safetensors']],
  ])('parses the speed-profile flags when %s', (_label, extra, expected) => {
    const out = runPython(`${importRunner}\n${[
      'import sys',
      `sys.argv = ["generate_ltx2.py", "--mode", "text", "--prompt", "p", "--output", "/tmp/o.mp4", "--model", "m"] + ${JSON.stringify(extra)}`,
      'a = runner.parse_args()',
      'print(a.speed_profile)',
      'print(a.teacache)',
      'print(a.require_adapter)',
    ].join('\n')}`);
    expect(outLines(out)).toEqual(expected);
  });
});

// The allocator-cache ceiling is what keeps MLX's freed-buffer cache from
// competing with a long render's live tensors. Every case here runs against the
// module's own helpers rather than a real MLX: the policy has to be right on a
// machine size the test host does not have, and the "installed MLX has no such
// API" branch cannot be produced by an install that does.
describe.skipIf(!pyBin)('generate_ltx2.py MLX allocator-cache policy', () => {
  const GB = 1024 * 1024 * 1024;
  const runJson = (body) => JSON.parse(runPython(`${importRunner}\n${body.join('\n')}`));

  // A fake mlx.core planted in sys.modules, so the probe sees exactly the API
  // surface each case is about — and never the host's real wheel.
  const fakeMlx = (attrs) => [
    'import sys, types',
    'CALLS = []',
    'core = types.ModuleType("mlx.core")',
    ...attrs,
    'pkg = types.ModuleType("mlx")',
    'pkg.core = core',
    'sys.modules["mlx"] = pkg',
    'sys.modules["mlx.core"] = core',
  ];
  const MODERN_MLX = fakeMlx(['core.set_cache_limit = lambda n: CALLS.append(("modern", n))']);
  const LEGACY_MLX = fakeMlx([
    'core.metal = types.SimpleNamespace(set_cache_limit=lambda n: CALLS.append(("legacy", n)))',
  ]);
  const NO_CACHE_API = fakeMlx(['core.metal = types.SimpleNamespace()']);
  // A venv with no MLX at all reaches the same branch through the import.
  const NO_MLX = ['import sys', 'sys.modules["mlx"] = None', 'sys.modules.pop("mlx.core", None)'];

  it.each([
    // Under the floor a proportional cap would leave the allocator thrashing,
    // so a small machine still gets the 1 GB floor rather than 512 MB.
    ['a machine below the floor', 4 * GB, 1024],
    ['a 16 GB machine', 16 * GB, 2048],
    ['a 64 GB machine', 64 * GB, 8192],
    // 1/8 hits the ceiling exactly at 96 GB; past it the cap holds, so a very
    // large box does not park tens of GB in the cache "just in case".
    ['the machine where the ceiling starts biting', 96 * GB, 12288],
    ['a 512 GB machine', 512 * GB, 12288],
  ])('derives a bounded ceiling for %s', (_label, bytes, expected) => {
    const result = runJson([
      'import json',
      `print(json.dumps(runner.derive_mlx_cache_limit_mb(${bytes})))`,
    ]);
    expect(result).toBe(expected);
  });

  // An unreadable machine gets NO policy rather than the floor: a blind 1 GB
  // cap would throttle a large box exactly as readily as it protects a small
  // one, and MLX's own default is the known-safe behavior.
  it.each([['unknown', 'None'], ['zero', '0'], ['negative', '-1'], ['non-numeric', '"lots"']])(
    'derives no ceiling from %s physical memory',
    (_label, expr) => {
      const result = runJson(['import json', `print(json.dumps(runner.derive_mlx_cache_limit_mb(${expr})))`]);
      expect(result).toBeNull();
    },
  );

  it('prefers an explicit flag over the environment, and both over the derived ceiling', () => {
    const result = runJson([
      'import json',
      'physical = 64 * 1024 ** 3',
      'print(json.dumps({',
      '    "flag": runner.resolve_mlx_cache_policy(physical, "2048", "3072"),',
      '    "env": runner.resolve_mlx_cache_policy(physical, None, "3072"),',
      '    "derived": runner.resolve_mlx_cache_policy(physical, None, None),',
      '    "unknown": runner.resolve_mlx_cache_policy(None, None, None),',
      '}))',
    ]);
    // An override REPLACES the derived ceiling — 2048 is below what a 64 GB box
    // would derive, and it still wins.
    expect(result.flag).toEqual({ limitMb: 2048, source: 'flag' });
    expect(result.env).toEqual({ limitMb: 3072, source: 'env' });
    expect(result.derived).toEqual({ limitMb: 8192, source: 'derived' });
    expect(result.unknown).toEqual({ limitMb: null, source: 'unknown-memory' });
  });

  // Silently ignoring a bad override would report a ceiling the caller never
  // asked for, which is worse than refusing the run.
  it.each([
    ['a word', '"lots"', /--mlx-cache-limit-mb must be a positive whole number/],
    ['zero', '"0"', /--mlx-cache-limit-mb must be a positive whole number/],
    ['a negative count', '"-512"', /--mlx-cache-limit-mb must be a positive whole number/],
    ['a fraction', '"2048.5"', /--mlx-cache-limit-mb must be a positive whole number/],
  ])('rejects %s as an override', (_label, expr, pattern) => {
    const output = runPython(`${importRunner}\n${[
      'try:',
      `    runner.resolve_mlx_cache_policy(64 * 1024 ** 3, ${expr}, None)`,
      'except SystemExit as exc:',
      '    print(str(exc))',
      'else:',
      '    raise SystemExit("a bad cache-limit override was accepted")',
    ].join('\n')}`);
    expect(output).toMatch(pattern);
  });

  it('rejects a bad ambient override by its environment-variable name', () => {
    const output = runPython(`${importRunner}\n${[
      'try:',
      '    runner.resolve_mlx_cache_policy(64 * 1024 ** 3, None, "not-a-number")',
      'except SystemExit as exc:',
      '    print(str(exc))',
      'else:',
      '    raise SystemExit("a bad ambient cache limit was accepted")',
    ].join('\n')}`);
    expect(output).toMatch(/PORTOS_MLX_CACHE_LIMIT_MB must be a positive whole number/);
  });

  it.each([
    ['the modern spelling', MODERN_MLX, 'modern'],
    // A pin predating the move still has to be capped, so the legacy spelling
    // is probed rather than assumed gone.
    ['the legacy mx.metal spelling', LEGACY_MLX, 'legacy'],
  ])('applies the limit through %s', (_label, mlx, expectedSpelling) => {
    const result = runJson([
      ...mlx,
      'import json',
      'applied = runner.apply_mlx_cache_policy({"limitMb": 2048, "source": "flag"})',
      'print(json.dumps({"applied": applied, "calls": CALLS}))',
    ]);
    expect(result.applied).toBe(true);
    // MB in the policy, BYTES at the MLX boundary.
    expect(result.calls).toEqual([[expectedSpelling, 2048 * 1024 * 1024]]);
  });

  it.each([
    ['exposes no cache-limit API', NO_CACHE_API],
    ['is not installed at all', NO_MLX],
  ])('degrades with a status line when the MLX %s', (_label, mlx) => {
    const result = runJson([
      ...mlx,
      'import contextlib, io, json',
      'err = io.StringIO()',
      'with contextlib.redirect_stderr(err):',
      '    applied = runner.apply_mlx_cache_policy({"limitMb": 2048, "source": "flag"}, announce=True)',
      'print(json.dumps({"applied": applied, "stderr": err.getvalue()}))',
    ]);
    expect(result.applied).toBe(false);
    expect(result.stderr).toMatch(/^STATUS:Installed MLX exposes no cache-limit API/);
  });

  it('reports the effective policy on the existing STATUS channel', () => {
    const result = runJson([
      ...MODERN_MLX,
      'import contextlib, io, json',
      'err = io.StringIO()',
      'with contextlib.redirect_stderr(err):',
      '    runner.apply_mlx_cache_policy({"limitMb": 8192, "source": "derived"}, announce=True)',
      '    runner.apply_mlx_cache_policy({"limitMb": None, "source": "unknown-memory"}, announce=True)',
      'print(json.dumps({"stderr": err.getvalue()}))',
    ]);
    expect(result.stderr.split(/\r?\n/).filter(Boolean)).toEqual([
      'STATUS:MLX allocator cache capped at 8192 MB (derived)',
      'STATUS:MLX allocator cache left at its default — physical memory unknown',
    ]);
  });

  // Loading weights resets the allocator limit, and a two-stage or chained job
  // renders more than once inside one process — so the cap has to be reasserted
  // per render, not just at startup.
  it('reasserts the ceiling before every render', () => {
    const result = runJson([
      ...MODERN_MLX,
      'import json',
      'from types import SimpleNamespace',
      'runner._MLX_CACHE_POLICY = {"limitMb": 4096, "source": "flag"}',
      'runner._install_ltx_stepwise_preview = lambda pipe, args: (lambda: None)',
      'rendered = []',
      'for _ in range(3):',
      '    runner._run_with_ltx_stepwise_preview(object(), SimpleNamespace(), lambda: rendered.append(1))',
      'print(json.dumps({"renders": len(rendered), "calls": CALLS}))',
    ]);
    expect(result.renders).toBe(3);
    expect(result.calls).toEqual(Array.from({ length: 3 }, () => ['modern', 4096 * 1024 * 1024]));
  });

  // The reassertion must never be what fails a render: an MLX that raises from
  // the setter still lets the render proceed uncapped.
  it('lets the render proceed when the MLX setter raises', () => {
    const result = runJson([
      ...fakeMlx(['def boom(_n): raise RuntimeError("metal is busy")', 'core.set_cache_limit = boom']),
      'import contextlib, io, json',
      'err = io.StringIO()',
      'with contextlib.redirect_stderr(err):',
      '    applied = runner.apply_mlx_cache_policy({"limitMb": 2048, "source": "flag"}, announce=True)',
      'print(json.dumps({"applied": applied, "stderr": err.getvalue()}))',
    ]);
    expect(result.applied).toBe(false);
    expect(result.stderr).toMatch(/metal is busy/);
  });

  // The startup call and the per-render reassertion have to read the SAME
  // policy, so the one main() installs is the one the render path picks up.
  it('installs the run policy the render path then reasserts', () => {
    const result = runJson([
      ...MODERN_MLX,
      'import contextlib, io, json',
      'from types import SimpleNamespace',
      'with contextlib.redirect_stderr(io.StringIO()):',
      '    policy = runner.configure_mlx_cache(SimpleNamespace(mlx_cache_limit_mb="2048"))',
      'runner._install_ltx_stepwise_preview = lambda pipe, args: (lambda: None)',
      'runner._run_with_ltx_stepwise_preview(object(), SimpleNamespace(), lambda: None)',
      'print(json.dumps({"policy": policy, "stored": runner._MLX_CACHE_POLICY, "calls": CALLS}))',
    ]);
    expect(result.policy).toEqual({ limitMb: 2048, source: 'flag' });
    expect(result.stored).toEqual(result.policy);
    // Once at startup, once more for the render.
    expect(result.calls).toEqual([
      ['modern', 2048 * 1024 * 1024],
      ['modern', 2048 * 1024 * 1024],
    ]);
  });

  it('parses the override flag and defaults it to absent', () => {
    const out = runPython(`${importRunner}\n${[
      'import sys',
      'base = ["generate_ltx2.py", "--mode", "text", "--prompt", "p", "--output", "/tmp/o.mp4", "--model", "m"]',
      'sys.argv = base',
      'print(runner.parse_args().mlx_cache_limit_mb)',
      'sys.argv = base + ["--mlx-cache-limit-mb", "2048"]',
      'print(runner.parse_args().mlx_cache_limit_mb)',
    ].join('\n')}`);
    expect(out.trim().split(/\r?\n/).map((l) => l.trimEnd())).toEqual(['None', '2048']);
  });
});
