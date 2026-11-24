/**
 * The showcase starter's plan (py/showcase/kit/plan.py, standard library only): its shots tile any
 * timeline into a valid manifest, every shot is a pure function of time, and the natural length the
 * server writes into the timeline matches what the plan expects.
 */
import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from '../../lib/childProcess.js';
import { resolveTestPython, PY_SUBPROCESS_TIMEOUT_MS, PY_TEST_TIMEOUT_MS } from '../../lib/testHelper.js';
import { validateBlenderManifest, blenderFilmProblems } from './manifest.js';
import { buildShowcaseData, showcaseDurationSec } from '../codeAnimation/showcase.js';

const PY = fileURLToPath(new URL('./py/', import.meta.url));
const SHOWCASE = fileURLToPath(new URL('./py/showcase/', import.meta.url));

const lamp = { name: 'Lamp', cameras: [
  { id: 'c1', label: 'Front', view: 'front', orbit: null },
  { id: 'c2', label: 'Shade', view: null, orbit: { azimuth: 60, elevation: 20, distance: 0.5, lens: 85, target: [0, 0, 0.45] } },
] };
const lampReport = {
  describe: { sizeMeters: { x: 0.22, y: 0.22, z: 0.52 }, parts: [{ id: 'base' }, { id: 'stem', parent: 'base' }, { id: 'shade', parent: 'stem' }] },
  checks: { parts: { centers: { base: [0, 0, 0.01], stem: [0, 0, 0.2], shade: [0, 0, 0.45] } }, motion: {
    controls: [{ id: 'tilt', label: 'Tilt', partId: 'shade', default01: 0.5 }, { id: 'lift', label: 'Lift', partId: 'stem', default01: 0, dependsOn: [{ control: 'tilt', atLeast: 0.2, atMost: 0.4 }] }],
    actions: [{ id: 'wave', seconds: 2 }],
  } },
};
const full = buildShowcaseData(lamp, lampReport, { sheet: 'showcase/sheet.png' });
const bare = buildShowcaseData({ name: 'Box', cameras: [] }, { describe: { sizeMeters: { x: 1, y: 1, z: 1 }, parts: [{ id: 'box' }] }, checks: {} });

// Runs `plan` over each case: describe at several timeline lengths (with and without downbeats) and every pose twice, in two orders.
const SCRIPT = `
import json, sys, random, tempfile, os
sys.path.insert(0, sys.argv[1]); sys.path.insert(0, sys.argv[2])
from types import SimpleNamespace
from kit import plan
out = []
for data in json.loads(sys.argv[3]):
    for duration, beats in ((plan.natural_total(data), []), (7.3, []), (61.0, [1.7 * i for i in range(1, 36)])):
        ctx = SimpleNamespace(options={}, fps=24, song={"durationSec": duration, "analysis": {"downbeats": beats}})
        shots = plan.layout(ctx, data)
        options = plan.read_options({})
        frames = [(shot, f / 24.0) for shot in shots for f in range(round(shot["start"] * 24), round(shot["end"] * 24), 3)]
        forward = [json.dumps(plan.pose(data, options, shot, t, 16 / 9), sort_keys=True) for shot, t in frames]
        order = list(range(len(frames))); random.Random(4).shuffle(order)
        shuffled = {i: json.dumps(plan.pose(data, options, frames[i][0], frames[i][1], 16 / 9), sort_keys=True) for i in order}
        out.append({"duration": duration, "shots": shots, "natural": plan.natural_total(data), "pure": all(forward[i] == shuffled[i] for i in order), "poses": len(forward)})
print(json.dumps(out))
`;

it('tiles any timeline into valid shots and poses every shot as a pure function of time', async () => {
  const { stdout } = await promisify(execFile)(resolveTestPython(), ['-I', '-c', SCRIPT, PY, SHOWCASE, JSON.stringify([full, bare])], { timeout: PY_SUBPROCESS_TIMEOUT_MS });
  const runs = JSON.parse(stdout);
  expect(runs).toHaveLength(6);
  for (const run of runs) {
    const timeline = { durationSec: run.duration, fps: 24 };
    const checked = validateBlenderManifest({ title: 't', shots: run.shots.map(({ id, label, start, end }) => ({ id, label, start, end })) }, timeline);
    expect(checked.errors).toEqual([]);
    expect(blenderFilmProblems({ ...checked.manifest, fps: 24 }, timeline)).toEqual([]);
    expect(run.pure).toBe(true);
    expect(run.poses).toBeGreaterThan(10);
  }
  // Full film: turntable, assembly, controls, two close-ups, reference. A bare model: turntable and assembly.
  expect(runs[0].shots.map(shot => shot.kind)).toEqual(['turntable', 'assembly', 'controls', 'closeup:c1', 'closeup:c2', 'reference']);
  expect(runs[3].shots.map(shot => shot.kind)).toEqual(['turntable', 'assembly']);
  // The server writes the film's length from the same natural lengths the plan uses.
  expect(runs[0].natural).toBe(showcaseDurationSec(full));
  expect(runs[3].natural).toBe(showcaseDurationSec(bare));
  // With downbeats, inner boundaries land on a bar (to the nearest frame).
  const beats = Array.from({ length: 35 }, (_, i) => 1.7 * (i + 1));
  for (const shot of runs[2].shots.slice(1)) expect(beats.some(beat => Math.abs(beat - shot.start) <= 1 / 48 + 1e-6)).toBe(true);
}, PY_TEST_TIMEOUT_MS);

