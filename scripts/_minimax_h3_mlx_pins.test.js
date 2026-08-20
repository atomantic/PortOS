import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

// The pin facts `generate_minimax_h3.py` patches against and
// `minimax_h3_runtime_probe.py` asserts at Install / Repair. They live in one
// module so those two cannot disagree about what the pin is; this suite covers
// the assertions themselves, and the last case covers the "one module" part.
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const script = join(scriptsDir, '_minimax_h3_mlx_pins.py');

// Probe for an interpreter that actually RUNS rather than assuming a name. On
// Windows a box with no Store-installed Python still has `python` on PATH as an
// alias STUB: it exists, exits non-zero, and prints "Python was not found", so a
// name-only choice passes here and then every case dies with an opaque "Command
// failed". Null when there is genuinely none, so the suite skips.
const pyBin = resolveTestPython();
const runPython = (source) => execFileSync(pyBin, ['-c', source, script], {
  encoding: 'utf8',
});

// Load the module by path — it is stdlib-only at import time, which is what lets
// a bare interpreter here import it without the MLX venv or a registered source
// namespace behind it.
//
// `build_pin` writes a stand-in pinned encoder to a REAL file: the encode guard
// reads its body back with `inspect.getsource`, which a class declared inline
// cannot serve. Each case drops exactly one seam and leaves the rest conforming,
// so a message that matched for the wrong reason would show up as the wrong
// seam being named. `stub_mlx_vlm` does the same for the two borrowed names —
// the pinned port never imports either, so they are seams of their own.
const harness = [
  'import atexit, hashlib, importlib.util, inspect, shutil, sys, tempfile, types',
  'from pathlib import Path',
  'spec = importlib.util.spec_from_file_location("_minimax_h3_mlx_pins", Path(sys.argv[1]))',
  'pins = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(pins)',
  'temp = Path(tempfile.mkdtemp())',
  'atexit.register(shutil.rmtree, temp, True)',
  'written = []',
  'def build_pin(drop=(), value_only=(), processor_property=True, merge=None, extra=None, sync_digest=True):',
  '    merge = pins.PINNED_BROADCAST_MERGE if merge is None else merge',
  '    body = ["class MiniMaxH3TextEncoder:"]',
  '    if "_wanted" not in drop:',
  '        body += ["    _wanted = \'a value, not a method\'"] if "_wanted" in value_only else ["    def _wanted(self, key):", "        return key"]',
  '    if "processor" not in drop:',
  '        body += ["    @property", "    def processor(self):", "        return None"] if processor_property else ["    processor = \'not-a-property\'"]',
  '    if "_load_weights" not in drop:',
  '        body += ["    _load_weights = \'a value, not a method\'"] if "_load_weights" in value_only else ["    def _load_weights(self, model_dir, dtype, verbose):", "        return None"]',
  '    if "encode" not in drop:',
  '        body += ["    encode = \'a value, not a method\'"] if "encode" in value_only else ["    def encode(self, prompt, images=None):", "        # " + merge] + (["        " + extra] if extra else []) + ["        return None"]',
  '    body += ["    pass"]',
  // A fresh filename per pin: `inspect.getsource` reads through linecache, which
  // caches by path, so reusing one would hand a second pin the first one's body.
  '    pin = temp / f"pinned_text_encoder_{len(written)}.py"',
  '    written.append(pin)',
  '    pin.write_text("\\n".join(body))',
  '    pin_spec = importlib.util.spec_from_file_location("minimax_h3_mlx.text_encoder", pin)',
  '    module = importlib.util.module_from_spec(pin_spec)',
  '    sys.modules["minimax_h3_mlx"] = types.ModuleType("minimax_h3_mlx")',
  '    sys.modules["minimax_h3_mlx.text_encoder"] = module',
  '    pin_spec.loader.exec_module(module)',
  '    encode = getattr(module.MiniMaxH3TextEncoder, "encode", None)',
  '    if sync_digest and callable(encode):',
  '        pins.PINNED_ENCODE_DIGEST = hashlib.sha256(inspect.getsource(encode).encode("utf-8")).hexdigest()',
  '    return module.MiniMaxH3TextEncoder',
  'def stub_mlx_vlm(drop=()):',
  '    for name in ("mlx_vlm", "mlx_vlm.models", "mlx_vlm.models.qwen3_vl", "mlx_vlm.models.qwen3_vl.language", "mlx_vlm.models.qwen3_vl.qwen3_vl", "mlx_vlm.utils"):',
  '        sys.modules[name] = types.ModuleType(name)',
  // Each borrowed name is hung off a REAL holder so dropping only the method
  // leaves its class in place — that is the drift an mlx-vlm bump most easily
  // makes, and a stub that dropped the class too would pass for the wrong reason.
  '    model = type("Model", (), {})',
  '    if "Model.merge_input_ids_with_image_features" not in drop:',
  '        model.merge_input_ids_with_image_features = staticmethod(lambda *args: None)',
  '    sys.modules["mlx_vlm.models.qwen3_vl.qwen3_vl"].Model = model',
  '    language_model = type("LanguageModel", (), {})',
  '    if "LanguageModel.get_rope_index" not in drop:',
  '        language_model.get_rope_index = staticmethod(lambda *args, **kwargs: None)',
  '    sys.modules["mlx_vlm.models.qwen3_vl.language"].LanguageModel = language_model',
  '    if "sanitize_weights" not in drop:',
  '        sys.modules["mlx_vlm.utils"].sanitize_weights = lambda *args: None',
  'def report():',
  '    try:',
  '        pins.verify_pin_seams()',
  '    except RuntimeError as exc:',
  '        print(str(exc))',
  '    else:',
  '        print("ACCEPTED")',
].join('\n');

