import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython, PY_TEST_TIMEOUT_MS, PY_SUBPROCESS_TIMEOUT_MS } from '../server/lib/testHelper.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const script = join(scriptDir, 'upscale_ltx25_cuda.py');

// Everything exercised here is import-free by design (stdlib only): #6513's
// acceptance requires the argument and capability gates to be testable on a
// machine with no CUDA card, no torch wheel, no ~68 GB pack and no gated
// adapter — which is every CI runner and every Mac.
const pyBin = resolveTestPython();
const runPython = (source, ...argv) => execFileSync(pyBin, ['-c', source, script, ...argv], {
  encoding: 'utf8',
  // Below the per-test budget on purpose, so a hung interpreter fails with the
  // spawn's own ETIMEDOUT naming the command rather than a bare vitest timeout.
  timeout: PY_SUBPROCESS_TIMEOUT_MS,
});

const importRunner = [
  'import importlib.util, sys',
  'from pathlib import Path',
  'script = Path(sys.argv[1])',
  'sys.path.insert(0, str(script.parent))',
  'spec = importlib.util.spec_from_file_location("upscale_ltx25_cuda", script)',
  'runner = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(runner)',
].join('\n');

// Python on Windows writes CRLF, so a trailing carriage return would otherwise
// ride along on every comparison below.
const trimmed = (output) => output.trim().split('\n').map((line) => line.trimEnd()).join('\n');

const call = (expression, ...argv) => trimmed(runPython(`${importRunner}\n${[
  'try:',
  `    print(${expression})`,
  'except SystemExit as exc:',
  '    print(f"REJECTED:{exc}")',
].join('\n')}`, ...argv));

// A scratch tree the fixtures live in — never a path from the developer's
// install, and never inside the repo.
const scratch = mkdtempSync(join(tmpdir(), 'portos-upscale-cuda-'));
const REFERENCE = join(scratch, 'source.mp4');
const ADAPTER = join(scratch, 'adapter.safetensors');
writeFileSync(REFERENCE, 'not really a video');

// A real safetensors file: 8-byte little-endian header length, then the JSON
// header. Written rather than mocked because the header parse IS the thing
// under test — the runner reads both the declared downscale factor and every
// delta SHAPE off this exact layout.
const writeSafetensors = (path, header) => {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(json.length));
  writeFileSync(path, Buffer.concat([len, json]));
};
const loraPair = (prefix, out, inn, rank) => ({
  [`${prefix}.lora_A.weight`]: { shape: [rank, inn] },
  [`${prefix}.lora_B.weight`]: { shape: [out, rank] },
});
writeSafetensors(ADAPTER, { __metadata__: { reference_downscale_factor: '2' } });

// The pinned split checkpoint's file list, from the runner's own MODEL_FILES —
// scraped rather than restated so a pack layout change cannot leave this suite
// building a "complete" snapshot the runner would reject.
const MODEL_FILES = JSON.parse(call('__import__("json").dumps(runner.MODEL_FILES)'));
const writePack = (files = Object.values(MODEL_FILES)) => {
  const pack = mkdtempSync(join(tmpdir(), 'portos-ltx25-cuda-pack-'));
  for (const relative of files) {
    const target = join(pack, ...relative.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '');
  }
  return pack;
};

const ARG_DEFAULTS = {
  width: 1728,
  height: 1024,
  num_frames: 121,
  fps: 24,
  seed: 4242,
  ic_min_references: 1,
  ic_max_references: 1,
};
const validate = (overrides = {}) => {
  const fields = { ...ARG_DEFAULTS, ...overrides };
  const references = Object.hasOwn(overrides, 'ic_reference') ? overrides.ic_reference : [REFERENCE];
  const loraPath = Object.hasOwn(overrides, 'ic_lora_path') ? overrides.ic_lora_path : ADAPTER;
  return trimmed(runPython(`${importRunner}\n${[
    'import argparse, json',
    `args = argparse.Namespace(**json.loads(${JSON.stringify(JSON.stringify(fields))}))`,
    `args.ic_reference = json.loads(${JSON.stringify(JSON.stringify(references))})`,
    `args.ic_lora_path = json.loads(${JSON.stringify(JSON.stringify(loraPath))})`,
    'try:',
    '    runner.validate_args(args)',
    '    print("OK")',
    'except SystemExit as exc:',
    '    print(f"REJECTED:{exc}")',
  ].join('\n')}`));
};

// The flag set a runner declares, read off a real parser rather than its source.
const flagsOf = (moduleFile) => trimmed(runPython([
  'import importlib.util, sys, argparse',
  'from pathlib import Path',
  'script = Path(sys.argv[1]).parent / sys.argv[2]',
  'sys.path.insert(0, str(script.parent))',
  'spec = importlib.util.spec_from_file_location(script.stem, script)',
  'mod = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(mod)',
  'parser = argparse.ArgumentParser()',
  'mod.add_upscale_arguments(parser, model_help="x")',
  'print(" ".join(sorted(o for a in parser._actions for o in a.option_strings)))',
].join('\n'), moduleFile));

