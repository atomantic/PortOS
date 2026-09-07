import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython, PY_TEST_TIMEOUT_MS, PY_SUBPROCESS_TIMEOUT_MS } from '../server/lib/testHelper.js';

const script = join(dirname(fileURLToPath(import.meta.url)), 'upscale_ltx25.py');

// Probe for an interpreter that actually RUNS rather than assuming a name — on
// Windows a bare `python` can be a Store alias STUB that exists and exits
// non-zero. Null when there is genuinely none, so the suite skips. Everything
// exercised here is import-free by design (stdlib only): the whole point of
// #6512's contract is that the argument and capability gates are testable on a
// machine with no MLX wheel, no 68 GB model pack, and no gated adapter.
const pyBin = resolveTestPython();
const runPython = (source) => execFileSync(pyBin, ['-c', source, script], {
  encoding: 'utf8',
  // Below the per-test budget on purpose, so a hung interpreter fails with the
  // spawn's own ETIMEDOUT naming the command rather than a bare vitest timeout.
  timeout: PY_SUBPROCESS_TIMEOUT_MS,
});

const importRunner = [
  'import importlib.util, sys',
  'from pathlib import Path',
  'script = Path(sys.argv[1])',
  'spec = importlib.util.spec_from_file_location("upscale_ltx25", script)',
  'runner = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(runner)',
].join('\n');

// Python on Windows writes CRLF, so a trailing carriage return would otherwise
// ride along on every comparison below.
const trimmed = (output) => output.trim().split('\n').map((line) => line.trimEnd()).join('\n');

// A scratch tree the fixtures live in — never a path from the developer's
// install, and never inside the repo.
const scratch = mkdtempSync(join(tmpdir(), 'portos-upscale-runner-'));
const REFERENCE = join(scratch, 'source.mp4');
const ADAPTER = join(scratch, 'adapter.safetensors');
writeFileSync(REFERENCE, 'not really a video');

// A real safetensors file: 8-byte little-endian header length, then the JSON
// header. Written rather than mocked because the header parse IS the thing
// under test — the runner reads `reference_downscale_factor` off this exact
// layout, which is how the gated weight's factor gets MEASURED instead of
// guessed (the registry entry deliberately holds null).
const writeSafetensors = (path, header) => {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(json.length));
  writeFileSync(path, Buffer.concat([len, json]));
};
writeSafetensors(ADAPTER, { __metadata__: { reference_downscale_factor: '2' } });

// Drive validate_args through a real argparse Namespace so the test exercises
// the object main() builds, not a hand-rolled stand-in free to omit a field.
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

const call = (expression) => trimmed(runPython(`${importRunner}\n${[
  'try:',
  `    print(${expression})`,
  'except SystemExit as exc:',
  '    print(f"REJECTED:{exc}")',
].join('\n')}`));

describe.skipIf(!pyBin)('upscale_ltx25.py — argument contract (#6512)', () => {
  it('accepts the argv renderArgs.buildLtxUpscaleArgs emits', () => {
    expect(validate()).toBe('OK');
  }, PY_TEST_TIMEOUT_MS);

  // The grid is `LTX_GRID` in upscalePlan.js, and it was read off the pinned
  // runtime rather than the gated card: Stage 1 renders at half the output and
  // the video VAE compresses spatially by 32, so the OUTPUT axis must divide by
  // 64. A source that "nearly" fits must be refused here, not silently resized.
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

  it('refuses an unmeasured frame rate rather than defaulting one', () => {
    expect(validate({ fps: 0 })).toMatch(/^REJECTED:.*--fps must be positive/);
  }, PY_TEST_TIMEOUT_MS);

  // The bounds are the weight registry's contract, carried across languages as
  // flags. A wrong reference count renders plausible-looking garbage rather
  // than erroring, so the helper enforces them even for a direct caller.
  it('refuses a reference count outside the weight registry bounds', () => {
    expect(validate({ ic_reference: [] })).toMatch(/^REJECTED:.*exactly 1 --ic-reference/);
    expect(validate({ ic_reference: [REFERENCE, REFERENCE] })).toMatch(/^REJECTED:.*exactly 1 --ic-reference/);
  }, PY_TEST_TIMEOUT_MS);

  it('refuses inverted or sub-1 bounds instead of silently clamping them', () => {
    expect(validate({ ic_min_references: 2 })).toMatch(/^REJECTED:.*1 <= min <= max/);
    expect(validate({ ic_min_references: 0, ic_max_references: 0 })).toMatch(/^REJECTED:.*1 <= min <= max/);
  }, PY_TEST_TIMEOUT_MS);

  it('refuses a reference clip that is not on disk', () => {
    expect(validate({ ic_reference: [join(scratch, 'missing.mp4')] })).toMatch(/^REJECTED:.*does not exist/);
  }, PY_TEST_TIMEOUT_MS);

  // The pipeline's own `_resolve_lora_path` turns anything it cannot stat into a
  // `snapshot_download` — for this gated adapter a 401 deep inside a render, and
  // for any repo a pull PortOS never announced. The download surface owns fetching.
  it('refuses a repo id in place of a downloaded adapter file', () => {
    expect(validate({ ic_lora_path: 'Lightricks/LTX-2.5-22b-IC-LoRA-Pixel-Spatial-Upscaler' }))
      .toMatch(/^REJECTED:.*download it from the Video Gen model panel/);
  }, PY_TEST_TIMEOUT_MS);
});

