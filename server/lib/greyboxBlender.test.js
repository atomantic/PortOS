import { describe, expect, it } from 'vitest';
import { spawnSync } from './childProcess.js';
import { GREYBOX_BLENDER_PY } from './greyboxBlender.js';

const python = process.platform === 'win32' ? 'python' : 'python3';
const hasPython = spawnSync(python, ['--version'], { encoding: 'utf8' }).status === 0;

// Exercise the real script's final control flow with fake Blender operators.
// No Blender process or real render is started; Python is optional on the host.
const SCENE_ONLY_HARNESS = String.raw`
import json, os, pathlib, sys, tempfile, time
from types import SimpleNamespace

source = sys.stdin.read()
anchor = "fly = job.get('flythrough')\nif fly:\n"
assert anchor in source
prefix, suffix = source.rsplit(anchor, 1)
assert 'bpy.ops.render.render(' not in prefix
script = anchor + suffix

for scene_only, shots, expected_renders in [(True, [], 0), (True, ['wide'], 0), (False, ['wide'], 1)]:
    with tempfile.TemporaryDirectory() as out:
        renders = []
        wm = SimpleNamespace(save_as_mainfile=lambda filepath: pathlib.Path(filepath).write_bytes(b'BLENDER'))
        render = SimpleNamespace(render=lambda **kwargs: renders.append(kwargs))
        bpy = SimpleNamespace(ops=SimpleNamespace(wm=wm, render=render))
        scene = SimpleNamespace(render=SimpleNamespace(resolution_x=64, resolution_y=64))
        env = dict(job=dict(sceneOnly=scene_only, shotIds=shots, flythrough=None, engine='CYCLES', samples=8),
            fly_camera=lambda fly: None, use_shot=lambda shot: None, bpy=bpy, scene=scene, out=out,
            os=os, json=json, time=time, portos_version=lambda: '5.2.3', device='CPU', backend='CPU', grey=dict(parts=[]))
        exec(compile(script, '<greybox-blender>', 'exec'), env)
        report = json.loads(pathlib.Path(out, 'report.json').read_text())
        assert pathlib.Path(out, 'blockout.blend').read_bytes() == b'BLENDER'
        assert len(renders) == expected_renders
        assert bool(report.get('sceneOnly')) == scene_only
`;

describe('greybox Blender scene-only build', () => {
  it.skipIf(!hasPython)('saves without rendering and leaves ordinary camera renders intact', () => {
    const result = spawnSync(python, ['-c', SCENE_ONLY_HARNESS], { input: GREYBOX_BLENDER_PY, encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
  });
});
