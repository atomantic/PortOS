"""List a code film's shots without Blender.

PortOS runs this with system Python when src/film.py and the modules it imports
do not touch bpy, bmesh or mathutils. A Blender film still goes through
portos_blender_driver.py. This file must not import bpy.

    python3 portos_film_describe.py -- job.json

The film only has to define describe(ctx). The manifest is written to the path
in job["manifestOut"] (chosen by PortOS, never by the film). Progress uses the
same PORTOS_BLENDER line protocol as the Blender driver.
"""

import importlib.util
import json
import math
import os
import sys
import traceback
from types import SimpleNamespace

PREFIX = "PORTOS_BLENDER "
GRID_TOLERANCE = 1e-3


def emit(event, **fields):
    sys.stdout.write(PREFIX + json.dumps({"event": event, **fields}) + "\n")
    sys.stdout.flush()


def log(message):
    sys.stdout.write(str(message) + "\n")
    sys.stdout.flush()


def half_up(value):
    return int(math.floor(value + 0.5))


def even_pixels(value):
    rounded = half_up(value)
    return max(2, rounded - rounded % 2)


def read_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def snap_to_grid(seconds, fps):
    if not isinstance(seconds, (int, float)) or isinstance(seconds, bool):
        return seconds
    snapped = half_up(seconds * fps) / fps
    return round(snapped, 6) if abs(snapped - seconds) <= GRID_TOLERANCE else seconds


def load_song(job, job_path):
    staged = os.path.join(os.path.dirname(job_path), "song.json")
    path = staged if os.path.isfile(staged) else job.get("songPath")
    if not path or not os.path.isfile(path):
        raise RuntimeError("song.json is missing: PortOS writes it before every job")
    return read_json(path)


def load_film(src):
    path = os.path.join(src, "film.py")
    if not os.path.isfile(path):
        raise RuntimeError("src/film.py is missing: a code film defines describe(ctx) there")
    if src not in sys.path:
        sys.path.insert(0, src)
    spec = importlib.util.spec_from_file_location("film", path)
    film = importlib.util.module_from_spec(spec)
    sys.modules["film"] = film
    spec.loader.exec_module(film)
    if not callable(getattr(film, "describe", None)):
        raise RuntimeError("src/film.py must define describe")
    return film


def make_context(job, song):
    fps = job["fps"]
    scale = job.get("scale", 1)
    options = job.get("options")
    return SimpleNamespace(
        song=song,
        options=dict(options) if isinstance(options, dict) else {},
        fps=fps,
        scale=scale,
        width=even_pixels(job["width"] * scale),
        height=even_pixels(job["height"] * scale),
        samples=job.get("samples", 16),
        quality="describe",
        engine=job.get("engine", "BLENDER_EEVEE_NEXT"),
        workspace=job["workspace"],
        src=job["src"],
        out_dir=job["out"],
        shot=None,
        log=log,
        seconds_to_frame=lambda seconds: half_up(seconds * fps),
        frame_to_seconds=lambda frame: frame / fps,
    )


def describe(job, film, song, job_path):
    manifest = film.describe(make_context(job, song))
    if not isinstance(manifest, dict) or not isinstance(manifest.get("shots"), list):
        raise RuntimeError("describe(ctx) must return a dict with a 'shots' list")
    for shot in manifest["shots"]:
        if isinstance(shot, dict):
            for key in ("start", "end"):
                shot[key] = snap_to_grid(shot.get(key), job["fps"])
            handles = shot.get("handles")
            if isinstance(handles, dict):
                for side in ("in", "out"):
                    if handles.get(side) is not None:
                        handles[side] = snap_to_grid(handles.get(side), job["fps"])
    target = job.get("manifestOut")
    if not target:
        raise RuntimeError("job.json has no manifestOut")
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle)
    # The path on this line is a label. PortOS reads the manifestOut it chose.
    emit("manifest", path="manifest.json")


def main():
    sys.dont_write_bytecode = True
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    if "--" not in sys.argv:
        raise SystemExit("missing -- job.json")
    job_path = sys.argv[sys.argv.index("--") + 1]
    job = read_json(job_path)
    try:
        film = load_film(job["src"])
        song = load_song(job, job_path)
        describe(job, film, song, job_path)
    except Exception as error:  # noqa: BLE001 — the film's own failure is the job result
        emit("error", message=str(error), traceback=traceback.format_exc())
        raise


if __name__ == "__main__":
    main()
