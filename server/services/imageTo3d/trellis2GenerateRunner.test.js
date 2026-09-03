import { execFileSync } from '../../lib/childProcess.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trellis2GenerateRunnerScript } from './trellis2.js';
import { trellis2FillHolesScript } from './trellis2MeshQuality.js';
import { PY_SUBPROCESS_TIMEOUT_MS, PY_TEST_TIMEOUT_MS, resolveTestPython } from '../../lib/testHelper.js';

// Probe for an interpreter that actually runs rather than assuming `python3`:
// on Windows that name is absent and `python` is a Store alias stub that exists
// but fails, so a hardcoded name turns "no Python here" into an opaque
// "Command failed" (see resolveTestPython).

const pyBin = resolveTestPython();

// A stand-in for the two upstream modules the adapter patches. Records what it was
// called with and models the one behaviour that matters: `to_glb` decimates down to
// whatever `decimation_target` it receives. Without that modelling, the test could
// not tell a working override from one that gets silently undone at the bake.
const STUB_FAST_SIMPLIFICATION = `CALLS = []
def simplify(points, faces, ratio=None, **kw):
    CALLS.append((len(faces), round(ratio, 6)))
    return points, list(range(max(1, int(round(len(faces) * (1.0 - ratio))))))
`;

const stubPostprocess = ({ backend = 'metal', hasDr = true }) => `import os
# Recorded AT IMPORT TIME. The real module imports torch, and
# PYTORCH_ENABLE_MPS_FALLBACK is only honored if it is set before that happens —
# so capturing it here is what makes the ordering testable without torch.
ENV_AT_IMPORT = os.environ.get('PYTORCH_ENABLE_MPS_FALLBACK')
_BACKEND = ${backend === null ? 'None' : `'${backend}'`}
_HAS_DR = ${hasDr ? 'True' : 'False'}
_HAS_FLEX_GEMM = True
CALLS = []
def to_glb(**kw):
    faces = kw['faces']
    target = kw['decimation_target']
    CALLS.append({'exported': min(len(faces), target), **{k: v for k, v in kw.items() if k != 'faces'}})
    return 'glb'
`;

// Mirrors the shape of upstream generate.py's Metal bake branch: derive a ratio
// from the 200K clamp, simplify, then hand the result to to_glb with the same
// clamp as `decimation_target`.
const FAKE_GENERATE = `import argparse, json, os, fast_simplification, o_voxel.postprocess
p = argparse.ArgumentParser()
p.add_argument("image")
p.add_argument("--output", default="out")
p.add_argument("--pipeline-type", default="512")
p.add_argument("--texture-size", type=int, choices=[512, 1024, 2048], default=1024)
p.add_argument("--seed", type=int, default=42)
p.add_argument("--steps", type=int, default=None)
a = p.parse_args()
faces = list(range(int(os.environ.get("FIXTURE_FACES", "22746188"))))
target = min(200000, len(faces))
v, f = fast_simplification.simplify(['v'], faces, 1.0 - (target / len(faces)))
o_voxel.postprocess.to_glb(faces=f, decimation_target=target, texture_size=a.texture_size)
print("RESULT " + json.dumps({
    "simplify": fast_simplification.CALLS,
    "to_glb": o_voxel.postprocess.CALLS,
    "image": a.image,
    "texture_size": a.texture_size,
    "seed": a.seed,
    "steps": a.steps,
    "mps_fallback_at_o_voxel_import": o_voxel.postprocess.ENV_AT_IMPORT,
    "mps_fallback_now": os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK"),
}))
`;

