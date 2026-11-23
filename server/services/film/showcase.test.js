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
