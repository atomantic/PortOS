import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';
import { MINIMAX_H3_EXPECTED_REVISION } from '../server/services/videoGen/runtimes.js';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'minimax_h3_runtime_probe.py');
const readScript = (name) => readFileSync(join(here, name), 'utf8');

// Same interpreter probe generate_minimax_h3.test.js explains: a name-only
// choice passes on a Windows box whose `python` is the Store alias STUB, and
// then every case dies with an opaque "Command failed".
const pyBin = resolveTestPython();
const runPython = (source) => execFileSync(pyBin, ['-c', source, script], { encoding: 'utf8' });

// The probe reaches `_runner_common` and `_minimax_h3_pin` by bare name, which
// works when Python runs it as a script because the script's own directory
// lands on sys.path. Loading it through spec_from_file_location does not do
// that, so the harness has to.
const importProbe = [
  'import hashlib, importlib.util, inspect, sys',
  'from pathlib import Path',
  'script = Path(sys.argv[1])',
  'sys.path.insert(0, str(script.parent))',
  'spec = importlib.util.spec_from_file_location("minimax_h3_runtime_probe", script)',
  'probe = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(probe)',
  'pin = sys.modules["_minimax_h3_pin"]',
  'common = sys.modules["_runner_common"]',
].join('\n');

// mlx-vlm is a Metal-only dependency that exists solely inside the H3 venv, and
// the probe reads exactly three attributes off it — so the suite stands in
// through sys.modules rather than skipping everywhere it isn't installed. The
// stub SHADOWS a real install too: a stub parent carries no `__path__`, so its
// submodules are unimportable unless this puts them in sys.modules. That is what
// makes `drop` work for a whole module as well as for a leaf, and what makes
// every case behave the same on a dev Mac and in CI.
const stubMlxVlm = (drop = null) => [
  'import sys, types',
  'def _module(name):',
  '    module = types.ModuleType(name)',
  '    sys.modules[name] = module',
  '    return module',
  'for _name in ["mlx_vlm", "mlx_vlm.models", "mlx_vlm.models.qwen3_vl"]:',
  '    _module(_name)',
  '_module("mlx_vlm.utils").sanitize_weights = lambda *a, **k: None',
  '_module("mlx_vlm.models.qwen3_vl.qwen3_vl").Model = type(',
  '    "Model", (), {"merge_input_ids_with_image_features": staticmethod(lambda *a, **k: None)})',
  '_module("mlx_vlm.models.qwen3_vl.language").LanguageModel = type(',
  '    "LanguageModel", (), {"get_rope_index": staticmethod(lambda *a, **k: None)})',
  // Built whole, then holed: a `drop` is one `del` against the finished stub
  // rather than a conditional threaded through every line that builds it.
  ...(drop ? [`_drop = ${JSON.stringify(drop)}`, [
    'if _drop in sys.modules:',
    '    del sys.modules[_drop]',
    'else:',
    '    _owner, _, _leaf = _drop.rpartition(".")',
    '    _parent, _, _attr = _owner.rpartition(".")',
    '    delattr(sys.modules.get(_owner) or getattr(sys.modules[_parent], _attr), _leaf)',
  ].join('\n')] : []),
].join('\n');

// A stand-in for the pinned checkout, on disk: the probe registers the package
// namespace itself and the encode seam is guarded with `inspect.getsource`, so
// neither part survives a sys.modules-only fake. Written as ordinary Python text
// with the merge line spliced in from the SHIPPED constant, so a re-recorded pin
// can never leave this suite asserting the old one.
const CHECKOUT_SEAMS = {
  _wanted: ['    def _wanted(self, key):', '        return key'],
  processor: ['    @property', '    def processor(self):', '        return None'],
  _load_weights: ['    def _load_weights(self, model_dir, dtype, verbose):', '        return None'],
  encode: ['    def encode(self, prompt, images=None):', '        # __MERGE__', '        return None'],
};

const fakeCheckout = ({ drop = null, plainProcessor = false } = {}) => {
  const body = Object.entries(CHECKOUT_SEAMS)
    .filter(([name]) => name !== drop)
    .flatMap(([name, lines]) => (name === 'processor' && plainProcessor ? lines.slice(1) : lines));
  const source = ['class MiniMaxH3TextEncoder:', ...body, ''].join('\n');
  return [
    'import atexit, shutil, tempfile',
    'temp = Path(tempfile.mkdtemp())',
    'atexit.register(shutil.rmtree, temp, True)',
    'package = temp / "minimax_h3_mlx"',
    'package.mkdir()',
    '(package / "pipeline.py").write_text("MiniMaxH3Pipeline = object\\n")',
    `(package / "text_encoder.py").write_text(${JSON.stringify(source)}.replace(`
    + '    "__MERGE__", pin.PINNED_BROADCAST_MERGE))',
  ].join('\n');
};

