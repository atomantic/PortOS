import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

// The helpers both MiniMax H3 runners share. They used to be copied into each
// runner and tested twice, which is exactly the shape that lets a fix land in
// one copy and leave the other broken — the lexical-snapshot-root rule below
// being the one where that would be silent. One module, one suite.
const script = join(dirname(fileURLToPath(import.meta.url)), '_minimax_h3_common.py');

// Probe for an interpreter that actually RUNS rather than assuming a name. On
// Windows a box with no Store-installed Python still has `python` on PATH as an
// alias STUB: it exists, exits non-zero, and prints "Python was not found", so a
// name-only choice passes here and then every case dies with an opaque "Command
// failed". Null when there is genuinely none, so the suite skips.
const pyBin = resolveTestPython();
const runPython = (source) => execFileSync(pyBin, ['-c', source, script], {
  encoding: 'utf8',
});

// Python on Windows writes CRLF, so splitting on newlines alone leaves a
// trailing carriage return that fails every string comparison on its own.
const lines = (output) => output.trim().split('\n').map((line) => line.trimEnd());

// Load the module by path (it is stdlib-only at import time, which is what
// makes it importable from both venvs — and from a bare interpreter here).
const importShared = [
  'import importlib.util, sys',
  'from pathlib import Path',
  'script = Path(sys.argv[1])',
  'spec = importlib.util.spec_from_file_location("_minimax_h3_common", script)',
  'shared = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(shared)',
].join('\n');

// Drive validate_h3_output_args through a real argparse Namespace, the same
// object both runners build.
const validate = (overrides = {}, window = {}) => {
  const fields = {
    fps: 24, width: 1344, height: 768, num_frames: 124, steps: 8,
    image: [], anchor: [], ...overrides,
  };
  const bounds = { min_frames: 124, max_frames: 345, ...window };
  return runPython(`${importShared}\n${[
    'import argparse, json',
    `args = argparse.Namespace(**json.loads(${JSON.stringify(JSON.stringify(fields))}))`,
    'try:',
    '    shared.validate_h3_output_args(',
    '        args,',
    `        min_frames=${bounds.min_frames},`,
    `        max_frames=${bounds.max_frames},`,
    '        frame_window_message="WINDOW",',
    '    )',
    '    print("OK")',
    'except SystemExit as exc:',
    '    print(f"REJECTED:{exc}")',
  ].join('\n')}`).trim();
};