// #6511 emits ONE argv for both backends and only swaps the interpreter and the
// script path, so the two parsers agreeing IS the contract — not a stylistic
// preference. Compared as data rather than trusted to the shared helper they
// both happen to call today, because a runner stays free to add a flag.
describe.skipIf(!pyBin)('upscale_ltx25_cuda.py — one argv for both backends (#6513)', () => {
  it('declares exactly the flags the MLX runner declares', () => {
    const cuda = flagsOf('upscale_ltx25_cuda.py');
    expect(cuda).toBe(flagsOf('upscale_ltx25.py'));
    expect(cuda.split(' ')).toEqual([
      '--fps', '--height', '--help', '--ic-lora-path', '--ic-max-references',
      '--ic-min-references', '--ic-reference', '--model', '--num-frames', '--output',
      '--prompt', '--seed', '--width', '-h',
    ]);
  }, PY_TEST_TIMEOUT_MS);

  // The distilled schedule is fixed at 8 sigmas on both runtimes, so there
  // is nothing for a steps flag to select; and the pass carries no prompt,
  // because the source clip is the whole conditioning signal.
  it('exposes no steps flag and defaults the prompt to empty', () => {
    expect(flagsOf('upscale_ltx25_cuda.py')).not.toContain('--steps');
    expect(call(
      'repr(runner.parse_args(["--model","m","--ic-lora-path","l","--ic-reference","r",'
      + '"--ic-min-references","1","--ic-max-references","1","--width","64","--height","64",'
      + '"--num-frames","9","--fps","24","--seed","0","--output","o"]).prompt)',
    )).toBe("''");
  }, PY_TEST_TIMEOUT_MS);
});

describe.skipIf(!pyBin)('upscale_ltx25_cuda.py — argument contract (#6513)', () => {
  it('accepts the argv renderArgs.buildLtxUpscaleArgs emits', () => {
    expect(validate()).toBe('OK');
  }, PY_TEST_TIMEOUT_MS);

  // `validate_args` in generate_ltx25_cuda.py already enforced this grid and
  // #6512 confirmed MLX imposes the same one, so a source that "nearly" fits
  // must be refused here rather than silently resized to fit.
  it.each([
    ['a width off the 64 grid', { width: 1700 }],
    ['a height off the 64 grid', { height: 1000 }],
  ])('refuses %s', (_label, overrides) => {
    expect(validate(overrides)).toMatch(/^REJECTED:.*divisible by 64/);
  }, PY_TEST_TIMEOUT_MS);

  it.each([
    ['a frame count off the 8n+1 grid', { num_frames: 120 }],
    ['a frame count under the floor', { num_frames: 5 }],
  ])('refuses %s', (_label, overrides) => {
    expect(validate(overrides)).toMatch(/^REJECTED:.*frames % 8 == 1/);
  }, PY_TEST_TIMEOUT_MS);

  it('refuses a reference count outside the weight registry bounds', () => {
    expect(validate({ ic_reference: [] })).toMatch(/^REJECTED:.*exactly 1 --ic-reference/);
    expect(validate({ ic_reference: [REFERENCE, REFERENCE] })).toMatch(/^REJECTED:.*exactly 1 --ic-reference/);
  }, PY_TEST_TIMEOUT_MS);

  it('refuses a repo id in place of a downloaded adapter file', () => {
    expect(validate({ ic_lora_path: 'Lightricks/LTX-2.5-22b-IC-LoRA-Pixel-Spatial-Upscaler' }))
      .toMatch(/^REJECTED:.*download it from the Video Gen model panel/);
  }, PY_TEST_TIMEOUT_MS);
});

describe.skipIf(!pyBin)('upscale_ltx25_cuda.py — capability gate (#6513)', () => {
  // A CPU-only torch installs cleanly on Windows and hides the setup banner, so
  // "no visible device" has to name itself rather than surface as an allocator
  // traceback minutes into a render.
  it('refuses a host with no visible CUDA device', () => {
    expect(call('runner.validate_device(False, None, None) or "OK"'))
      .toMatch(/^REJECTED:.*needs a visible NVIDIA device/);
  }, PY_TEST_TIMEOUT_MS);

  // An upscale renders at twice the source's linear dimensions, so it sits
  // above a plain render's peak — a card that can generate cannot necessarily
  // upscale, and finding that out 40 minutes in is the failure being prevented.
  it('refuses a card below the supported VRAM floor, naming what it measured', () => {
    expect(call('runner.validate_device(True, "GeForce RTX 4060 Ti", 16 * 1000 ** 3) or "OK"'))
      .toMatch(/^REJECTED:GeForce RTX 4060 Ti reports 16\.0 GB of VRAM.*at least 23 GB/);
  }, PY_TEST_TIMEOUT_MS);

  it('accepts a 24 GB card after the slice its driver reserves', () => {
    expect(call('runner.validate_device(True, "GeForce RTX 4090", 25_393_692_672) or "OK"')).toBe('OK');
  }, PY_TEST_TIMEOUT_MS);

  // Unknown is not insufficient: a driver that reports no capacity must not be
  // refused on a number the runner invented for it.
  it('accepts a device whose capacity the driver does not report', () => {
    expect(call('runner.validate_device(True, "Unknown Device", None) or "OK"')).toBe('OK');
  }, PY_TEST_TIMEOUT_MS);
});