// A 30 x 20 x 16 cm box whose lid hinges at the back edge to 100 degrees, with a drawer that slides out by a control and, farther, by an
// action. The fake stage stands in for Blender with that model's real kinematics; film.py and plan.py run as they do in a render.
const hinged = buildShowcaseData({ name: 'Box', cameras: [] }, {
  describe: { sizeMeters: { x: 0.3, y: 0.2, z: 0.16 }, parts: [{ id: 'box' }, { id: 'lid', parent: 'box' }, { id: 'drawer', parent: 'box' }] },
  checks: { parts: { centers: {} }, motion: {
    controls: [{ id: 'lid', partId: 'lid', default01: 0 }, { id: 'drawer', partId: 'drawer', default01: 0, dependsOn: [{ control: 'lid', atLeast: 0.4, atMost: 0.6 }] }],
    actions: [{ id: 'pull', seconds: 2 }],
  } },
});
const CONTROLS_SCRIPT = `
import json, math, sys
sys.path.insert(0, sys.argv[1]); sys.path.insert(0, sys.argv[2])
from types import SimpleNamespace
import kit
import film
data = json.loads(sys.argv[3])
film.plan.load = lambda src: data

def box(low, high):
    return [(x, y, z) for x in (low[0], high[0]) for y in (low[1], high[1]) for z in (low[2], high[2])]

def corners(stage, pose):
    angle = math.radians(100.0 * pose["controls"]["lid"])
    out = 0.15 * pose["controls"]["drawer"] + (0.3 * pose["action"]["seconds"] / 2.0 if pose["action"] else 0.0)
    lid = [(x, 0.1 + (y - 0.1) * math.cos(angle) + (z - 0.15) * math.sin(angle), 0.15 - (y - 0.1) * math.sin(angle) + (z - 0.15) * math.cos(angle))
           for x, y, z in box((-0.15, -0.1, 0.15), (0.15, 0.1, 0.16))]
    return box((-0.15, -0.1, 0.0), (0.15, 0.1, 0.15)) + lid + box((-0.14 + out, -0.09, 0.02), (0.14 + out, 0.09, 0.1))

seen = {}
kit.stage = SimpleNamespace(build=lambda *args: SimpleNamespace(), corners=corners, pose=lambda stage, ctx, pose: seen.update(pose=pose))
out = []
for width, height in ((480, 270), (270, 480), (400, 400)):
    ctx = SimpleNamespace(src="", options={}, fps=24, width=width, height=height, song={"durationSec": film.plan.natural_total(data)})
    shot = next(item for item in film.plan.layout(ctx, data) if item["kind"] == "controls")
    film.build_shot(ctx, shot)
    reach = {"edge": 0.0, "lidMost": 0.0, "lidLeast": 1.0, "drawerMost": 0.0, "pulled": 0.0}
    cameras = set()
    half = 18.0 / 50.0
    for index in range(round(shot["start"] * 24), round(shot["end"] * 24)):
        film.frame(ctx, shot, index / 24.0, index)
        pose = seen["pose"]
        cam = pose["camera"]
        for point in corners(None, pose):
            offset = [point[axis] - cam["location"][axis] for axis in range(3)]
            along = lambda name: sum(offset[axis] * cam[name][axis] for axis in range(3))
            depth = -along("back")
            across = max(abs(along("right")) / depth / (half * min(1.0, width / height)), abs(along("up")) / depth / (half * min(1.0, height / width)))
            reach["edge"] = max(reach["edge"], across)
        reach["lidMost"] = max(reach["lidMost"], pose["controls"]["lid"])
        reach["lidLeast"] = min(reach["lidLeast"], pose["controls"]["lid"])
        reach["drawerMost"] = max(reach["drawerMost"], pose["controls"]["drawer"])
        reach["pulled"] = max(reach["pulled"], pose["action"]["seconds"] if pose["action"] else 0.0)
        cameras.add(tuple(round(value, 9) for value in cam["target"]))
    out.append({**reach, "targets": len(cameras)})
print(json.dumps(out))
`;

it('keeps every part in frame through the controls shot, from closed to fully open', async () => {
  const { stdout } = await promisify(execFile)(resolveTestPython(), ['-I', '-c', CONTROLS_SCRIPT, PY, SHOWCASE, JSON.stringify(hinged)], { timeout: PY_SUBPROCESS_TIMEOUT_MS });
  for (const run of JSON.parse(stdout)) {
    // The frames checked include both extremes of the lid and the drawer, and the whole action.
    expect(run.lidLeast).toBe(0);
    expect(run.lidMost).toBeGreaterThan(0.99);
    expect(run.drawerMost).toBeGreaterThan(0.99);
    expect(run.pulled).toBeGreaterThan(1.9);
    // 1 is the frame's edge: nothing reaches it, and the model still fills a good part of the frame.
    expect(run.edge).toBeLessThan(1);
    expect(run.edge).toBeGreaterThan(0.6);
    // One framing for the whole shot: the camera sweeps around it and never jumps between poses.
    expect(run.targets).toBe(1);
  }
}, PY_TEST_TIMEOUT_MS);