describe.skipIf(!pyBin)('upscale_ltx25.py — capability gate (#6512)', () => {
  // MLX has no non-Metal backend, so reaching this runner off Apple Silicon is a
  // routing bug. It must name the reason the queue can show, not die on an
  // import traceback minutes later.
  it.each([
    ['an Intel Mac', 'Darwin', 'x86_64'],
    ['a Linux host', 'Linux', 'x86_64'],
    ['Windows', 'Windows', 'AMD64'],
  ])('refuses %s with an actionable message', (_label, system, machine) => {
    expect(call(`runner.validate_host(${JSON.stringify(system)}, ${JSON.stringify(machine)}) or "OK"`))
      .toMatch(/^REJECTED:.*Apple Silicon/);
  }, PY_TEST_TIMEOUT_MS);

  it('accepts Apple Silicon', () => {
    expect(call('runner.validate_host("Darwin", "arm64") or "OK"')).toBe('OK');
  }, PY_TEST_TIMEOUT_MS);

  // Without `text_encoder/` the pipeline silently falls back to the remote
  // LTX-2.3 Gemma 3 id — the wrong conditioner for these weights AND an
  // unannounced multi-GB download. That fallback is why this is a refusal.
  it('refuses a model pack missing its own text encoder', () => {
    const pack = mkdtempSync(join(tmpdir(), 'portos-ltx25-pack-'));
    expect(call(`runner.validate_model_dir(${JSON.stringify(pack)})`))
      .toMatch(/^REJECTED:.*text_encoder\/config\.json/);
  }, PY_TEST_TIMEOUT_MS);

  it('refuses a model directory that does not exist', () => {
    expect(call(`runner.validate_model_dir(${JSON.stringify(join(scratch, 'no-such-pack'))})`))
      .toMatch(/^REJECTED:.*not cached/);
  }, PY_TEST_TIMEOUT_MS);
});

