/**
 * A showcase film of a model with clips (#18110): Blender's glTF importer leaves the first clip active,
 * so every scene-time step and render replays it unless the stage stops it. Only Controls may move parts.
 * CI has no Blender: the first test doubles Blender's animation behavior, the second imports a real GLB.
 */
import { expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from '../../lib/childProcess.js';
import { resolveTestPython, PY_SUBPROCESS_TIMEOUT_MS, PY_TEST_TIMEOUT_MS } from '../../lib/testHelper.js';

const PY = fileURLToPath(new URL('./py/', import.meta.url));
const SHOWCASE = join(PY, 'showcase');
const MODELS_PY = fileURLToPath(new URL('../blenderModels/py/', import.meta.url));
const BLENDER = ['/Applications/Blender.app/Contents/MacOS/Blender', '/usr/bin/blender'].find(path => existsSync(path));
const python = resolveTestPython();

// The first clip starts with the foot 0.3 m below its default, so a model measured in that pose stands 0.3 m too high.
const showcase = {
  title: 'Box', size: { x: 1, y: 0.8, z: 0.56 }, sheet: 'sheet.png',
  parts: [{ id: 'body', center: [0, 0, 0.25] }, { id: 'lid', center: [0, 0, 0.53] }, { id: 'foot', center: [0, 0, 0.1] }],
  controls: [{ id: 'foot', default01: 1 }, { id: 'lid', default01: 0 }], actions: [{ id: 'open', seconds: 2 }], cameras: [],
};

// Drives every shot through film.py; `sample()` is what one rendered frame shows: [lid angle in degrees, foot drop in meters].
const DRIVE = `
import json
from types import SimpleNamespace
import film
from kit import plan, stage
FPS = 12
def drive(ctx, start_scene, sample):
    out = {}
    for shot in film.describe(ctx)["shots"]:
        scene = start_scene()
        film.build_shot(ctx, shot)
        first, end = round(shot["start"] * FPS), round(shot["end"] * FPS)
        rows = []
        for frame in list(range(first, end, max(1, (end - first) // 8))) + [first]:
            scene.frame_set(frame)
            film.frame(ctx, shot, frame / FPS, frame)
            rows.append([round(value, 2) for value in sample()])
        out[film.current["entry"]["kind"]] = {"rows": rows, "rootZ": round(film.current["stage"].root.location.z, 3)}
    print("SHOWCASE " + json.dumps(out), flush=True)
def context(src):
    ctx = SimpleNamespace(options={}, fps=FPS, width=16, height=8, src=src, song={})
    ctx.song["durationSec"] = plan.natural_total(plan.load(src))
    return ctx
`;

const FAKE = `
import sys
from types import SimpleNamespace as N
from unittest.mock import MagicMock
sys.dont_write_bytecode = True
PY, SHOWCASE, SRC = sys.argv[1:4]
sys.path[:0] = [PY, SHOWCASE]
bpy = MagicMock()
sys.modules["bpy"] = bpy
sys.modules["mathutils"] = MagicMock()
class Action:
    def __init__(self, name, curves): self.name, self.curves = name, curves
class Rig:
    def __init__(self, **fields): self.__dict__.update(fields)
def ramp(a, b, end): return lambda frame: a + (b - a) * max(0.0, min(1.0, frame / end))
CLIPS = [
    Action("action:open", {"lid": ramp(0.0, 80.0, 24), "foot": ramp(-0.3, 0.0, 24)}),
    Action("control:foot", {"foot": ramp(-0.3, 0.0, 12)}), Action("control:lid", {"lid": ramp(0.0, 80.0, 12)}),
]
world = N(rig=None)
def evaluate(frame):
    if world.rig is not None and world.rig.animation_data.action is not None:
        world.rig.pose.update({key: curve(frame) for key, curve in world.rig.animation_data.action.curves.items()})
class Scene(MagicMock):
    def frame_set(self, frame, subframe=0.0):
        self.frame_current_final = frame + subframe
        evaluate(self.frame_current_final)
def import_model(**kwargs):
    # As the real importer: every clip on its own muted track, the first one left active.
    tracks = [N(name=clip.name, strips=[N(action=clip, action_slot=None)]) for clip in CLIPS]
    world.rig = Rig(type="EMPTY", pose={"lid": 0.0, "foot": 0.0}, users_collection=[], parent=None, animation_data=N(action=CLIPS[0], nla_tracks=tracks))
    bpy.data.objects.append(world.rig)
class Objects(list):
    def new(self, *args): return MagicMock(animation_data=None, location=N(x=0.0, y=0.0, z=0.0))
    def get(self, name): return None
bpy.ops.import_scene.gltf = import_model
def start_scene():
    scene = Scene()
    scene.render.fps, scene.render.fps_base = 12, 1.0
    scene.frame_current_final = 1
    bpy.context.scene = scene
    bpy.data.objects = Objects()
    bpy.data.actions = []
    bpy.context.view_layer.update = lambda: evaluate(scene.frame_current_final)
    return scene
${DRIVE}
from portos_film import models
models._world_bounds = lambda objects: (N(z=world.rig.pose["foot"]), N(z=0.56))
for name in ("_sky", "_plane", "_material", "_ring_outline", "_build_sheet", "_light", "_label", "_aim"):
    setattr(stage, name, MagicMock())
def sample():
    evaluate(bpy.context.scene.frame_current_final)  # a render evaluates the scene again
    return [world.rig.pose["lid"], world.rig.pose["foot"]]
drive(context(SRC), start_scene, sample)
`;

const REAL = `
import ast, math, os, sys
sys.dont_write_bytecode = True
PY, SHOWCASE, SRC, MODELS_PY = sys.argv[-4:]
sys.path[:0] = [PY, SHOWCASE, MODELS_PY]
import bpy
import portos_model_motion as motion
# The published GLB's own exporter; importing the model driver would start a build.
driver = ast.parse(open(os.path.join(MODELS_PY, "portos_model_driver.py"), encoding="utf-8").read())
export = [node for node in driver.body if isinstance(node, ast.FunctionDef) and node.name == "export_glb"]
exec(compile(ast.Module(body=export, type_ignores=[]), "export_glb", "exec"))
def make(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = 24
    def box(name, size, at):
        bpy.ops.mesh.primitive_cube_add(size=1, location=at)
        made = bpy.context.object
        made.name, made.scale = name, size
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        return made
    box("body", (1, .8, .5), (0, 0, .25))
    lid, foot = box("lid", (1, .8, .06), (0, 0, .53)), box("foot", (.2, .2, .2), (0, 0, .1))
    rig = motion.rig_model({"parts": [{"id": "body"}, {"id": "lid"}, {"id": "foot"}], "controls": [
        {"id": "foot", "type": "slide", "partId": "foot", "origin": [0, 0, 0], "axis": [0, 0, 1], "min": -0.3, "max": 0, "default": 0},
        {"id": "lid", "type": "hinge", "partId": "lid", "origin": [0, 0.4, 0.5], "axis": [-1, 0, 0], "min": 0, "max": 80, "default": 0},
    ]}, lambda event, **fields: None)
    motion.new_action(rig, "action:open", [(0, {"lid": 0.0, "foot": 0.0}), (48, {"lid": 1.0, "foot": 1.0})])
    export_glb(path, True)
make(os.path.join(SRC, "models", "model.glb"))
bpy.data.images.new("sheet", 8, 8).save(filepath=os.path.join(SRC, "sheet.png"))
def start_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps, scene.render.engine = 12, "CYCLES"
    scene.cycles.samples = 1
    scene.render.resolution_x, scene.render.resolution_y = 16, 8
    scene.render.filepath = os.path.join(SRC, "frame.png")
    return scene
${DRIVE}
def sample():
    bpy.ops.render.render()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    lid, foot, body = (bpy.data.objects[name].evaluated_get(depsgraph).matrix_world for name in ("lid", "foot", "body"))
    return [math.degrees(lid.to_quaternion().angle), foot.translation.z - body.translation.z + .15]
drive(context(SRC), start_scene, sample)
`;

function run(command, args, script, timeout) {
  const src = mkdtempSync(join(tmpdir(), 'showcase-motion-'));
  try {
    writeFileSync(join(src, 'showcase.json'), JSON.stringify(showcase));
    // models.load only checks the file is there; the real script overwrites it with the exported GLB.
    mkdirSync(join(src, 'models'));
    writeFileSync(join(src, 'models', 'model.glb'), '');
    const file = join(src, 'drive.py');
    writeFileSync(file, script);
    const stdout = execFileSync(command, [...args, file, ...(args.length ? ['--'] : []), PY, SHOWCASE, src, MODELS_PY], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(stdout.split('\n').find(line => line.startsWith('SHOWCASE ')).slice(9));
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
}

function expectOnlyControlsMove(shots) {
  expect(Object.keys(shots)).toEqual(['turntable', 'assembly', 'controls', 'reference']);
  for (const kind of ['turntable', 'assembly', 'reference']) {
    for (const [lid, foot] of shots[kind].rows) {
      expect(lid, kind).toBeCloseTo(0, 1);
      expect(foot, kind).toBeCloseTo(0, 1);
    }
    expect(shots[kind].rootZ, kind).toBeCloseTo(0, 2);
  }
  const { rows } = shots.controls;
  expect(Math.max(...rows.map(([lid]) => lid))).toBeGreaterThan(40);
  expect(Math.min(...rows.map(([, foot]) => foot))).toBeLessThan(-0.2);
  // Frames are independent: the first one rendered again after the last is the same.
  expect(rows.at(-1)).toEqual(rows[0]);
}

it.skipIf(!python)('holds the default pose outside Controls when the importer leaves a clip active', () => {
  expectOnlyControlsMove(run(python, [], FAKE, PY_SUBPROCESS_TIMEOUT_MS));
}, PY_TEST_TIMEOUT_MS);

it.skipIf(!BLENDER)('holds the default pose outside Controls with a real imported GLB', () => {
  expectOnlyControlsMove(run(BLENDER, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python'], REAL, 120000));
}, 130000);