describe.skipIf(!pyBin)('upscale_ltx25_cuda.py — pinned snapshot (#6513)', () => {
  // The runner must never resolve its own weights: every LTX loader falls back
  // to a remote fetch for a path it cannot stat, which for this pack is an
  // unannounced ~68 GB pull inside a render.
  it('refuses a snapshot directory that does not exist', () => {
    expect(call(`runner.validate_model_dir(${JSON.stringify(join(scratch, 'no-such-pack'))})`))
      .toMatch(/^REJECTED:.*not cached/);
  }, PY_TEST_TIMEOUT_MS);

  it('refuses a snapshot missing a pinned file, naming the file', () => {
    const partial = writePack(Object.values(MODEL_FILES).filter((f) => f !== MODEL_FILES.upsampler));
    expect(call(`runner.validate_model_dir(${JSON.stringify(partial)})`))
      .toMatch(new RegExp(`^REJECTED:.*incomplete: ${MODEL_FILES.upsampler.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }, PY_TEST_TIMEOUT_MS);

  it('resolves every pinned file to an absolute path when the snapshot is complete', () => {
    const pack = writePack();
    expect(call(`sorted(runner.validate_model_dir(${JSON.stringify(pack)}))`))
      .toBe(`[${Object.keys(MODEL_FILES).sort().map((k) => `'${k}'`).join(', ')}]`);
  }, PY_TEST_TIMEOUT_MS);
});

describe.skipIf(!pyBin)('upscale_ltx25_cuda.py — adapter fusion guard (#6513)', () => {
  // The model side requires the raw `model.diffusion_model.` prefix
  // (LTXV_MODEL_COMFY_RENAMING_MAP) and strips it; the LoRA side strips a bare
  // `diffusion_model.`. Both maps are the runtime's own in production — stubbed
  // here so the intersection is exercised without a torch wheel.
  const MODEL_RENAME = 'lambda k: k[len("model.diffusion_model."):] if k.startswith("model.diffusion_model.") else None';
  const LORA_RENAME = 'lambda k: k.replace("diffusion_model.", "")';

  const writeDit = (header) => {
    const dit = join(scratch, `dit-${Math.random().toString(36).slice(2)}.safetensors`);
    writeSafetensors(dit, header);
    return dit;
  };

  it('keeps only prefixed .weight keys, with their shapes', () => {
    const dit = writeDit({
      'model.diffusion_model.transformer_blocks.0.attn1.to_q.weight': { shape: [4096, 4096] },
      // A prequant sibling is folded into its parent at load time, never fused into.
      'model.diffusion_model.transformer_blocks.0.attn1.to_q.weight_scale': { shape: [] },
      // Not under the raw prefix — the rename map rejects it outright.
      'vae.encoder.conv_in.weight': { shape: [8, 8] },
    });
    expect(call(`sorted(runner.transformer_weight_shapes(${JSON.stringify(dit)}, ${MODEL_RENAME}).items())`))
      .toBe("[('transformer_blocks.0.attn1.to_q.weight', (4096, 4096))]");
  }, PY_TEST_TIMEOUT_MS);

  it('returns an empty map for an unreadable file rather than raising', () => {
    expect(call(`runner.transformer_weight_shapes(${JSON.stringify(REFERENCE)}, ${MODEL_RENAME})`)).toBe('{}');
  }, PY_TEST_TIMEOUT_MS);

  // The failure #6513 names: `apply_loras` skips a weight the model lacks and
  // `load_state_dict(strict=False)` swallows the rest, so an adapter that
  // addresses nothing raises nothing and renders the plain base model.
  it('refuses an adapter that would fuse into nothing, and reports coverage when it would', () => {
    const modelShapes = "{'transformer_blocks.0.attn1.to_q.weight': (4096, 4096)}";

    const foreign = join(scratch, 'foreign.safetensors');
    writeSafetensors(foreign, loraPair('diffusion_model.some.other.model.layer', 4096, 4096, 16));
    expect(call(`runner.assert_adapter_fuses(${JSON.stringify(foreign)}, ${modelShapes}, ${LORA_RENAME})`))
      .toMatch(/^REJECTED:.*do not address any weight/);

    const matching = join(scratch, 'matching.safetensors');
    writeSafetensors(matching, loraPair('diffusion_model.transformer_blocks.0.attn1.to_q', 4096, 4096, 16));
    expect(call(`runner.assert_adapter_fuses(${JSON.stringify(matching)}, ${modelShapes}, ${LORA_RENAME})`)).toBe('1');
  }, PY_TEST_TIMEOUT_MS);

  // "No exception" is not evidence on this runtime either, so the guard checks
  // the delta numerically: an adapter trained against a different-width
  // checkpoint matches by NAME and would corrupt the weight it addresses.
  it('refuses a matching key whose B@A product is the wrong shape', () => {
    const wrongWidth = join(scratch, 'wrong-width.safetensors');
    writeSafetensors(wrongWidth, loraPair('diffusion_model.transformer_blocks.0.attn1.to_q', 2048, 4096, 16));
    expect(call(`runner.assert_adapter_fuses(${JSON.stringify(wrongWidth)}, `
      + `{'transformer_blocks.0.attn1.to_q.weight': (4096, 4096)}, ${LORA_RENAME})`))
      .toMatch(/^REJECTED:.*do not match the shape.*adapter 2048x4096, model \(4096, 4096\)/);
  }, PY_TEST_TIMEOUT_MS);

  // A half-pair contributes nothing on this runtime too (`_products_for_sd_key`
  // skips a prefix missing either half), so it must not count as coverage — or
  // the no-op guard would pass on an adapter that fuses nothing.
  it('does not count a lora_A without its lora_B as coverage', () => {
    const halfPair = join(scratch, 'half-pair.safetensors');
    writeSafetensors(halfPair, {
      'diffusion_model.transformer_blocks.0.attn1.to_q.lora_A.weight': { shape: [16, 4096] },
    });
    expect(call(`runner.assert_adapter_fuses(${JSON.stringify(halfPair)}, `
      + `{'transformer_blocks.0.attn1.to_q.weight': (4096, 4096)}, ${LORA_RENAME})`))
      .toMatch(/^REJECTED:.*do not address any weight/);
  }, PY_TEST_TIMEOUT_MS);

  // An unreadable transformer means the guard cannot answer its own question.
  // Reporting "fuses into nothing" would blame the adapter; reporting success
  // would defeat the guard — so it refuses on its own blindness instead.
  it('refuses when the transformer weight names could not be read at all', () => {
    const matching = join(scratch, 'matching.safetensors');
    expect(call(`runner.assert_adapter_fuses(${JSON.stringify(matching)}, {}, ${LORA_RENAME})`))
      .toMatch(/^REJECTED:.*Could not read the LTX-2\.5 transformer/);
  }, PY_TEST_TIMEOUT_MS);

  it('refuses an adapter file that is not safetensors at all', () => {
    expect(call(`runner.assert_adapter_fuses(${JSON.stringify(REFERENCE)}, `
      + `{'a.weight': (1, 1)}, ${LORA_RENAME})`))
      .toMatch(/^REJECTED:.*Could not read the adapter/);
  }, PY_TEST_TIMEOUT_MS);
});

// The adapter's declared factor applies to the output the conditioned stage
// renders at, and the reference must land on the VAE's 32-pixel grid at the
// source's own size — so a factor of N demands an output divisible by N × 32.
// Shared with the MLX runner, exercised here because this runner is the one
// that would commit a CUDA render to it.
describe.skipIf(!pyBin)('upscale_ltx25_cuda.py — reference downscale factor (#6513)', () => {
  it('reads the factor off the weight and enforces it against the output the conditioned stage renders at', () => {
    expect(call(`runner.reference_downscale_factor(runner.read_safetensors_header(${JSON.stringify(ADAPTER)}))`))
      .toBe('2');
    expect(call('runner.assert_reference_scale_fits(2, 1728, 1024) or "OK"')).toBe('OK');
    expect(call('runner.assert_reference_scale_fits(4, 1088, 1024) or "OK"'))
      .toMatch(/^REJECTED:.*divisible by 128/);
  }, PY_TEST_TIMEOUT_MS);

  // Same recipe as MLX: upstream's `ICLoraPipeline` renders stage 1 at half
  // the dims it is handed, so the runner requests twice the output and skips
  // stage 2. Shared through the contract module so the two cannot drift.
  it('requests twice the output through the shared contract', () => {
    expect(call('runner.conditioned_stage_request(1024, 576)')).toBe('(2048, 1152)');
  }, PY_TEST_TIMEOUT_MS);
});