describe.skipIf(!pyBin)('upscale_ltx25.py — adapter metadata (#6512)', () => {
  // The registry holds `null` for this gated weight because nobody in the repo
  // can open it. The runner reads the real value off the file the user
  // downloaded, which is the whole "read, not guessed" contract.
  it('reads reference_downscale_factor off the weight, defaulting to 1 when absent', () => {
    const plain = join(scratch, 'plain.safetensors');
    writeSafetensors(plain, { 'transformer_blocks.0.attn1.to_q.lora_A.weight': {} });
    expect(call(`runner.reference_downscale_factor(runner.read_safetensors_header(${JSON.stringify(ADAPTER)}))`)).toBe('2');
    expect(call(`runner.reference_downscale_factor(runner.read_safetensors_header(${JSON.stringify(plain)}))`)).toBe('1');
    // An unreadable header is not a measurement of 1 either — but the caller
    // refuses on the None, so the factor helper stays total.
    expect(call('runner.reference_downscale_factor(None)')).toBe('1');
  }, PY_TEST_TIMEOUT_MS);

  it('returns None for a file that is not safetensors rather than raising', () => {
    expect(call(`repr(runner.read_safetensors_header(${JSON.stringify(REFERENCE)}))`)).toBe('None');
    expect(call(`repr(runner.read_safetensors_header(${JSON.stringify(join(scratch, 'nope.safetensors'))}))`)).toBe('None');
  }, PY_TEST_TIMEOUT_MS);

  // The conditioned stage renders AT the output, so the reference is
  // `output / factor` — and it has to land on the VAE's 32-pixel grid at the
  // source's own size, or the source is resampled before it conditions
  // anything. A factor of 2 therefore demands an output divisible by 64, and a
  // factor of 4 by 128. The message speaks in output terms because that is
  // what the user chose.
  it('enforces the adapter factor against the output the conditioned stage renders at', () => {
    expect(call('runner.assert_reference_scale_fits(2, 1728, 1024) or "OK"')).toBe('OK');
    expect(call('runner.assert_reference_scale_fits(1, 100, 100) or "OK"')).toBe('OK');
    expect(call('runner.assert_reference_scale_fits(2, 1056, 1024) or "OK"'))
      .toMatch(/^REJECTED:.*divisible by 64/);
    expect(call('runner.assert_reference_scale_fits(4, 1088, 1024) or "OK"'))
      .toMatch(/^REJECTED:.*divisible by 128/);
  }, PY_TEST_TIMEOUT_MS);

  // Both pipelines render their IC-conditioned stage at HALF the dims they are
  // handed. The recipe is single-stage at the output with the source at half,
  // so the runner asks for twice the output and skips stage 2 — a runner that
  // passed the output through would condition on a further-downscaled source.
  it('requests twice the output so the conditioned stage renders at the output size', () => {
    expect(call('runner.conditioned_stage_request(1024, 576)')).toBe('(2048, 1152)');
  }, PY_TEST_TIMEOUT_MS);

  // `apply_loras` pairs lora_A with lora_B per weight and skips a prefix missing
  // either half — so a half-pair contributes nothing and must not be counted as
  // coverage, or the no-op guard would pass on an adapter that fuses nothing.
  it('counts only complete lora_A/lora_B pairs as fusable targets', () => {
    const names = JSON.stringify([
      'transformer_blocks.0.attn1.to_q.lora_A.weight',
      'transformer_blocks.0.attn1.to_q.lora_B.weight',
      'transformer_blocks.1.ff.proj_in.lora_A.weight',
    ]);
    expect(call(`sorted(runner.lora_target_keys(${names}))`))
      .toBe("['transformer_blocks.0.attn1.to_q.weight']");
    expect(call('sorted(runner.lora_target_keys([]))')).toBe('[]');
  }, PY_TEST_TIMEOUT_MS);

  // The failure #6512 names: an adapter whose keys address nothing fuses no
  // deltas, raises nothing, and renders the plain base model dressed as an
  // upscale. Only the header is read, so the guard costs no tensor I/O.
  it('refuses an adapter that would fuse into nothing, and reports coverage when it would', () => {
    const foreign = join(scratch, 'foreign.safetensors');
    writeSafetensors(foreign, {
      'some.other.model.layer.lora_A.weight': {},
      'some.other.model.layer.lora_B.weight': {},
    });
    const modelKeys = JSON.stringify(['transformer_blocks.0.attn1.to_q.weight']);
    // `rename` is the runtime's own SDOps map in production; identity here keeps
    // the test off the MLX wheel while exercising the same intersection.
    expect(call(`runner.assert_adapter_fuses(${JSON.stringify(foreign)}, ${modelKeys}, lambda name: name)`))
      .toMatch(/^REJECTED:.*do not address any weight/);

    const matching = join(scratch, 'matching.safetensors');
    writeSafetensors(matching, {
      'transformer_blocks.0.attn1.to_q.lora_A.weight': {},
      'transformer_blocks.0.attn1.to_q.lora_B.weight': {},
    });
    expect(call(`runner.assert_adapter_fuses(${JSON.stringify(matching)}, ${modelKeys}, lambda name: name)`)).toBe('1');
  }, PY_TEST_TIMEOUT_MS);

  // An unreadable transformer means the guard cannot answer its own question.
  // Reporting "fuses into nothing" would blame the adapter; reporting success
  // would defeat the guard — so it refuses on its own blindness instead.
  it('refuses when the transformer weight names could not be read at all', () => {
    const matching = join(scratch, 'matching.safetensors');
    expect(call(`runner.assert_adapter_fuses(${JSON.stringify(matching)}, set(), lambda name: name)`))
      .toMatch(/^REJECTED:.*Could not read the LTX-2\.5 transformer/);
  }, PY_TEST_TIMEOUT_MS);
});

