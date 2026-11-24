/**
 * The moving-parts report, from the driver's stdout lines to report.json's
 * findings. The events were recorded from real Blender 5.3 builds of
 * __fixtures__/box_with_lid.py on macOS, once as it is and once with the lid's
 * hinge axis 5 mm in from the back edge (PORTOS_FIXTURE_AXIS_INSET=0.005).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from '../../lib/childProcess.js';
import { PY_SUBPROCESS_TIMEOUT_MS, PY_TEST_TIMEOUT_MS, resolveTestPython } from '../../lib/testHelper.js';
import { fileURLToPath } from 'node:url';
import { BLENDER_MODEL_DRIVER_PREFIX, parseBlenderModelDriverLine } from './protocol.js';
import { buildBlenderModelReport, collectBlenderModelFacts } from './report.js';

const recorded = (name) => JSON.parse(readFileSync(new URL(`./__fixtures__/${name}.events.json`, import.meta.url), 'utf8'));
const clean = () => recorded('box_with_lid');
const inset = () => recorded('box_with_lid_inset');

function reportOf(events) {
  const facts = collectBlenderModelFacts();
  for (const event of events) facts.add(parseBlenderModelDriverLine(BLENDER_MODEL_DRIVER_PREFIX + JSON.stringify(event)));
  return buildBlenderModelReport(facts.facts(), { modelId: 'bmodel-1', buildId: 'build-1', quality: 'draft', startedAt: null, finishedAt: null, srcHash: 'h', glbBytes: 10 });
}
const edit = (events, match, change) => events.map((event) => (match(event) ? { ...event, ...(typeof change === 'function' ? change(event) : change) } : event));
const named = (kind) => (event) => event.event === kind;
const describing = (change) => edit(clean(), named('described'), change);
const finding = (report, code) => report.findings.find((entry) => entry.code === code);

describe('moving parts', () => {
  it('reports the box with a lid as clean and publishable', () => {
    const report = reportOf(clean());
    expect(report.findings.map((entry) => entry.code)).toEqual(['materials']);
    expect(report.publishable).toBe(true);
    const { controls, actions, sweep } = report.checks.motion;
    expect(controls.map((control) => [control.id, control.parts, control.clamps, control.follows, control.reimportError])).toEqual([
      ['lid', ['knob', 'lid'], true, true, 0], ['clip', ['clip'], true, true, 0],
    ]);
    expect(controls[1].dependsOn).toEqual([{ control: 'lid', atMost: 0.02 }]);
    expect(actions).toMatchObject([{ id: 'open', frames: 25, error: null, unmet: [] }]);
    expect(sweep).toMatchObject({ poses: 88, budgetSec: 120, overlaps: [], unmeasured: [], clean: true });
  });

  it('names the two parts and the first failing value when the hinge axis sits 5 mm into the box', () => {
    const report = reportOf(inset());
    expect(report.publishable).toBe(false);
    expect(report.checks.motion.sweep.clean).toBe(false);
    expect(finding(report, 'sweep-overlap')).toMatchObject({
      severity: 'error', subjects: ['box', 'lid'], pose: { lid: 0.15, clip: 0 }, message: 'box and lid pass through each other, first with Lid 0.15',
      values: { where: [{ kind: 'control', ids: ['lid'], poses: 18 }, { kind: 'pair', ids: ['lid', 'clip'] }, { kind: 'action', ids: ['open'], t: 0.125 }] },
    });
  });

  it('lists an allowed contact instead of hiding it, and does not count it as an overlap', () => {
    const report = reportOf(edit(inset(), named('described'), { allowContact: [['lid', 'box'], ['lid', 'clip'], ['lid', 'ghost']] }));
    expect(finding(report, 'sweep-overlap')).toBeUndefined();
    expect(finding(report, 'sweep-allowed-contact')).toMatchObject({ severity: 'note', subjects: ['lid and box', 'lid and clip (never met)'] });
    expect(finding(report, 'allow-contact-unknown')).toMatchObject({ severity: 'warning', subjects: ['["lid","ghost"]'] });
    expect(report.checks.motion.sweep).toMatchObject({ clean: true, allowed: [{ parts: ['lid', 'box'], met: true }, { parts: ['lid', 'clip'], met: false }] });
  });

  it('reports poses the time did not reach as unmeasured, never clean', () => {
    const short = edit(clean(), (event) => event.event === 'sweep-scope' && event.kind === 'pair', { measured: 4 })
      .filter((event) => !(event.event === 'sweep-scope' && event.kind === 'action'));
    const report = reportOf(edit(short, named('sweep'), { empty: ['knob'] }));
    expect(finding(report, 'sweep-unmeasured')).toMatchObject({ severity: 'warning', subjects: ['lid + clip (4 of 21 poses)', 'action open', 'part knob (no faces)'] });
    expect(report.checks.motion.sweep.clean).toBe(false);
    const none = reportOf(clean().filter((event) => !event.event.startsWith('sweep')));
    expect(none.checks.motion.sweep.clean).toBe(false);
    expect(finding(none, 'sweep-unmeasured').subjects).toEqual(['lid', 'clip', 'action open']);
  });

  it('says which pairs already overlapped as built and so were not checked', () => {
    const report = reportOf([...clean(), { event: 'sweep-rest', a: 'box', b: 'lid' }]);
    expect(finding(report, 'sweep-rest-overlap')).toMatchObject({ severity: 'note', subjects: ['box and lid'] });
  });

  it.each([
    ['runs past its range at 1.3', 'control-clamp', 1.3, { measured: 143 }],
    ['runs past its range at -0.3', 'control-clamp', -0.3, { measured: -33 }],
    ['stops short of its command', 'control-mismatch', 0.5, { measured: 49.5 }],
    ['leaves its axis', 'control-mismatch', 1, { drift: 0.01 }],
  ])('flags a control that %s', (_label, code, command, change) => {
    const report = reportOf(edit(clean(), (event) => event.event === 'control' && event.id === 'lid', (event) => ({
      probes: event.probes.map((probe) => (probe.command === command ? { ...probe, ...change } : probe)),
    })));
    expect(report.findings.filter((entry) => entry.severity === 'error')).toMatchObject([{ code, subjects: ['lid'] }]);
  });

  it('flags a control whose probes are missing instead of passing it', () => {
    const report = reportOf(edit(clean(), (event) => event.event === 'control' && event.id === 'lid', { probes: [] }));
    expect([finding(report, 'control-clamp').subjects, finding(report, 'control-mismatch').subjects]).toEqual([['lid'], ['lid']]);
  });

  it('flags a GLB action that is missing or ends elsewhere', () => {
    const moved = (change) => reportOf(edit(clean(), (event) => event.event === 'reimport-control' && event.id === 'lid', change));
    expect(finding(moved({ found: false, error: null }), 'reimport-control')).toMatchObject({ severity: 'error', subjects: ['lid'] });
    expect(finding(moved({ error: 0.038 }), 'reimport-control')).toMatchObject({ subjects: ['lid'] });
    expect(finding(moved({ error: 0.0001 }), 'reimport-control')).toBeUndefined();
  });

  it('names what is wrong with a control, its dependencies and its actions', () => {
    const { controls } = clean().find(named('described'));
    const [lid, clip] = controls;
    const codes = (change) => reportOf(describing(change)).findings.filter((entry) => entry.severity === 'error').map((entry) => [entry.code, entry.subjects]);
    expect(codes({ controls: [lid, { ...clip, min: 1 }] })).toEqual([['control-invalid', ['clip (needs min < max with default between them)']]]);
    expect(codes({ controls: [lid, { ...clip, partId: 'ghost' }] })).toEqual([['control-invalid', ['clip (no part named ghost)']]]);
    expect(codes({ controls: [lid, clip, lid] })).toEqual([['control-invalid', ['lid (the id is used twice)']]]);
    expect(codes({ controls: [lid, { ...clip, dependsOn: [{ control: 'ghost', atLeast: 1 }] }] })).toEqual([['control-dependency-invalid', ['clip (no control named ghost)']]]);
    expect(codes({ controls: [{ ...lid, dependsOn: [{ control: 'clip', atMost: 0 }] }, clip] })).toEqual([['control-dependency-invalid', ['lid (depends on itself)', 'clip (depends on itself)']]]);
    expect(codes({ controls: 'too large' })).toEqual([['controls-invalid', undefined]]);
    expect(codes({ controls: [...controls, { ...lid, id: 'second' }] })).toContainEqual(['control-not-rigged', ['second (the build did not rig it)']]);
    const failed = reportOf(edit(clean(), named('action'), { frames: 0, error: 'ValueError: example' }));
    expect(finding(failed, 'action-failed')).toMatchObject({ severity: 'error', subjects: ['open (ValueError: example)'] });
  });

  it('warns when an action moves a control whose dependency is unmet, and flags a contradictory one', () => {
    const unmet = reportOf(edit(clean(), named('action'), { unmetAt: 0.25, unmet: ['clip'] }));
    expect(finding(unmet, 'action-dependency-unmet')).toMatchObject({ severity: 'warning', subjects: ['open (clip at t 0.25)'] });
    const stuck = reportOf(edit(clean(), (event) => event.event === 'sweep-scope' && event.ids[0] === 'clip' && event.kind === 'control', { planned: 1, measured: 1, blocked: 20 }));
    expect(finding(stuck, 'control-unreachable')).toMatchObject({ severity: 'error', subjects: ['clip'] });
  });

  it('leaves a model without controls as it was', () => {
    const report = reportOf(describing({ controls: null, actions: null }));
    expect(report.checks.motion).toBeNull();
    expect(report.publishable).toBe(true);
  });
});

// The sweep's pose plan is plain Python; Blender is only needed to measure it.
const python = process.platform === 'win32' ? 'python' : 'python3';
const hasPython = spawnSync(python, ['--version'], { encoding: 'utf8' }).status === 0;
describe.skipIf(!hasPython)('the sweep plan', () => {
  const plan = (controls, moved) => {
    const script = `import json, sys
sys.dont_write_bytecode = True
sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL('./py', import.meta.url)))})
import portos_model_poses as poses
job = json.load(sys.stdin)
controls, skipped = poses.clean_controls(job["controls"], {"lid", "clip"})
moved = {key: set(value) for key, value in job["moved"].items()}
print(json.dumps({"skipped": skipped, "scopes": list(poses.control_scopes(controls, moved)), "over": [poses.joint_value(controls[0], value) for value in (-0.3, 1.3)]}))`;
    const run = spawnSync(python, ['-c', script], { input: JSON.stringify({ controls, moved }), encoding: 'utf8', timeout: 10_000 });
    expect(run.stderr).toBe('');
    return JSON.parse(run.stdout);
  };
  const { controls } = clean().find(named('described'));
  const [lid, clip] = controls;

  it('steps each control by 0.05, grids a dependent pair, and leaves out what the dependency rules out', () => {
    const { scopes, over } = plan(controls, { lid: ['lid', 'knob'], clip: ['clip'] });
    expect(over).toEqual([0, 110]);
    expect(scopes.map((scope) => [scope.kind, scope.ids, scope.poses.length, scope.blocked])).toEqual([
      ['control', ['lid'], 21, 0], ['control', ['clip'], 21, 0], ['pair', ['lid', 'clip'], 21, 100],
    ]);
    expect(scopes[0].poses[3]).toEqual({ lid: 0.15, clip: 0 });
    expect(scopes[2].poses.every((pose) => pose.clip === 0 || pose.lid <= 0.02)).toBe(true);
  });

  it('moves what a control depends on into range while it sweeps, and leaves an unusable control out', () => {
    const needsOpen = { ...clip, dependsOn: [{ control: 'lid', atLeast: 0.8 }] };
    const { scopes, skipped } = plan([lid, needsOpen, { ...lid, id: 'ghost', partId: 'ghost' }], { lid: ['lid'], clip: ['clip'] });
    expect(skipped).toEqual([['ghost', 'partId names no built part']]);
    expect(scopes[1].poses[0]).toEqual({ lid: 0, clip: 0 });
    expect(scopes[1].poses[20]).toEqual({ lid: 0.8, clip: 1 });
  });

  it('grids controls that move a part in common and not ones that have nothing to do with each other', () => {
    const apart = [lid, { ...clip, dependsOn: undefined }];
    expect(plan(apart, { lid: ['lid'], clip: ['clip'] }).scopes).toHaveLength(2);
    const shared = plan(apart, { lid: ['lid', 'clip'], clip: ['clip'] }).scopes;
    expect(shared[2]).toMatchObject({ kind: 'pair', blocked: 0 });
    expect(shared[2].poses).toHaveLength(121);
  });
});

const testPython = resolveTestPython();
const MODELS_PY = fileURLToPath(new URL('./py', import.meta.url));
const BLENDER = ['/Applications/Blender.app/Contents/MacOS/Blender', '/usr/bin/blender'].find((path) => existsSync(path));

describe('portos_bake_only exclusion in motion rigging and sweep', () => {
  it.skipIf(!testPython)('excludes portos_bake_only meshes from carriers, scene_bounds, rig_model, and Sweep', () => {
    const script = `import json, sys, types
from unittest.mock import MagicMock
sys.dont_write_bytecode = True
sys.path.insert(0, ${JSON.stringify(MODELS_PY)})

class FakeVec(tuple):
    def __new__(cls, vals=(0.0, 0.0, 0.0)):
        vals = tuple(vals)
        return super().__new__(cls, (float(vals[0]), float(vals[1]), float(vals[2])))
    @property
    def x(self): return self[0]
    @property
    def length(self): return sum(v * v for v in self) ** 0.5
    def __sub__(self, other): return FakeVec((self[0] - other[0], self[1] - other[1], self[2] - other[2]))
    def __add__(self, other): return FakeVec((self[0] + other[0], self[1] + other[1], self[2] + other[2]))
    def __mul__(self, scale): return FakeVec((self[0] * scale, self[1] * scale, self[2] * scale))

class FakeMat:
    def __matmul__(self, other):
        return FakeVec(other) if isinstance(other, (FakeVec, tuple)) else self
    def copy(self): return self
    def inverted(self): return self
    def to_3x3(self): return self
    @property
    def translation(self): return FakeVec((0.0, 0.0, 0.0))

class ForeachList(list):
    def foreach_get(self, attr, out): pass

class FakeObj(dict):
    def __init__(self, name, obj_type="MESH", parent=None, bounds=None, bake_only=False):
        super().__init__({"portos_bake_only": True} if bake_only else {})
        self.name, self.type, self.parent = name, obj_type, parent
        self.matrix_world = FakeMat()
        self.matrix_basis = FakeMat()
        self.bound_box = bounds or [(0, 0, 0), (1, 1, 1)]
        self.parent_type = None
        self.parent_bone = None
    def evaluated_get(self, depsgraph):
        if self.get("portos_bake_only"):
            raise AssertionError("bake-only object evaluated in Sweep: " + self.name)
        mesh = MagicMock()
        mesh.vertices = ForeachList([1, 2, 3])
        mesh.loop_triangles = ForeachList([1])
        return types.SimpleNamespace(to_mesh=lambda: mesh, to_mesh_clear=lambda: None)

class FakeArray:
    def __init__(self, shape=(0, 3)): self._shape = shape
    def reshape(self, *shape): return FakeArray((1, 3))
    def astype(self, _): return self
    def __len__(self): return self._shape[0]
    def min(self, axis=None): return FakeVec((0, 0, 0))
    def max(self, axis=None): return FakeVec((1, 1, 1))
    @property
    def T(self): return self
    def __matmul__(self, other): return self
    def __add__(self, other): return self
    def __sub__(self, other): return self
    def __truediv__(self, other): return self
    def __getitem__(self, item): return self

fake_numpy = types.ModuleType("numpy")
fake_numpy.float32 = float
fake_numpy.float64 = float
fake_numpy.int32 = int
fake_numpy.empty = lambda n, dtype=None: FakeArray((n,))
fake_numpy.array = lambda v: FakeArray((1, 3))

mathutils = types.ModuleType("mathutils")
mathutils.Vector = FakeVec
mathutils.Matrix = types.SimpleNamespace(Identity=lambda _: FakeMat(), Translation=lambda _: FakeMat(), Rotation=lambda *_: FakeMat())
bvhtree = types.ModuleType("mathutils.bvhtree")
bvhtree.BVHTree = MagicMock()

box = FakeObj("box", bounds=[(0, 0, 0), (0.3, 0.2, 0.15)])
lid = FakeObj("lid", parent=box, bounds=[(0, 0, 0.15), (0.3, 0.2, 0.17)])
unparented_bolts = FakeObj("bolts", bounds=[(-10, -10, -10), (10, 10, 10)], bake_only=True)
declared_bake = FakeObj("bake_detail", bounds=[(-5, -5, -5), (5, 5, 5)], bake_only=True)
parented_bake = FakeObj("lid_bolts", parent=lid, bounds=[(-5, -5, -5), (5, 5, 5)], bake_only=True)
objects = [box, lid, unparented_bolts, declared_bake, parented_bake]

class FakeBone(dict):
    def __init__(self, name):
        super().__init__()
        self.name, self.parent, self.length, self.matrix_local = name, None, 0.1, FakeMat()
        self.matrix, self.matrix_basis, self.rotation_mode = FakeMat(), FakeMat(), "XYZ"
        self.location, self.rotation_euler = (0, 0, 0), (0, 0, 0)
    def keyframe_insert(self, *a, **k): pass

class BoneMap(dict):
    def __iter__(self): return iter(self.values())
    def new(self, name):
        bone = FakeBone(name)
        self[name] = bone
        store["portos_controls"].data.bones[name] = bone
        store["portos_controls"].pose.bones[name] = bone
        return bone

class ObjStore(dict):
    def new(self, name, data):
        obj = FakeObj(name, obj_type="ARMATURE")
        obj.data = data
        obj.pose = types.SimpleNamespace(bones=BoneMap())
        obj.animation_data = types.SimpleNamespace(
            action=None,
            nla_tracks=types.SimpleNamespace(new=lambda: types.SimpleNamespace(name="", mute=False, strips=types.SimpleNamespace(new=lambda *a: types.SimpleNamespace()))),
        )
        self[name] = obj
        return obj

store = ObjStore({obj.name: obj for obj in objects})

bpy = types.SimpleNamespace(
    context=types.SimpleNamespace(
        object=None,
        scene=types.SimpleNamespace(objects=objects, collection=types.SimpleNamespace(objects=types.SimpleNamespace(link=lambda obj: objects.append(obj))), render=types.SimpleNamespace(fps=24, fps_base=1.0), frame_set=lambda *a, **k: None),
        view_layer=types.SimpleNamespace(objects=types.SimpleNamespace(active=None), update=lambda: None),
        evaluated_depsgraph_get=lambda: None,
    ),
    data=types.SimpleNamespace(
        objects=store,
        armatures=types.SimpleNamespace(new=lambda name: types.SimpleNamespace(bones=BoneMap(), edit_bones=BoneMap())),
        actions=types.SimpleNamespace(new=lambda name: types.SimpleNamespace(fcurves=[], layers=[], slots=[])),
    ),
    ops=types.SimpleNamespace(object=types.SimpleNamespace(mode_set=lambda mode="OBJECT": None)),
)

sys.modules.update({"bpy": bpy, "mathutils": mathutils, "mathutils.bvhtree": bvhtree, "numpy": fake_numpy})
import portos_model_motion as motion
motion.probe = lambda rig, control, action: []

low, high = motion.scene_bounds()
assert tuple(low) == (0.0, 0.0, 0.0) and tuple(high) == (0.3, 0.2, 0.17), (low, high)

description = {
    "parts": [{"id": "box"}, {"id": "lid", "parent": "box"}, {"id": "bake_detail", "parent": "lid"}],
    "controls": [
        {"id": "lid", "type": "hinge", "partId": "lid", "origin": [0, 0.1, 0.15], "axis": [-1, 0, 0], "min": 0, "max": 90, "default": 0},
        {"id": "bad", "type": "slide", "partId": "bake_detail", "origin": [0, 0, 0], "axis": [1, 0, 0], "min": 0, "max": 0.1, "default": 0},
    ],
}
events = []
rig = motion.rig_model(description, lambda ev, **kw: events.append((ev, kw)))
assert ("control-skipped", {"id": "bad", "reason": "partId names no built part"}) in events
assert set(rig.carried) == {"box", "lid"}, rig.carried
assert rig.moved["lid"] == {"lid"}, rig.moved
assert unparented_bolts.parent is None and declared_bake.parent is None and parented_bake.parent is lid

sweep = motion.Sweep(rig, lambda ev, **kw: events.append((ev, kw)), 10)
assert sweep.part_count == 2 and sweep.empty == []
assert sorted(p.name for g in [p for pair in sweep.pairs for p in pair] for p in g.parts) == ["box", "lid"]
print("ok")`;
    expect(execFileSync(testPython, ['-c', script], { encoding: 'utf8', timeout: PY_SUBPROCESS_TIMEOUT_MS }).trim()).toBe('ok');
  }, PY_TEST_TIMEOUT_MS);

  it.skipIf(!BLENDER)('keeps a real Blender model publishable when portos_bake_only detail intersects a moving part sweep', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'blender-motion-bake-only-'));
    try {
      const src = join(tmp, 'src');
      const out = join(tmp, 'out');
      const fixture = readFileSync(new URL('./__fixtures__/box_with_lid.py', import.meta.url), 'utf8');
      const modelPy = `${fixture}
from portos_model import bolt_circle, mark_bake_only
_orig_build = build
def build(ctx):
    _orig_build(ctx)
    # Unparented bolt circle sitting right across the lid's sweep arc.
    bolts = bolt_circle("lid_bolts", 0.05, 6, 0.01, 0.04, location=(0, 0, HEIGHT - 0.01))
    mark_bake_only(bolts, "box")
`;
      const job = join(tmp, 'job.json');
      mkdirSync(src, { recursive: true });
      mkdirSync(out, { recursive: true });
      writeFileSync(join(src, 'model.py'), modelPy);
      writeFileSync(job, JSON.stringify({ mode: 'build', workspace: tmp, src, out, quality: 'draft', sweepSeconds: 30 }));
      const stdout = execFileSync(BLENDER, [
        '--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1',
        '--python', join(MODELS_PY, 'portos_model_driver.py'), '--', job,
      ], { encoding: 'utf8', timeout: 120_000 });
      const facts = collectBlenderModelFacts();
      for (const line of stdout.split('\n')) {
        const parsed = parseBlenderModelDriverLine(line);
        if (parsed) facts.add(parsed);
      }
      const report = buildBlenderModelReport(facts.facts(), {
        modelId: 'bmodel-1', buildId: 'build-1', quality: 'draft', startedAt: null, finishedAt: null, srcHash: 'h', glbBytes: 8000,
      });
      expect(finding(report, 'sweep-overlap')).toBeUndefined();
      expect(report.checks.motion.sweep.clean).toBe(true);
      expect(report.checks.motion.sweep.parts).toBe(4);
      expect(report.publishable).toBe(true);

      const blendCheck = execFileSync(BLENDER, [
        '--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1',
        join(out, 'model.blend'), '--python-expr',
        'import bpy; b = bpy.data.objects["lid_bolts"]; print("PARENT", b.parent is None, bool(b.get("portos_bake_only")))',
      ], { encoding: 'utf8', timeout: 60_000 });
      expect(blendCheck).toContain('PARENT True True');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 130_000);
});
