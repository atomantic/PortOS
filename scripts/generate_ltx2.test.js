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
});
