import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const script = join(dirname(fileURLToPath(import.meta.url)), 'generate_minimax_h3_cuda.py');

// Probe for an interpreter that actually RUNS rather than assuming a name. On
// Windows a box with no Store-installed Python still has `python` on PATH as an
// alias STUB: it exists, exits non-zero, and prints "Python was not found", so a
// name-only choice passes here and then every case dies with an opaque "Command
// failed". Null when there is genuinely none, so the suite skips.
const pyBin = resolveTestPython();
const runPython = (source) => execFileSync(pyBin, ['-c', source, script], {
  encoding: 'utf8',
});

// Python on Windows writes CRLF, so splitting the output on newlines alone
// leaves a trailing carriage return on every line but the last — and each
// comparison below would then fail on that, not on anything the runner did.
const lines = (output) => output.trim().split('\n').map((line) => line.trimEnd());

// Import the runner as a module without executing main(). Every heavy import
// (torch, diffusers, PIL) is deferred inside the function that needs it, which
// is what makes this possible in a bare interpreter — the arg contract has to
// be testable without a 144 GB runtime installed.
const importRunner = [
  'import importlib.util, sys',
  'from pathlib import Path',
  'script = Path(sys.argv[1])',
  'spec = importlib.util.spec_from_file_location("generate_minimax_h3_cuda", script)',
  'runner = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(runner)',
].join('\n');

// Drive validate_args through a real argparse Namespace so the test exercises
// the same object main() builds, rather than a hand-rolled stand-in that could
// silently omit a field the validator reads.
const validate = (overrides) => {
  const fields = {
    fps: 24,
    width: 1344,
    height: 768,
    num_frames: 124,
    steps: 8,
    image: [],
    anchor: [],
    repo_file: ['modular_model_index.json'],
    ...overrides,
  };
  return runPython(`${importRunner}\n${[
    'import argparse, json',
    `args = argparse.Namespace(**json.loads(${JSON.stringify(JSON.stringify(fields))}))`,
    'try:',
    '    runner.validate_args(args)',
    '    print("OK")',
    'except SystemExit as exc:',
    '    print(f"REJECTED:{exc}")',
  ].join('\n')}`).trim();
};

describe.skipIf(!pyBin)('generate_minimax_h3_cuda.py', () => {
  it('accepts a legal request at both ends of the diffusers window', () => {
    expect(validate({})).toBe('OK');
    expect(validate({ num_frames: 345 })).toBe('OK');
  });

  it("enforces the diffusers 5-15s window, which is narrower than the MLX port's", () => {
    // 107 (4.46s) and 362 (15.08s) are both legal 17n+5 grid points that the
    // MLX runner accepts. diffusers snaps up to the grid and THEN requires the
    // resulting duration in 5-15s, so both are out of range here. This is the
    // one H3 constraint that genuinely differs between the two runners, which
    // is why the frame grid is a per-entry fact rather than a shared constant.
    expect(validate({ num_frames: 107 })).toMatch(/^REJECTED:.*5-15 seconds/);
    expect(validate({ num_frames: 362 })).toMatch(/^REJECTED:.*5-15 seconds/);
  });

  it('refuses to run without a pinned component file list', () => {
    // Without it the loaders would fall back to a repo-wide resolve against a
    // ~498 GB repo carrying three layouts — not a recoverable default.
    expect(validate({ repo_file: [] })).toMatch(/^REJECTED:.*--repo-file/);
  });

  it('maps anchors onto the diffusers keyframe input names, in packed order', () => {
    const output = lines(runPython(`${importRunner}\n${[
      'kwargs = runner.keyframe_kwargs(["FIRST", "LAST"], ["first", "last"])',
      'print(",".join(f"{k}={v}" for k, v in kwargs.items()))',
      'print(runner.keyframe_kwargs(["ONLY"], ["last"]))',
      'print(runner.keyframe_kwargs([], []))',
    ].join('\n')}`));
    expect(output[0]).toBe('image=FIRST,last_image=LAST');
    // A last-only request is legal in fl2va — "generate up to this frame".
    expect(output[1]).toBe("{'last_image': 'ONLY'}");
    expect(output[2]).toBe('{}');
  });

  it('sizes the offload recipe from VRAM, and honors an affordable pin', () => {
    const output = lines(runPython(`${importRunner}\n${[
      'import types',
      'fake = types.ModuleType("torch")',
      'fake.cuda = types.SimpleNamespace(',
      '    is_available=lambda: True,',
      '    get_device_properties=lambda i: types.SimpleNamespace(total_memory=int(TOTAL_GB * 1e9)),',
      ')',
      'sys.modules["torch"] = fake',
      'for TOTAL_GB in (80, 32, 24, 16, 12):',
      '    print(f"{TOTAL_GB}:{runner.resolve_offload_profile(\'auto\')[0]}")',
      'TOTAL_GB = 80',
      "print('pinned:' + runner.resolve_offload_profile('int8-lean')[0])",
    ].join('\n')}`));
    expect(output).toEqual([
      '80:bf16',
      '32:int8-stream',
      '24:int8-stream',
      '16:int8-lean',
      '12:int8-lean',
      // A pin the card can afford still wins over the heuristic: a user who
      // sets one knows their box better than a capacity table does, and a
      // leaner recipe on a big card is a legitimate choice.
      'pinned:int8-lean',
    ]);
  });

  // Both of these used to succeed and then die out of memory an hour into the
  // load — the leanest recipe was returned for any card, and a pin was returned
  // without ever being checked against the device (#5420).
  it('refuses a card below every recipe, and a pin the card cannot hold', () => {
    const output = lines(runPython(`${importRunner}\n${[
      'import types',
      'fake = types.ModuleType("torch")',
      'fake.cuda = types.SimpleNamespace(',
      '    is_available=lambda: True,',
      '    get_device_properties=lambda i: types.SimpleNamespace(total_memory=int(TOTAL_GB * 1e9)),',
      ')',
      'sys.modules["torch"] = fake',
      'for TOTAL_GB, requested in ((8, "auto"), (12, "bf16")):',
      '    try:',
      '        runner.resolve_offload_profile(requested)',
      '        print("ACCEPTED")',
      '    except RuntimeError as exc:',
      '        print(f"REFUSED:{exc}")',
    ].join('\n')}`));
    expect(output[0]).toMatch(/^REFUSED:.*at least 12 GB of VRAM/);
    // The message names the recipe this card CAN run, so the fix is obvious.
    expect(output[1]).toMatch(/^REFUSED:.*needs 60 GB of VRAM.*can run the int8-lean profile/);
  });

  it('refuses to run when no CUDA device is visible', () => {
    // A CPU-only torch wheel installs cleanly on Windows and would otherwise
    // just render unusably slowly instead of saying what is wrong.
    const output = runPython(`${importRunner}\n${[
      'import types',
      'fake = types.ModuleType("torch")',
      'fake.cuda = types.SimpleNamespace(is_available=lambda: False)',
      'sys.modules["torch"] = fake',
      'try:',
      "    runner.resolve_offload_profile('auto')",
      'except RuntimeError as exc:',
      '    print(exc)',
    ].join('\n')}`);
    expect(output).toContain('needs a visible NVIDIA device');
  });

});