// The fake's `encode` is not the pinned one, so its digest has to be recorded
// before the probe reads it — otherwise every case would fail on the digest and
// prove nothing about the seam it actually removed. Registering the namespace
// here is what `probe.main()` does anyway, and it leaves the already-imported
// module cached for the run under test.
const recordFakeDigest = [
  'common.register_source_namespace("minimax_h3_mlx", package)',
  'from minimax_h3_mlx.text_encoder import MiniMaxH3TextEncoder as Fake',
  // The dropped-encode case has no body to hash, and does not need one: its
  // missing-hook check fires before the digest is ever consulted.
  'if hasattr(Fake, "encode"):',
  '    pin.PINNED_ENCODE_DIGEST = hashlib.sha256(',
  '        inspect.getsource(Fake.encode).encode("utf-8")',
  '    ).hexdigest()',
].join('\n');

const runProbe = (flags = ['--verify-seams']) => [
  `sys.argv = ["minimax_h3_runtime_probe.py", str(temp), ${flags.map((f) => JSON.stringify(f)).join(', ')}]`,
  'try:',
  '    print("exit", probe.main())',
  'except RuntimeError as exc:',
  '    print(str(exc))',
].filter(Boolean).join('\n');

const seamCase = (opts, flags) => runPython([
  importProbe, stubMlxVlm(opts.mlxVlmDrop), fakeCheckout(opts), recordFakeDigest, runProbe(flags),
].join('\n'));

describe.skipIf(!pyBin)('minimax_h3_runtime_probe.py', () => {
  it('passes a checkout whose every patched seam is still where PortOS left it', () => {
    expect(seamCase({}).trim()).toBe('exit 0');
  });

  // The readiness path in server/services/videoGen/runtimes.js runs this probe
  // BARE, and a false negative there sets byovGateBlocked and disables Generate
  // for text-only renders too. So a moved seam — which breaks only the keyframe
  // and substituted-conditioner paths — must not fail the flagless probe.
  it('ignores a moved seam without --verify-seams, so readiness is unaffected', () => {
    expect(seamCase({ drop: 'encode' }, []).trim()).toBe('exit 0');
  });

  // The whole point of the move: each of these used to surface minutes into a
  // keyframe render (three of the four only on the image-conditioned path),
  // where the pin bump that caused it was long out of sight.
  it.each([
    ['_wanted', /no longer exposes MiniMaxH3TextEncoder\._wanted/],
    ['processor', /no longer exposes MiniMaxH3TextEncoder\.processor/],
    ['_load_weights', /no longer exposes MiniMaxH3TextEncoder\._load_weights/],
    ['encode', /no longer exposes MiniMaxH3TextEncoder\.encode/],
  ])('fails Install / Repair when the pin dropped %s', (seam, expected) => {
    expect(seamCase({ drop: seam })).toMatch(expected);
  });

  // A `processor` that is no longer a property is as much a pin change as an
  // absent one: the pinned caller would start reading it as a plain attribute,
  // and the correction binds a property.
  it('fails Install / Repair when processor is no longer a property', () => {
    expect(seamCase({ plainProcessor: true })).toMatch(/no longer exposes MiniMaxH3TextEncoder\.processor/);
  });

  // The merge correction copies the pinned `encode` body rather than wrapping
  // it, so "the hook is present" is not enough — the body has to be the one that
  // was copied, and the two ways it can stop being that want opposite fixes.
  it('fails Install / Repair when the pinned encode body moved under an intact hook', () => {
    const output = runPython([
      importProbe, stubMlxVlm(), fakeCheckout(), runProbe(),
    ].join('\n'));
    expect(output).toMatch(/changed MiniMaxH3TextEncoder\.encode outside the merge/);
  });

  it('fails Install / Repair when upstream stopped merging by broadcast', () => {
    const fixedUpstream = [
      'source = (package / "text_encoder.py").read_text()',
      '(package / "text_encoder.py").write_text(',
      '    source.replace(pin.PINNED_BROADCAST_MERGE, "a real scatter"))',
    ].join('\n');
    const output = runPython([
      importProbe, stubMlxVlm(), fakeCheckout(), fixedUpstream, runProbe(),
    ].join('\n'));
    expect(output).toMatch(/no longer merges keyframe embeddings/);
  });

  // The corrections call these three by name; the probe did not import two of
  // them at all before, so a locked-mlx-vlm bump could take them away and only
  // a keyframe render would notice.
  it.each([
    ['mlx_vlm.utils', /no longer provides mlx_vlm\.utils/],
    ['mlx_vlm.utils.sanitize_weights', /no longer exposes mlx_vlm\.utils\.sanitize_weights/],
    ['mlx_vlm.models.qwen3_vl.qwen3_vl', /no longer provides mlx_vlm\.models\.qwen3_vl\.qwen3_vl/],
    [
      'mlx_vlm.models.qwen3_vl.qwen3_vl.Model.merge_input_ids_with_image_features',
      /no longer exposes mlx_vlm\.models\.qwen3_vl\.qwen3_vl\.Model\.merge_input_ids_with_image_features/,
    ],
    [
      'mlx_vlm.models.qwen3_vl.language.LanguageModel.get_rope_index',
      /no longer exposes mlx_vlm\.models\.qwen3_vl\.language\.LanguageModel\.get_rope_index/,
    ],
  ])('fails Install / Repair when mlx-vlm no longer carries %s', (dotted, expected) => {
    expect(seamCase({ mlxVlmDrop: dotted })).toMatch(expected);
  });

  // The one mlx-vlm module the FLAGLESS probe imports as well: losing it is a
  // broken runtime, not a moved seam, so it fails readiness too — and as an
  // ImportError from the bare import rather than a seam RuntimeError.
  it('fails even the flagless probe when mlx-vlm loses the language module', () => {
    expect(() => runPython([
      importProbe, stubMlxVlm('mlx_vlm.models.qwen3_vl.language'), fakeCheckout(), runProbe([]),
    ].join('\n'))).toThrow(/No module named .mlx_vlm.models.qwen3_vl.language./);
  });

  it('still refuses a runtime directory with no source package at all', () => {
    const output = runPython([
      importProbe,
      'import atexit, shutil, tempfile',
      'temp = Path(tempfile.mkdtemp())',
      'atexit.register(shutil.rmtree, temp, True)',
      runProbe([]),
    ].join('\n'));
    expect(output).toMatch(/runtime source is missing/);
  });
});

