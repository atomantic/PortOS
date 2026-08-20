import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

// The probe `isByovRuntimeReady()` and scripts/setup-image-video.sh run at
// Install / Repair. It imports the pinned package out of a namespace that never
// exposes the checkout root, and — since the seams moved here — refuses a pin
// whose text encoder no longer fits the corrections generate_minimax_h3.py
// installs at render time.
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const script = join(scriptsDir, 'minimax_h3_runtime_probe.py');

// Probe for an interpreter that actually RUNS rather than assuming a name (see
// _minimax_h3_mlx_pins.test.js for why a bare name is not enough on Windows).
const pyBin = resolveTestPython();

// Drive the probe as `__main__` through runpy rather than spawning it directly:
// the mlx-vlm and pinned-package imports have to be satisfied by stubs, and a
// bare interpreter has neither. Everything the probe itself does — the source
// namespace registration, the imports, verify_pin_seams — still runs for real.
const runProbe = (setup) => {
  const source = [
    'import runpy, sys, tempfile, types',
    'from pathlib import Path',
    'probe = Path(sys.argv[1])',
    // The probe reaches its siblings through sys.path[0], which runpy does not
    // set for it.
    'sys.path.insert(0, str(probe.parent))',
    'runtime = Path(tempfile.mkdtemp()) / "runtime"',
    'package = runtime / "minimax_h3_mlx"',
    'package.mkdir(parents=True)',
    '(package / "pipeline.py").write_text("PIPELINE = True")',
    // mlx-vlm is not installed under a bare interpreter, and the two names the
    // corrections borrow are seams of their own, so stub the tree explicitly.
    'for name in ("mlx_vlm", "mlx_vlm.models", "mlx_vlm.models.qwen3_vl", "mlx_vlm.models.qwen3_vl.language", "mlx_vlm.models.qwen3_vl.qwen3_vl", "mlx_vlm.utils"):',
    '    sys.modules[name] = types.ModuleType(name)',
    'sys.modules["mlx_vlm.models.qwen3_vl.qwen3_vl"].Model = type("Model", (), {"merge_input_ids_with_image_features": staticmethod(lambda *args: None)})',
    'sys.modules["mlx_vlm.models.qwen3_vl.language"].LanguageModel = type("LanguageModel", (), {"get_rope_index": staticmethod(lambda *args, **kwargs: None)})',
    'sys.modules["mlx_vlm.utils"].sanitize_weights = lambda *args: None',
    ...setup,
    'sys.argv = ["minimax_h3_runtime_probe.py", str(runtime)]',
    'try:',
    '    runpy.run_path(str(probe), run_name="__main__")',
    'except SystemExit as exc:',
    '    print(f"EXIT:{exc.code}")',
    'except RuntimeError as exc:',
    '    print(str(exc))',
  ].join('\n');
  return execFileSync(pyBin, ['-c', source, script], { encoding: 'utf8' });
};

// Write the pinned encoder into the checkout the probe is pointed at, so
// `register_source_namespace` + `inspect.getsource` both see a real file — which
// is what the encode digest is computed over. `pins` is imported first and the
// digest re-recorded against this stand-in, because the probe's own import of
// the module resolves to the same sys.modules entry.
const conformingPin = [
  'import hashlib, importlib, inspect',
  'pins = importlib.import_module("_minimax_h3_mlx_pins")',
  '(package / "text_encoder.py").write_text("\\n".join([',
  '    "class MiniMaxH3TextEncoder:",',
  '    "    def _wanted(self, key):",',
  '    "        return key",',
  '    "    @property",',
  '    "    def processor(self):",',
  '    "        return None",',
  '    "    def _load_weights(self, model_dir, dtype, verbose):",',
  '    "        return None",',
  '    "    def encode(self, prompt, images=None):",',
  '    "        # " + pins.PINNED_BROADCAST_MERGE,',
  '    "        return None",',
  ']))',
];
const syncDigest = [
  'from minimax_h3_mlx.text_encoder import MiniMaxH3TextEncoder as Pinned',
  'pins.PINNED_ENCODE_DIGEST = hashlib.sha256(inspect.getsource(Pinned.encode).encode("utf-8")).hexdigest()',
];

describe.skipIf(!pyBin)('minimax_h3_runtime_probe.py', () => {
  it('passes a checkout whose text encoder still has every patched seam', () => {
    const output = runProbe([
      ...conformingPin,
      // Importing the pinned module needs the namespace the probe registers, so
      // register it here too — the probe's own call is idempotent.
      'from _runner_common import register_source_namespace',
      'register_source_namespace("minimax_h3_mlx", package)',
      ...syncDigest,
    ]);
    expect(output.trim()).toBe('EXIT:0');
  });

  // The whole point of moving the assertions here: a pin bump that breaks a
  // correction has to fail the bump, not the first keyframe render after it.
  it('refuses a checkout whose text encoder lost a patched seam', () => {
    const output = runProbe([
      ...conformingPin,
      'from _runner_common import register_source_namespace',
      'register_source_namespace("minimax_h3_mlx", package)',
      ...syncDigest,
      // Written after the digest is recorded, so `encode` is untouched and this
      // case can only be reported for the seam it actually broke.
      '(package / "text_encoder.py").write_text((package / "text_encoder.py").read_text().replace("_load_weights", "_load_weights_renamed"))',
      'del sys.modules["minimax_h3_mlx.text_encoder"]',
    ]);
    expect(output).toMatch(/no longer exposes MiniMaxH3TextEncoder\._load_weights/);
    expect(output).not.toMatch(/EXIT:0/);
  });

  // The other half of what verify_pin_seams checks: names the corrections borrow
  // from mlx-vlm rather than from the pinned checkout. Nothing about the checkout
  // moved here, so only an mlx-vlm-side drift can produce this.
  it('refuses a runtime whose mlx-vlm dropped a borrowed name', () => {
    const output = runProbe([
      ...conformingPin,
      'from _runner_common import register_source_namespace',
      'register_source_namespace("minimax_h3_mlx", package)',
      ...syncDigest,
      'del sys.modules["mlx_vlm.models.qwen3_vl.qwen3_vl"].Model.merge_input_ids_with_image_features',
    ]);
    expect(output).toMatch(/no longer exposes mlx_vlm\.models\.qwen3_vl\.qwen3_vl\.Model\.merge_input_ids_with_image_features/);
    expect(output).not.toMatch(/EXIT:0/);
  });

  it('still refuses a runtime directory with no pinned package in it', () => {
    const output = runProbe([
      ...conformingPin,
      '(package / "pipeline.py").unlink()',
    ]);
    expect(output).toMatch(/MiniMax H3 runtime source is missing/);
  });
});