describe.skipIf(!pyBin)('trellis2GenerateRunner', () => {
  let dir;

  const writeStubs = ({ backend = 'metal', hasDr = true } = {}) => {
    mkdirSync(join(dir, 'stub', 'o_voxel'), { recursive: true });
    writeFileSync(join(dir, 'stub', 'fast_simplification.py'), STUB_FAST_SIMPLIFICATION);
    writeFileSync(join(dir, 'stub', 'o_voxel', '__init__.py'), '');
    writeFileSync(join(dir, 'stub', 'o_voxel', 'postprocess.py'), stubPostprocess({ backend, hasDr }));
  };

  const run = (args, { env = {} } = {}) => execFileSync(
    pyBin,
    [trellis2GenerateRunnerScript(), ...args],
    {
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env, PYTHONPATH: join(dir, 'stub'), ...env },
      timeout: PY_SUBPROCESS_TIMEOUT_MS,
    },
  );

  const resultOf = (output) => JSON.parse(
    output.split('\n').find((l) => l.startsWith('RESULT ')).slice('RESULT '.length),
  );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'portos-trellis2-runner-'));
    writeFileSync(join(dir, 'generate.py'), FAKE_GENERATE);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('preserves direct-script imports while exposing the 4K texture size', () => {
    writeStubs();
    writeFileSync(join(dir, 'fixture_module.py'), 'VALUE = "local-import-ok"\n');
    writeFileSync(join(dir, 'generate.py'), [
      'import argparse',
      'from fixture_module import VALUE',
      'parser = argparse.ArgumentParser()',
      'parser.add_argument("--texture-size", type=int, choices=[512, 1024, 2048])',
      'args = parser.parse_args()',
      'print(f"{VALUE}:{args.texture_size}")',
      '',
    ].join('\n'));

    expect(run(['--', join(dir, 'generate.py'), '--texture-size', '4096']).trim())
      .toBe('local-import-ok:4096');
  }, PY_TEST_TIMEOUT_MS);

  it('sets PYTORCH_ENABLE_MPS_FALLBACK before anything can import torch', () => {
    // Regression guard, and the bug it guards is not hypothetical: this adapter
    // imports o_voxel.postprocess (which imports torch) to install the decimation
    // patch. generate.py sets this flag at ITS module top, which is too late once
    // the adapter has already initialized torch — and MPS has no segment_reduce
    // kernel, so every render died ~3 minutes in with NotImplementedError from the
    // first sampler step. Asserting on the value the stub captured AT IMPORT is what
    // makes the ordering, not just the final value, the thing under test.
    writeStubs();
    const r = resultOf(run(['--decimation-target', '1000000', '--', join(dir, 'generate.py'), 'a.png']));
    expect(r.mps_fallback_at_o_voxel_import).toBe('1');
    expect(r.mps_fallback_now).toBe('1');
  }, PY_TEST_TIMEOUT_MS);

  it('lets an explicit caller env win over the preamble defaults', () => {
    // setdefault, not assignment — otherwise the adapter would silently override a
    // deliberate choice by whoever spawned it.
    writeStubs();
    const r = resultOf(run(
      ['--', join(dir, 'generate.py'), 'a.png'],
      { env: { PYTORCH_ENABLE_MPS_FALLBACK: '0' } },
    ));
    expect(r.mps_fallback_at_o_voxel_import).toBe('0');
  }, PY_TEST_TIMEOUT_MS);

  it('passes upstream arguments through untouched after the `--` separator', () => {
    writeStubs();
    const r = resultOf(run([
      '--', join(dir, 'generate.py'), 'shoe.png',
      '--texture-size', '2048', '--seed', '7', '--steps', '24',
    ]));
    expect(r).toMatchObject({ image: 'shoe.png', texture_size: 2048, seed: 7, steps: 24 });
  }, PY_TEST_TIMEOUT_MS);

  it('leaves upstream’s 200K clamp alone when no target is requested', () => {
    // Backward compatibility: an install that asks for nothing must render
    // byte-identically to before this adapter grew the flag.
    writeStubs();
    const r = resultOf(run(['--', join(dir, 'generate.py'), 'a.png']));
    expect(r.to_glb[0].exported).toBe(200000);
    expect(r.to_glb[0].decimation_target).toBe(200000);
  }, PY_TEST_TIMEOUT_MS);

  it('retargets BOTH the simplify ratio and to_glb’s own decimation target', () => {
    // The two halves are separately necessary. Patching only the ratio hands
    // to_glb a 1M-face mesh with a 200K target, and it re-decimates straight
    // back down — a silent no-op that looks like the override never applied.
    writeStubs();
    const r = resultOf(run(['--decimation-target', '1000000', '--', join(dir, 'generate.py'), 'a.png']));
    expect(r.simplify[0][0]).toBe(22746188);
    expect(r.simplify[0][1]).toBeCloseTo(1 - (1000000 / 22746188), 6);
    expect(r.to_glb[0].decimation_target).toBe(1000000);
    expect(r.to_glb[0].exported).toBe(1000000);
  }, PY_TEST_TIMEOUT_MS);

  it('raises a retuned upstream clamp instead of silently letting it win', () => {
    // An equality check against 200000 would no-op here and to_glb would re-decimate
    // to 300000 — a silent quality regression with nothing failing.
    writeStubs();
    writeFileSync(join(dir, 'generate.py'),
      FAKE_GENERATE.replace('min(200000, len(faces))', 'min(300000, len(faces))'));
    const out = run(['--decimation-target', '1000000', '--', join(dir, 'generate.py'), 'a.png']);
    expect(out).toMatch(/not the expected 200,000/);
    expect(resultOf(out).to_glb[0].decimation_target).toBe(1000000);
  }, PY_TEST_TIMEOUT_MS);

  it('never lowers a target that is already above ours', () => {
    // Only ever raises: a caller asking for MORE than we would must not be cut down.
    writeStubs();
    writeFileSync(join(dir, 'generate.py'),
      FAKE_GENERATE.replace('min(200000, len(faces))', '5000000'));
    const r = resultOf(run(['--decimation-target', '1000000', '--', join(dir, 'generate.py'), 'a.png']));
    expect(r.to_glb[0].decimation_target).toBe(5000000);
  }, PY_TEST_TIMEOUT_MS);

  it('no-ops the simplify call when the mesh is already under target', () => {
    // The fixture must be SMALLER than the target for this to exercise the
    // `n_faces <= target` branch at all. An earlier version used an 8.6M target
    // against a 22.7M-face fixture, so it measured decimation and left the branch
    // it names uncovered — where a regression computing a negative ratio would
    // crash or corrupt the render. Reachable in practice on a high-memory host that
    // explicitly picks the fast/512 tier.
    writeStubs();
    const r = resultOf(run(
      ['--decimation-target', '1000000', '--', join(dir, 'generate.py'), 'a.png'],
      { env: { FIXTURE_FACES: '150000' } },
    ));
    // simplify was called by upstream (its guard compares against 200K) and our
    // wrapper returned the input untouched rather than decimating.
    expect(r.simplify).toEqual([]);
    expect(r.to_glb[0].exported).toBe(150000);
  }, PY_TEST_TIMEOUT_MS);

  it('still decimates when the mesh is over target', () => {
    // The other side of that branch, so neither direction can regress silently.
    writeStubs();
    const r = resultOf(run(
      ['--decimation-target', '100000', '--', join(dir, 'generate.py'), 'a.png'],
      { env: { FIXTURE_FACES: '150000' } },
    ));
    expect(r.simplify).toHaveLength(1);
    expect(r.to_glb[0].exported).toBe(100000);
  }, PY_TEST_TIMEOUT_MS);

  it('refuses to raise the target on a degraded install, and says why', () => {
    // The KDTree fallback's xatlas unwrap hangs on large meshes, so raising the
    // target there would trade lost detail for a render that never finishes.
    writeStubs({ hasDr: false });
    const out = run(['--decimation-target', '1000000', '--', join(dir, 'generate.py'), 'a.png']);
    expect(out).toMatch(/Metal bake backend unavailable/);
    expect(resultOf(out).to_glb[0].exported).toBe(200000);
  }, PY_TEST_TIMEOUT_MS);

  it('forwards the exporter knobs upstream never passes', () => {
    writeStubs();
    const r = resultOf(run([
      '--remesh', '--alpha-mode', 'auto',
      '--mesh-cluster-refine-iterations', '2',
      '--mesh-cluster-smooth-strength', '0.5',
      '--', join(dir, 'generate.py'), 'a.png',
    ]));
    expect(r.to_glb[0]).toMatchObject({
      remesh: true,
      alpha_mode: 'auto',
      mesh_cluster_refine_iterations: 2,
      mesh_cluster_smooth_strength: 0.5,
    });
  }, PY_TEST_TIMEOUT_MS);

  it('passes no exporter knobs at all when none are requested', () => {
    writeStubs();
    const r = resultOf(run(['--', join(dir, 'generate.py'), 'a.png']));
    expect(r.to_glb[0]).not.toHaveProperty('remesh');
    expect(r.to_glb[0]).not.toHaveProperty('alpha_mode');
  }, PY_TEST_TIMEOUT_MS);

  it('captures the pre-decimation mesh for the normal bake without --decimation-target', () => {
    // --normal-map used to silently no-op unless --decimation-target happened to be
    // passed too, because the capture lived inside the decimation patch. Nothing in
    // the CLI expressed that dependency.
    writeStubs();
    const out = run(['--normal-map', '--', join(dir, 'generate.py'), 'a.png']);
    expect(out).not.toMatch(/no pre-decimation mesh was captured/);
    // Bake runs against the stub's fake mesh and fails; that must not fail the render.
    expect(resultOf(out).to_glb).toHaveLength(1);
  }, PY_TEST_TIMEOUT_MS);

  it('never fails the render when the normal bake throws', () => {
    // The mesh and its base colour are already correct by then — a normal map is an
    // enhancement, so a bake failure degrades to today's output rather than losing
    // a render the user already waited minutes for.
    writeStubs();
    const out = run(['--normal-map', '--decimation-target', '1000000',
      '--', join(dir, 'generate.py'), 'a.png']);
    expect(out).toMatch(/normal map bake failed|normal map:/);
    expect(resultOf(out).to_glb[0].exported).toBe(1000000);
  }, PY_TEST_TIMEOUT_MS);

  it('fails loudly when --fill-holes is asked for but the gate is absent', () => {
    // Must not degrade to "render without hole filling" — that is exactly the
    // output the flag exists to avoid, so silence here would be a lie.
    writeStubs();
    mkdirSync(join(dir, 'TRELLIS.2', 'trellis2', 'representations', 'mesh'), { recursive: true });
    writeFileSync(
      join(dir, 'TRELLIS.2', 'trellis2', 'representations', 'mesh', 'base.py'),
      'class Mesh:\n    def fill_holes(self):\n        return  # stubbed\n',
    );
    expect(() => run(['--fill-holes', '--', join(dir, 'generate.py'), 'a.png']))
      .toThrow(/unconditional mps_compat stub|still carries/);
  }, PY_TEST_TIMEOUT_MS);

  it('rejects an invocation with no upstream script', () => {
    writeStubs();
    expect(() => run(['--decimation-target', '1000'])).toThrow(/requires the upstream generate.py path/);
  }, PY_TEST_TIMEOUT_MS);
});