describe('MiniMax H3 pin facts', () => {
  // The failure this whole mechanism defends against is authored HERE, on a
  // branch: someone advances MINIMAX_H3_EXPECTED_REVISION and does not re-read
  // `encode`. Both probe suites overwrite PINNED_ENCODE_DIGEST with a freshly
  // computed one, so without this the shipped digest is asserted by nothing and
  // a stale pair ships green. Update this triple in the same commit that moves
  // the revision — after re-reading the new `encode` and folding whatever
  // changed into install_vision_embed_merge.
  it('keeps the recorded encode digest moving with the pinned revision', () => {
    const pin = readScript('_minimax_h3_pin.py');
    expect(MINIMAX_H3_EXPECTED_REVISION).toBe('fcd9e9b79a1d6018d91ac477c0968de1fa067e49');
    expect(pin).toContain(
      'PINNED_ENCODE_DIGEST = "8047e407e797cd46cd7538024ca09d97402d369d97b1d825757a1590416bda7d"',
    );
    expect(pin).toContain(
      'PINNED_BROADCAST_MERGE = "mx.where(image_mask[..., None], '
      + 'hidden.astype(inputs_embeds.dtype)[None], inputs_embeds)"',
    );
  });

  // PINNED_MLX_VLM_SYMBOLS is a hand-kept mirror of what the corrections import.
  // A correction that reaches for a fourth symbol would otherwise sail past
  // Install / Repair and fail mid-render — the exact gap this change closes for
  // the encoder seams.
  it('probes every mlx-vlm symbol the corrections import', () => {
    const covered = new Set(
      [...readScript('_minimax_h3_pin.py').matchAll(/\("(mlx_vlm[\w.]*)",\s*"([\w.]+)"/g)]
        .map(([, module, dotted]) => `${module}.${dotted.split('.')[0]}`),
    );
    const imported = [...readScript('generate_minimax_h3.py')
      .matchAll(/^\s*from (mlx_vlm[\w.]*) import (.+)$/gm)]
      .flatMap(([, module, names]) => names.split(',').map((name) => `${module}.${name.trim()}`));
    // Bypass probe: an import line that stopped matching would make the
    // assertion below vacuously true rather than failing.
    expect(imported.length).toBeGreaterThanOrEqual(3);
    expect(imported.filter((name) => !covered.has(name))).toEqual([]);
  });
});