// The guard reads the model's parameter names off the DiT header rather than
// loading it, because `ICLoraPipeline.generate` loads Gemma, encodes, frees it
// and only THEN loads the transformer — a pre-load to inspect parameters would
// hold a multi-GB DiT resident through prompt encoding.
describe.skipIf(!pyBin)('upscale_ltx25.py — transformer header (#6512)', () => {
  it('strips the transformer. prefix load_split_safetensors strips, and keeps only weights', () => {
    const dit = join(scratch, 'transformer.safetensors');
    writeSafetensors(dit, {
      'transformer.transformer_blocks.0.attn1.to_q.weight': {},
      // A quantized pack's siblings ride along with their weight rather than
      // being fused into, so they are not fusable targets.
      'transformer.transformer_blocks.0.attn1.to_q.scales': {},
      'transformer.transformer_blocks.0.attn1.to_q.biases': {},
      // Not under the prefix — load_split_safetensors drops it outright.
      'vae.encoder.conv_in.weight': {},
    });
    expect(call(`sorted(runner.transformer_weight_keys(__import__("pathlib").Path(${JSON.stringify(dit)})))`))
      .toBe("['transformer_blocks.0.attn1.to_q.weight']");
  }, PY_TEST_TIMEOUT_MS);

  it('returns an empty set for an unreadable file rather than raising', () => {
    expect(call(`runner.transformer_weight_keys(__import__("pathlib").Path(${JSON.stringify(REFERENCE)}))`))
      .toBe('set()');
  }, PY_TEST_TIMEOUT_MS);

  // Mirrors BasePipeline._resolve_safetensors: plain name wins, else the
  // lexicographically last versioned file, else None so the caller can say so.
  it('resolves the same transformer file the pipeline would', () => {
    const pack = mkdtempSync(join(tmpdir(), 'portos-ltx25-dit-'));
    const resolve = (dir) => call(`repr(runner.resolve_transformer_path(__import__("pathlib").Path(${JSON.stringify(dir)})) and runner.resolve_transformer_path(__import__("pathlib").Path(${JSON.stringify(dir)})).name)`);
    expect(resolve(pack)).toBe('None');

    writeFileSync(join(pack, 'transformer-distilled-1.0.safetensors'), '');
    writeFileSync(join(pack, 'transformer-distilled-1.1.safetensors'), '');
    expect(resolve(pack)).toBe("'transformer-distilled-1.1.safetensors'");

    writeFileSync(join(pack, 'transformer.safetensors'), '');
    expect(resolve(pack)).toBe("'transformer.safetensors'");
  }, PY_TEST_TIMEOUT_MS);

  // The pinned q8 pack documents two layouts for the distilled model: the
  // pre-fused file, or the dev transformer plus the 450-step distilled LoRA.
  // The pipeline's own loader knows only the first, so the runner resolves the
  // layout itself — and refuses dev WITHOUT the LoRA, because the distilled
  // schedule on an un-distilled model is not a fallback, it is a wrong render.
  it('resolves the dev + distilled-LoRA layout, preferring a pre-fused distilled file', () => {
    const pack = mkdtempSync(join(tmpdir(), 'portos-ltx25-layout-'));
    const layout = (dir) => call(`(lambda t, loras: [t.name, [(__import__("pathlib").Path(p).name, s) for p, s in loras]])(*runner.resolve_transformer_layout(__import__("pathlib").Path(${JSON.stringify(dir)})))`);
    expect(layout(pack)).toMatch(/^REJECTED:.*no transformer weight file/);

    writeFileSync(join(pack, 'transformer-dev.safetensors'), '');
    expect(layout(pack)).toMatch(/^REJECTED:.*carries only transformer-dev\.safetensors/);

    writeFileSync(join(pack, 'ltx-2.5-22b-distilled-lora-450.safetensors'), '');
    expect(layout(pack)).toBe("['transformer-dev.safetensors', [('ltx-2.5-22b-distilled-lora-450.safetensors', 1.0)]]");

    writeFileSync(join(pack, 'transformer-distilled.safetensors'), '');
    expect(layout(pack)).toBe("['transformer-distilled.safetensors', []]");
  }, PY_TEST_TIMEOUT_MS);

  // `ICLoraPipeline.load()` resolves the transformer only while `dit` is None,
  // so steering a dev-layout pack means loading the resolved file first and
  // letting the base `load()` skip its own resolution. Exercised against a
  // stand-in base class so the contract is pinned without the MLX wheel.
  it('loads the resolved transformer before the base pipeline resolves its own', () => {
    const source = [
      'class FakeBase:',
      '    def __init__(self, model_dir, lora_paths=None):',
      '        self.model_dir = model_dir; self.lora_paths = lora_paths; self.dit = None; self.upsampler = None; self._loaded = False; self.calls = []',
      '    def _load_transformer_with_optional_streaming(self, path):',
      '        self.calls.append(path.name); return "dit"',
      '    def load(self):',
      '        self.calls.append("base-load:" + str(self.dit)); self._loaded = True',
      'from pathlib import Path',
      'pipe = runner.make_pipeline(FakeBase, Path("/pack"), Path("/pack/transformer-dev.safetensors"), [("adapter", 1.0), ("distilled", 1.0)])',
      'pipe.load(); pipe.load()',
      // The latent upsampler slot is pre-seeded so the base load() skips the
      // ~1 GB stage-2 weight a skip_stage_2 render never touches.
      'print(pipe.calls, pipe.lora_paths, pipe.model_dir, pipe.upsampler is not None)',
    ].join('\n');
    expect(trimmed(runPython(`${importRunner}\n${source}`)))
      .toBe("['transformer-dev.safetensors', 'base-load:dit', 'base-load:dit'] [('adapter', 1.0), ('distilled', 1.0)] /pack True");
  }, PY_TEST_TIMEOUT_MS);
});