describe.skipIf(!pyBin)('trellis2RestoreFillHoles', () => {
  let dir;
  const basePath = () => join(dir, 'TRELLIS.2', 'trellis2', 'representations', 'mesh', 'base.py');

  // The exact line mps_compat.py injects, en dash included.
  const STUBBED = [
    'class Mesh:',
    '    def fill_holes(self, max_hole_perimeter=3e-2):',
    '        return  # Skip — Metal cumesh segfaults on large decode meshes',
    '        vertices = self.vertices.to(self.device)',
    '',
    '    def remove_faces(self, face_mask):',
    '        return',
    '',
    '    def simplify(self, target=1000000):',
    '        return',
    '',
  ].join('\n');

  const patch = () => execFileSync(pyBin, [trellis2FillHolesScript(), dir],
    { encoding: 'utf8', timeout: PY_SUBPROCESS_TIMEOUT_MS });

  // Python's `write_text` translates \n to the platform line ending, so the patched
  // file is CRLF on Windows while Node's readFileSync returns the raw bytes. A
  // `\n\s+` regex then cannot match — this failed ONLY on the Windows CI runner and
  // passed locally. Normalizing is the convention root AGENTS.md prescribes for
  // exactly this class of failure.
  const readNormalized = () => readFileSync(basePath(), 'utf8').replace(/\r\n?/g, '\n');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'portos-fillholes-'));
    mkdirSync(join(dir, 'TRELLIS.2', 'trellis2', 'representations', 'mesh'), { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('converts the hard stub into an environment gate', () => {
    writeFileSync(basePath(), STUBBED);
    patch();
    const out = readNormalized();
    expect(out).toContain('PORTOS_TRELLIS2_FILL_HOLES');
    expect(out).not.toContain('return  # Skip');
    // Default-off is the safety property: absent the env var, behaviour is
    // identical to the hard stub.
    expect(out).toMatch(/if not os\.environ\.get\('PORTOS_TRELLIS2_FILL_HOLES'\):\n\s+return/);
  }, PY_TEST_TIMEOUT_MS);

  it('leaves remove_faces and simplify stubbed', () => {
    // Deliberate: neither has the independent at-scale evidence fill_holes has,
    // and `simplify` additionally interacts with the decimation-target override.
    writeFileSync(basePath(), STUBBED);
    patch();
    const out = readNormalized();
    expect(out).toMatch(/def remove_faces\(self, face_mask\):\n\s+return\n/);
    expect(out).toMatch(/def simplify\(self, target=1000000\):\n\s+return\n/);
  }, PY_TEST_TIMEOUT_MS);

  it('finds the stub when the interpreter default codec is not UTF-8', () => {
    // The Windows-only failure this pins: UPSTREAM_STUB contains an en dash, and a
    // locale-default read (cp1252 on a Windows runner) mangles it so the literal match
    // fails and the patcher reports "upstream changed the patch". PYTHONUTF8=0 plus a
    // legacy locale reproduces that on any platform; without an explicit encoding= in
    // the patcher this test fails here too.
    writeFileSync(basePath(), STUBBED);
    const out = execFileSync(pyBin, [trellis2FillHolesScript(), dir], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONUTF8: '0', LC_ALL: 'C', LANG: 'C' },
      timeout: PY_SUBPROCESS_TIMEOUT_MS,
    });
    expect(out).toMatch(/now gated/);
    expect(readNormalized()).toContain('PORTOS_TRELLIS2_FILL_HOLES');
  }, PY_TEST_TIMEOUT_MS);

  it('finds and replaces the stub in a CRLF file', () => {
    // The Windows condition, reproduced on any platform. The patcher matches
    // UPSTREAM_STUB literally and that literal contains \n, so it only works because
    // Python's read_text applies universal newlines. If someone switched it to a
    // byte-level read, this breaks on every Windows checkout and nowhere else.
    writeFileSync(basePath(), STUBBED.replace(/\n/g, '\r\n'));
    patch();
    expect(readNormalized()).toContain('PORTOS_TRELLIS2_FILL_HOLES');
    expect(readNormalized()).not.toContain('return  # Skip');
  }, PY_TEST_TIMEOUT_MS);

  it('is idempotent, so it is safe as a repeated repair step', () => {
    writeFileSync(basePath(), STUBBED);
    patch();
    const once = readNormalized();
    expect(patch()).toMatch(/already present/);
    expect(readNormalized()).toBe(once);
  }, PY_TEST_TIMEOUT_MS);

  it('fails loudly rather than no-op’ing when upstream’s stub text changes', () => {
    // A silent no-op would leave --fill-holes appearing to work and doing nothing.
    writeFileSync(basePath(), 'class Mesh:\n    def fill_holes(self):\n        pass\n');
    expect(() => patch()).toThrow(/expected mps_compat's fill_holes stub/);
  }, PY_TEST_TIMEOUT_MS);

  it('fails when the target file is missing entirely', () => {
    expect(() => patch()).toThrow(/not found/);
  }, PY_TEST_TIMEOUT_MS);
});
