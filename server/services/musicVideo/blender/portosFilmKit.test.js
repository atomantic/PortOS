/**
 * The `portos_film` helpers a Blender film imports (py/portos_film/music.py and
 * timing.py) are pure standard-library Python, so they are checked in a plain
 * interpreter (no Blender needed). They are the film-facing half of the song
 * contract: a wrong beat lookup or envelope sample would put every authored
 * film off the music.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { execFileSync } from '../../../lib/childProcess.js';
import { PY_SUBPROCESS_TIMEOUT_MS, PY_TEST_TIMEOUT_MS, resolveTestPython } from '../../../lib/testHelper.js';

const PY_DIR = fileURLToPath(new URL('./py/', import.meta.url));
const python = resolveTestPython();

const song = {
  durationSec: 20,
  analysis: {
    beats: [1, 2, 3, 4], downbeats: [1],
    sections: [{ label: 'Intro', startSec: 0, endSec: 2.5, energy: 0.2 }, { label: 'Chorus', startSec: 2.5, endSec: 20, energy: 0.9 }],
    features: { envelopes: { fps: 2, rms: [0.1, 0.2, 0.3], low: [0, 1, 0.5], mid: [], high: [0.4] } },
  },
  lyrics: { cues: [
    { index: 0, text: 'An example line', words: [{ w: 'An', startSec: 12.5, endSec: 12.9 }, { w: 'example', startSec: 12.9, endSec: 13.8 }, { w: 'line', startSec: 13.8, endSec: 14.5 }] },
    { index: 1, text: 'Untimed', words: [] },
  ] },
};

const SCRIPT = `
import json, sys
sys.path.insert(0, sys.argv[1])
from portos_film import music, timing
song = json.loads(sys.argv[2])
empty = {}
r = lambda value: round(value, 4)
print(json.dumps({
    "beats_between": music.beats_between(song, 1.5, 3.5),
    "nearest": [music.nearest_beat(song, 2.4), music.nearest_beat(song, 2.6), music.nearest_beat(song, 99), music.nearest_beat(empty, 1)],
    "phase": [list(music.beat_phase(song, 2.5)), list(music.beat_phase(song, 0.5)), list(music.beat_phase(empty, 3))],
    "pulse": [r(music.pulse(song, 2.0, decay=2)), r(music.pulse(song, 2.5, decay=2)), music.pulse(empty, 2.0)],
    "envelope": [r(music.envelope(song, "low", 0.25)), r(music.envelope(song, "low", 0.5)), r(music.envelope(song, "low", 10)),
                 music.envelope(song, "mid", 1), r(music.envelope(song, "high", 3)), music.envelope(song, "nope", 1), music.envelope(empty, "low", 1)],
    "section": [music.section_at(song, 2.4)["label"], music.section_at(song, 2.5)["label"], music.section_at(song, 30)],
    "words": [[w["w"], w["cue"]] for w in music.words_between(song, 12.5, 13.8)],
    "cue_words": [len(music.cue_words(song, 0)), music.cue_words(song, 1), music.cue_words(song, 9)],
    "clamp": [timing.clamp(1.5), timing.clamp(-2), timing.clamp(5, 0, 10)],
    "remap": [timing.remap(5, 0, 10, 0, 100), timing.remap(15, 0, 10, 0, 100), timing.remap(15, 0, 10, 0, 100, clamped=False), timing.remap(1, 3, 3)],
    "ease": [timing.ease(0.5), r(timing.ease(0.25, "in", 2)), r(timing.ease(0.25, "out", 2)), timing.ease(0.25, "linear"), timing.ease(2), r(timing.ease(0.5, "smooth"))],
    "stepped": [r(timing.stepped(0.99, 24, 2)), r(timing.stepped(1.0, 24, 2)), r(timing.stepped(0.99, 24, 1))],
}))
`;

describe.skipIf(!python)('portos_film kit', () => {
  it('reads beats, sections, envelopes and timed words off the song, and eases and steps time', () => {
    const out = JSON.parse(execFileSync(python, ['-c', SCRIPT, PY_DIR, JSON.stringify(song)], { encoding: 'utf8', timeout: PY_SUBPROCESS_TIMEOUT_MS }));
    expect(out).toEqual({
      beats_between: [2, 3],
      nearest: [2, 3, 4, null],
      // (last beat index, how far to the next); before the first beat and without a grid it is the start of beat 0.
      phase: [[1, 0.5], [0, 0], [0, 0]],
      pulse: [1, 0.25, 0],
      // Interpolated between analysis frames, held at the last one, and 0 for a band that is missing or empty.
      envelope: [0.5, 1, 0.5, 0, 0.4, 0, 0],
      section: ['Intro', 'Chorus', null],
      words: [['An', 0], ['example', 0]],
      cue_words: [3, [], []],
      clamp: [1, 0, 5],
      remap: [50, 100, 150, 0],
      ease: [0.5, 0.0625, 0.4375, 0.25, 1, 0.5],
      // On twos at 24 fps a pose holds for 1/12 s.
      stepped: [0.9167, 1, 0.9583],
    });
  }, PY_TEST_TIMEOUT_MS);
});

// Extract the collector without executing the Blender-only entrypoint.
describe.skipIf(!python)('Blender driver imports', () => {
  it('collects sorted relative workspace sources, excluding other modules and bytecode paths', () => {
    const script = `
import ast, importlib.util, json, os, sys
from types import SimpleNamespace
root = os.path.realpath("example-src")
with open(os.path.join(sys.argv[1], "portos_blender_driver.py"), encoding="utf-8") as handle:
    tree = ast.parse(handle.read())
function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "workspace_imports")
exec(compile(ast.Module(body=[function], type_ignores=[]), "collector", "exec"))
sys.modules["example_z"] = SimpleNamespace(__file__=os.path.join(root, "shots", "z.py"))
sys.modules["example_a"] = SimpleNamespace(__file__=os.path.join(root, "a.py"))
sys.modules["example_cached"] = SimpleNamespace(__file__=importlib.util.cache_from_source(os.path.join(root, "cached.py")))
sys.modules["example_duplicate"] = sys.modules["example_a"]
sys.modules["example_outside"] = SimpleNamespace(__file__=os.path.join(root + "-other", "outside.py"))
sys.modules["example_native"] = SimpleNamespace(__file__=os.path.join(root, "native.so"))
sys.modules["example_namespace"] = SimpleNamespace(__file__=None)
print(json.dumps(workspace_imports(root)))
`;
    expect(JSON.parse(execFileSync(python, ['-c', script, PY_DIR], { encoding: 'utf8', timeout: PY_SUBPROCESS_TIMEOUT_MS })))
      .toEqual(['a.py', 'cached.py', 'shots/z.py']);
  }, PY_TEST_TIMEOUT_MS);
});

// Exercise describe -> saved manifest -> render with the real driver and film
// callbacks. Only Blender's scene/render API is doubled; no Blender install is needed.
describe.skipIf(!python)('Blender driver frame grid', () => {
  it('restores exact film-facing boundaries without changing stored manifest times', () => {
    const script = `
import contextlib, io, json, os, runpy, sys, tempfile
from types import SimpleNamespace
sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[1])
driver_path = os.path.join(sys.argv[1], "portos_blender_driver.py")
scene = SimpleNamespace(
    render=SimpleNamespace(image_settings=SimpleNamespace()),
    eevee=SimpleNamespace(), frame_set=lambda frame: None,
)
def render(**kwargs):
    with open(scene.render.filepath, "wb") as handle:
        handle.write(b"frame")
sys.modules["bpy"] = SimpleNamespace(
    app=SimpleNamespace(version=(5, 0, 0)), context=SimpleNamespace(scene=scene),
    ops=SimpleNamespace(wm=SimpleNamespace(read_factory_settings=lambda **kwargs: None),
                        render=SimpleNamespace(render=render)),
)
film_source = """
from portos_film.timing import stepped
built = 0
posed = 0
def describe(ctx):
    return {"shots": [
        {"id": "s%d" % residue,
         "start": ctx.frame_to_seconds(29 * ctx.fps + residue * (ctx.fps + 1)),
         "end": ctx.frame_to_seconds(29 * ctx.fps + residue * (ctx.fps + 1) + 4)}
        for residue in range(ctx.fps)
    ]}
def build_shot(ctx, shot):
    global built
    first = ctx.seconds_to_frame(shot["start"])
    end = ctx.seconds_to_frame(shot["end"])
    assert ctx.shot is shot
    assert shot["start"] == ctx.frame_to_seconds(first), (ctx.fps, first, shot["start"])
    assert shot["end"] == ctx.frame_to_seconds(end)
    built += 1
def frame(ctx, shot, t, frame):
    global posed
    first = ctx.seconds_to_frame(shot["start"])
    assert t >= shot["start"]
    assert stepped(t - shot["start"], ctx.fps) == stepped((frame - first) / ctx.fps, ctx.fps)
    if frame == first:
        assert t == shot["start"]
        assert stepped(t - shot["start"], ctx.fps) == 0
    posed += 1
"""
with tempfile.TemporaryDirectory() as root:
    with open(os.path.join(root, "film.py"), "w", encoding="utf-8") as handle:
        handle.write(film_source)
    with open(os.path.join(root, "song.json"), "w", encoding="utf-8") as handle:
        json.dump({}, handle)
    for fps in (24, 30):
        job = {"mode": "describe", "fps": fps, "width": 640, "height": 360,
               "src": root, "workspace": root, "out": os.path.join(root, "renders")}
        job_path = os.path.join(root, "job.json")
        with open(job_path, "w", encoding="utf-8") as handle:
            json.dump(job, handle)
        sys.argv = [driver_path, "--", job_path]
        with contextlib.redirect_stdout(io.StringIO()):
            driver = runpy.run_path(driver_path)
        manifest_path = os.path.join(root, "manifest.json")
        with open(manifest_path, "rb") as handle:
            stored = handle.read()
        shots = json.loads(stored)["shots"]
        for residue, shot in enumerate(shots):
            first = 29 * fps + residue * (fps + 1)
            assert shot["start"] == round(first / fps, 6)
            assert shot["end"] == round((first + 4) / fps, 6)
        original = json.dumps(shots)
        film = sys.modules["film"]
        job["quality"] = "preview"
        with contextlib.redirect_stdout(io.StringIO()):
            for shot in shots:
                driver["render_shot"](job, film, {}, shot)
        assert film.built == fps
        assert film.posed == fps * 4
        assert json.dumps(shots) == original
        with open(manifest_path, "rb") as handle:
            assert handle.read() == stored
print("ok")
`;
    expect(execFileSync(python, ['-c', script, PY_DIR], { encoding: 'utf8', timeout: PY_SUBPROCESS_TIMEOUT_MS }).trim()).toBe('ok');
  }, PY_TEST_TIMEOUT_MS);
});