describe.skipIf(!pyBin)('_minimax_h3_mlx_pins.py', () => {
  it('accepts a pin that still has every seam the corrections patch', () => {
    const output = runPython(`${harness}\n${[
      'build_pin()',
      'stub_mlx_vlm()',
      'report()',
    ].join('\n')}`);
    // The positive case is what makes the refusals below mean something: without
    // it every case could be passing on the same unrelated breakage.
    expect(output.trim()).toBe('ACCEPTED');
  });

  // Install / Repair is the action that moves the pin, so it is where the whole
  // seam set gets reported — rather than one seam at a time, minutes into
  // whichever render happens to touch it first.
  it.each([
    ['_wanted', /no longer exposes MiniMaxH3TextEncoder\._wanted.*Render with the stock text encoder/],
    ['processor', /no longer exposes MiniMaxH3TextEncoder\.processor.*Render text-only/],
    ['_load_weights', /no longer exposes MiniMaxH3TextEncoder\._load_weights.*Render text-only/],
    ['encode', /no longer exposes MiniMaxH3TextEncoder\.encode.*Render text-only/],
  ])('reports a pin that dropped %s', (seam, expected) => {
    const output = runPython(`${harness}\n${[
      `build_pin(drop=("${seam}",))`,
      'stub_mlx_vlm()',
      'report()',
    ].join('\n')}`);
    expect(output).toMatch(expected);
  });

  // Presence alone is not the seam for the three the runner wraps and then calls:
  // a name that survived a bump as a plain value would pass a presence check and
  // fail at the call site the check exists to protect.
  it.each([
    ['_wanted', /no longer exposes MiniMaxH3TextEncoder\._wanted/],
    ['_load_weights', /no longer exposes MiniMaxH3TextEncoder\._load_weights/],
    ['encode', /no longer exposes MiniMaxH3TextEncoder\.encode/],
  ])('reports a pin where %s survived as a non-callable', (seam, expected) => {
    const output = runPython(`${harness}\n${[
      `build_pin(value_only=("${seam}",))`,
      'stub_mlx_vlm()',
      'report()',
    ].join('\n')}`);
    expect(output).toMatch(expected);
  });

  // A `processor` that is no longer a property is as much a pin change as an
  // absent one: the pinned caller would start calling it, and the replacement
  // the runner binds is a property.
  it('reports a processor that is no longer a property', () => {
    const output = runPython(`${harness}\n${[
      'build_pin(processor_property=False)',
      'stub_mlx_vlm()',
      'report()',
    ].join('\n')}`);
    expect(output).toMatch(/no longer exposes MiniMaxH3TextEncoder\.processor/);
  });

  // `encode` is COPIED rather than wrapped, so its presence is not the seam —
  // its body is. Both halves matter: the merge line says the correction is still
  // needed at all, and the digest says nothing else in the body moved.
  it('reports a pin that stopped merging keyframe embeddings by broadcast', () => {
    const output = runPython(`${harness}\n${[
      // Upstream fixed the merge: the correction has to retire, not shadow it.
      'build_pin(merge=pins.PINNED_BROADCAST_MERGE.replace("mx.where", "masked_scatter"))',
      'stub_mlx_vlm()',
      'report()',
    ].join('\n')}`);
    expect(output).toMatch(/no longer merges keyframe embeddings/);
  });

  it('reports a pin whose encode changed outside the merge', () => {
    const output = runPython(`${harness}\n${[
      // The digest is recorded against the un-drifted body...
      'build_pin()',
      // ...and then the pin gains a step, with the merge line untouched. Drifting
      // the SOURCE rather than the expected digest is what makes this a probe of
      // the guard: matching the merge line alone could never see this edit.
      'build_pin(extra="images = images", sync_digest=False)',
      'stub_mlx_vlm()',
      'report()',
    ].join('\n')}`);
    expect(output).toMatch(/changed MiniMaxH3TextEncoder\.encode outside the merge/);
  });

  // The pinned port imports neither of these itself, so `minimax_h3_mlx.pipeline`
  // would keep importing cleanly after a pin bump onto an mlx-vlm that dropped
  // one — and the render-time ImportError would be the first anyone heard of it.
  it.each([
    ['Model.merge_input_ids_with_image_features', /no longer exposes mlx_vlm\.models\.qwen3_vl\.qwen3_vl\.Model\.merge_input_ids_with_image_features/],
    ['LanguageModel.get_rope_index', /no longer exposes mlx_vlm\.models\.qwen3_vl\.language\.LanguageModel\.get_rope_index/],
    ['sanitize_weights', /no longer exposes mlx_vlm\.utils\.sanitize_weights/],
  ])('reports an mlx-vlm that dropped %s', (attr, expected) => {
    const output = runPython(`${harness}\n${[
      'build_pin()',
      `stub_mlx_vlm(drop=("${attr}",))`,
      'report()',
    ].join('\n')}`);
    expect(output).toMatch(expected);
  });

  // Presence is not the seam either: every borrowed name is CALLED by the
  // correction that borrows it, so one that survived a pin bump as a plain value
  // would pass a presence check and then fail at the call site.
  it('reports a borrowed mlx-vlm name that survived as a non-callable', () => {
    const output = runPython(`${harness}\n${[
      'build_pin()',
      'stub_mlx_vlm()',
      'sys.modules["mlx_vlm.utils"].sanitize_weights = "no longer a function"',
      'report()',
    ].join('\n')}`);
    expect(output).toMatch(/no longer exposes mlx_vlm\.utils\.sanitize_weights as a callable/);
  });

  it('reports a borrowed mlx-vlm module that no longer imports at all', () => {
    const output = runPython(`${harness}\n${[
      'build_pin()',
      'stub_mlx_vlm()',
      // Not merely attribute-less: the whole module is gone, which raises
      // ImportError rather than returning None from getattr.
      'del sys.modules["mlx_vlm.utils"]',
      'report()',
    ].join('\n')}`);
    expect(output).toMatch(/no longer exposes mlx_vlm\.utils\.sanitize_weights/);
  });

  // The point of the module: the runner and the probe read ONE copy of the pin,
  // so a bump re-records it once. A second literal anywhere under scripts/ is the
  // failure this whole change exists to prevent — one copy re-recorded, the other
  // left asserting the old pin and passing.
  // `PINNED_BROADCAST_MERGE not in source` is vacuously false for an empty
  // string, so blanking that constant would disarm half the encode guard without
  // failing a single case above — the guard would keep "passing" on any pin.
  it('states a merge line specific enough for the encode guard to mean anything', () => {
    const merge = readFileSync(script, 'utf8').match(/^PINNED_BROADCAST_MERGE = "(.+)"$/m)?.[1];
    expect(merge).toContain('mx.where(');
    expect(merge.length).toBeGreaterThan(40);
  });

  it('keeps the pinned digest in exactly one file', () => {
    const digest = readFileSync(script, 'utf8').match(/^PINNED_ENCODE_DIGEST = "([0-9a-f]{64})"$/m)?.[1];
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    const holders = readdirSync(scriptsDir)
      .filter((name) => name.endsWith('.py'))
      .filter((name) => readFileSync(join(scriptsDir, name), 'utf8').includes(digest));
    expect(holders).toEqual(['_minimax_h3_mlx_pins.py']);
  });
});