describe.skipIf(!pyBin)('_minimax_h3_common.py — checkpoint facts shared by both H3 runners', () => {
  // The shared validator reads these exact fields off the parsed Namespace, so
  // the two runners have to present the same surface or one of them can hand it
  // an attribute that doesn't exist. Declaring the flags once is what makes that
  // true; the per-runner sampler default is an explicit parameter because MLX
  // and diffusers count their schedules differently.
  it('declares the CLI surface both runners share', () => {
    const output = lines(runPython(`${importShared}\n${[
      'import argparse',
      'parser = shared.add_h3_common_args(argparse.ArgumentParser())',
      'for action in parser._actions:',
      '    if action.dest == "help":',
      '        continue',
      '    print(f"{action.dest}:{action.required}:{action.default}")',
    ].join('\n')}`));
    expect(output).toEqual([
      'model_repo:True:None',
      'model_revision:True:None',
      'prompt:True:None',
      'width:True:None',
      'height:True:None',
      'num_frames:True:None',
      'fps:False:24',
      'steps:False:8',
      'seed:False:0',
      'image:False:[]',
      'anchor:False:[]',
      'output:True:None',
    ]);
  });

  it('states the fixed fps and frame grid once', () => {
    const output = lines(runPython(`${importShared}\n${[
      'print(f"{shared.FPS},{shared.FRAME_MODULUS},{shared.FRAME_REMAINDER}")',
    ].join('\n')}`));
    expect(output[0]).toBe('24,17,5');
  });

  describe('validate_h3_output_args', () => {
    it('accepts a legal request', () => {
      expect(validate()).toBe('OK');
    });

    it('locks fps to 24', () => {
      expect(validate({ fps: 30 })).toMatch(/^REJECTED:.*fixed 24 fps/);
    });

    it('requires positive 32px-aligned dimensions', () => {
      expect(validate({ width: 0 })).toMatch(/^REJECTED:.*multiples of 32/);
      expect(validate({ height: 770 })).toMatch(/^REJECTED:.*multiples of 32/);
      expect(validate({ width: 960, height: 544 })).toBe('OK');
    });

    it('takes the duration window from the caller, not from a shared constant', () => {
      // This is the one H3 constraint that genuinely differs between the two
      // runners (diffusers 5-15s vs the MLX port's 4-15s), so the shared check
      // must defer to the bounds and the message it is handed.
      expect(validate({ num_frames: 107 }, { min_frames: 124 })).toBe('REJECTED:WINDOW');
      expect(validate({ num_frames: 107 }, { min_frames: 107 })).toBe('OK');
      expect(validate({ num_frames: 362 }, { max_frames: 345 })).toBe('REJECTED:WINDOW');
      expect(validate({ num_frames: 362 }, { max_frames: 362 })).toBe('OK');
    });

    it('requires a 17n+5 frame count inside whatever window it was given', () => {
      expect(validate({ num_frames: 130 })).toMatch(/^REJECTED:.*17n\+5/);
    });

    it('requires at least 2 sigma grid points', () => {
      expect(validate({ steps: 1 })).toMatch(/^REJECTED:.*2 sigma grid points/);
    });

    it('requires one anchor per image, and distinct anchors', () => {
      expect(validate({ image: ['a.png', 'b.png'], anchor: ['first'] }))
        .toMatch(/^REJECTED:.*one --anchor per --image/);
      // A repeated anchor would overwrite one keyframe's latent position with
      // the other's, silently rendering something nobody asked for.
      expect(validate({ image: ['a.png', 'b.png'], anchor: ['first', 'first'] }))
        .toMatch(/^REJECTED:.*distinct/);
      expect(validate({ image: ['a.png', 'b.png'], anchor: ['first', 'last'] })).toBe('OK');
    });
  });

  describe('resolve_cached_snapshot', () => {
    it('keeps the lexical snapshot root when cache entries are blob symlinks', () => {
      // Resolving the symlink would walk OUT of the snapshot into blobs/ and
      // hand the pipeline a directory with no component layout at all.
      const output = runPython(`${importShared}\n${[
        'import tempfile, types',
        'with tempfile.TemporaryDirectory() as temp:',
        '    root = Path(temp)',
        '    blob = root / "blobs" / "abc"',
        '    blob.parent.mkdir(parents=True)',
        '    blob.write_text("weights")',
        '    entry = root / "snapshots" / "revision" / "transformer" / "config.json"',
        '    entry.parent.mkdir(parents=True)',
        '    entry.symlink_to(blob)',
        '    fake = types.ModuleType("huggingface_hub")',
        '    fake.hf_hub_download = lambda **kw: str(entry)',
        '    sys.modules["huggingface_hub"] = fake',
        '    print(shared.resolve_cached_snapshot("org/repo", "revision", ["transformer/config.json"]))',
      ].join('\n')}`);
      expect(output.trim()).toMatch(/snapshots[/\\]revision$/);
    });

    it('names the PortOS-side remedy when a pinned file is not cached', () => {
      // A bare huggingface_hub error would send the user hunting through a
      // cache directory; naming the file and the remedy is what makes it act.
      const output = runPython(`${importShared}\n${[
        'import types',
        'fake = types.ModuleType("huggingface_hub")',
        'def boom(**kw): raise OSError("not found locally")',
        'fake.hf_hub_download = boom',
        'sys.modules["huggingface_hub"] = fake',
        'try:',
        '    shared.resolve_cached_snapshot("org/repo", "0123456789abcdef", ["transformer/config.json"])',
        'except RuntimeError as exc:',
        '    print(exc)',
      ].join('\n')}`);
      expect(output).toContain('Use Download in Video Gen');
      expect(output).toContain('transformer/config.json');
    });

    it('refuses an empty file list rather than resolving nothing', () => {
      const output = runPython(`${importShared}\n${[
        'try:',
        '    shared.resolve_cached_snapshot("org/repo", "revision", [])',
        'except RuntimeError as exc:',
        '    print(exc)',
      ].join('\n')}`);
      expect(output).toContain('No required files declared');
    });

    it('refuses a set of files that spans two snapshots', () => {
      const output = runPython(`${importShared}\n${[
        'import itertools, tempfile, types',
        'with tempfile.TemporaryDirectory() as temp:',
        '    root = Path(temp)',
        '    paths = []',
        '    for rev in ("revA", "revB"):',
        '        entry = root / "snapshots" / rev / "transformer" / "config.json"',
        '        entry.parent.mkdir(parents=True)',
        '        entry.write_text("x")',
        '        paths.append(str(entry))',
        '    it = iter(paths)',
        '    fake = types.ModuleType("huggingface_hub")',
        '    fake.hf_hub_download = lambda **kw: next(it)',
        '    sys.modules["huggingface_hub"] = fake',
        '    try:',
        '        shared.resolve_cached_snapshot("org/repo", "revision", ["transformer/config.json", "transformer/other.json"])',
        '    except RuntimeError as exc:',
        '        print(exc)',
      ].join('\n')}`);
      expect(output).toContain('span multiple snapshots');
    });
  });

  it('emits the video_path JSON completion contract on stdout', () => {
    // PortOS arms its teardown watchdog on this line, so it must be the only
    // thing on stdout and must parse.
    const output = runPython(`${importShared}\nshared.emit_result(Path("/tmp/example.mp4"))`);
    expect(JSON.parse(output).video_path).toMatch(/example\.mp4$/);
  });

  describe('load_keyframes', () => {
    it('skips the Pillow import entirely for a text-only run', () => {
      const output = lines(runPython(`${importShared}\n${[
        'print(shared.load_keyframes([]))',
        'print("PIL" in sys.modules)',
      ].join('\n')}`));
      expect(output[0]).toBe('[]');
      expect(output[1]).toBe('False');
    });

    it('names the missing conditioning image rather than surfacing a decode error', () => {
      const output = runPython(`${importShared}\n${[
        'try:',
        '    shared.load_keyframes(["/definitely/missing.png"])',
        'except RuntimeError as exc:',
        '    print(exc)',
      ].join('\n')}`);
      expect(output).toContain('Conditioning image is missing');
    });

    it('checks every path before decoding any of them', () => {
      // A bad second keyframe must not cost a decode of the first.
      const output = runPython(`${importShared}\n${[
        'try:',
        '    shared.load_keyframes(["/definitely/a.png", "/definitely/b.png"])',
        'except RuntimeError as exc:',
        '    print(exc)',
        'print("PIL" in sys.modules)',
      ].join('\n')}`);
      expect(output).toContain('/definitely/a.png');
      expect(output.trim().endsWith('False')).toBe(true);
    });
  });
});
