"""PortOS Blender film driver.

Runs inside Blender (4.2 or newer), started by PortOS:

    blender --background --factory-startup --disable-autoexec --python-exit-code 1 \
        --python portos_blender_driver.py -- job.json

It loads a project's film (`<src>/film.py`) and either lists its shots
(`mode: "describe"`) or renders shots frame by frame (`mode: "render"`). The
film contract and the job fields are documented in
docs/features/music-video-blender.md. Films never import PortOS server code;
the helpers they may import live beside this file in `portos_film`.

Every film call receives a context `ctx`. Besides the song and the frame
settings it carries `ctx.options`: a dict of the film's options, keyed by the
`key` each one was declared with in `describe(ctx)["options"]`. A value is the
option's declared default unless the operator saved another one in PortOS.
During the first sync nothing is declared yet, so `describe` should read an
option with a fallback: `ctx.options.get("palette", "dusk")`. A render records
the options it was built with; changing one marks every render out of date.

Progress goes to stdout as one JSON object per line, prefixed with
`PORTOS_BLENDER `. Every other line is free-form log text.
"""

import importlib.util
import json
import math
import os
import sys
import time
import traceback
from types import SimpleNamespace

import bpy

PREFIX = "PORTOS_BLENDER "
GRID_TOLERANCE = 1e-3


def emit(event, **fields):
    # Flushed per line: Blender block-buffers a piped stdout, and the server
    # reads these lines while the render is still running.
    sys.stdout.write(PREFIX + json.dumps({"event": event, **fields}) + "\n")
    sys.stdout.flush()


def log(message):
    sys.stdout.write(str(message) + "\n")
    sys.stdout.flush()


def blender_version():
    return "%d.%d.%d" % tuple(bpy.app.version)


def half_up(value):
    return int(math.floor(value + 0.5))


def even_pixels(value):
    rounded = half_up(value)
    return max(2, rounded - rounded % 2)


def read_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def load_song(job, job_path):
    # The copy staged beside the job is the one this job was started with.
    staged = os.path.join(os.path.dirname(job_path), "song.json")
    path = staged if os.path.isfile(staged) else job.get("songPath")
    if not path or not os.path.isfile(path):
        raise RuntimeError("song.json is missing: PortOS writes it before every job")
    return read_json(path)


def load_film(src):
    path = os.path.join(src, "film.py")
    if not os.path.isfile(path):
        raise RuntimeError("src/film.py is missing: a film defines describe(ctx) and build_shot(ctx, shot) there")
    # The film's own folders (kit/, shots/, ...) import as packages from src/.
    if src not in sys.path:
        sys.path.insert(0, src)
    spec = importlib.util.spec_from_file_location("film", path)
    film = importlib.util.module_from_spec(spec)
    sys.modules["film"] = film
    spec.loader.exec_module(film)
    for name in ("describe", "build_shot"):
        if not callable(getattr(film, name, None)):
            raise RuntimeError("src/film.py must define %s" % name)
    return film


def workspace_imports(src):
    """Imported source paths only; real paths exclude modules outside src/."""
    root = os.path.realpath(src)
    paths = set()
    for module in list(sys.modules.values()):
        file = getattr(module, "__file__", None)
        if not isinstance(file, str):
            continue
        path = os.path.realpath(file)
        if path.endswith((".pyc", ".pyo")):
            try:
                path = importlib.util.source_from_cache(path)
            except ValueError:
                path = path[:-1]
        try:
            inside = os.path.commonpath([root, path]) == root
        except ValueError:  # Different drives on Windows.
            inside = False
        if path.endswith(".py") and inside:
            paths.add(os.path.relpath(path, root).replace(os.sep, "/"))
    return sorted(paths)


def blender_engine(engine):
    # PortOS keeps Blender 4's id for EEVEE; Blender 5 named it BLENDER_EEVEE again.
    if engine != "BLENDER_EEVEE_NEXT":
        return engine
    return "BLENDER_EEVEE_NEXT" if bpy.app.version < (5, 0, 0) else "BLENDER_EEVEE"


def make_context(job, song, quality, shot=None):
    fps = job["fps"]
    scale = job.get("scale", 1)
    options = job.get("options")
    return SimpleNamespace(
        song=song,
        # A fresh dict per call site: a film that edits it cannot change what the next shot reads.
        options=dict(options) if isinstance(options, dict) else {},
        fps=fps,
        scale=scale,
        width=even_pixels(job["width"] * scale),
        height=even_pixels(job["height"] * scale),
        samples=job.get("samples", 16),
        quality=quality,
        engine=blender_engine(job.get("engine", "BLENDER_EEVEE_NEXT")),
        workspace=job["workspace"],
        src=job["src"],
        out_dir=job["out"],
        shot=shot,
        log=log,
        seconds_to_frame=lambda seconds: half_up(seconds * fps),
        frame_to_seconds=lambda frame: frame / fps,
    )


def snap_to_grid(seconds, fps):
    """The nearest frame boundary when `seconds` is within tolerance of it; else unchanged, for the server to refuse."""
    if not isinstance(seconds, (int, float)) or isinstance(seconds, bool):
        return seconds
    snapped = half_up(seconds * fps) / fps
    return round(snapped, 6) if abs(snapped - seconds) <= GRID_TOLERANCE else seconds


def describe(job, film, song):
    ctx = make_context(job, song, "describe")
    manifest = film.describe(ctx)
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
    target = job.get("manifestOut") or os.path.join(os.environ.get("PORTOS_WORKER_OUTPUT", job["workspace"]), "manifest.json")
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle)
    emit("manifest", path=target)


def use_cycles_gpu(scene):
    """Render Cycles on the first available GPU backend; returns the device label."""
    preferences = bpy.context.preferences.addons["cycles"].preferences
    for kind in ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI"):
        try:
            preferences.compute_device_type = kind
        except TypeError:
            continue
        preferences.get_devices()
        if any(device.type != "CPU" for device in preferences.devices):
            for device in preferences.devices:
                device.use = device.type != "CPU"
            scene.cycles.device = "GPU"
            return kind
    scene.cycles.device = "CPU"
    return "CPU"


def apply_frame_settings(scene, ctx):
    scene.render.resolution_x = ctx.width
    scene.render.resolution_y = ctx.height
    scene.render.resolution_percentage = 100
    scene.render.fps = ctx.fps
    scene.render.fps_base = 1.0


def apply_output_format(scene, quality):
    settings = scene.render.image_settings
    if hasattr(settings, "media_type"):
        settings.media_type = "IMAGE"
    if quality in ("preview", "sheet"):
        settings.file_format = "JPEG"
        settings.quality = 90
    else:
        settings.file_format = "PNG"
        settings.color_depth = "8"
    settings.color_mode = "RGB"
    scene.render.use_file_extension = True
    scene.render.use_overwrite = True


def apply_render_stamp(scene, frame, fps, height):
    r = scene.render
    r.use_stamp = True
    for attr in (
        "use_stamp_date", "use_stamp_time", "use_stamp_render_time", "use_stamp_frame",
        "use_stamp_frame_range", "use_stamp_memory", "use_stamp_hostname", "use_stamp_camera",
        "use_stamp_lens", "use_stamp_scene", "use_stamp_strip_meta", "use_stamp_marker",
        "use_stamp_sequencer_strip", "use_stamp_filename", "use_stamp_labels",
    ):
        if hasattr(r, attr):
            setattr(r, attr, False)
    r.use_stamp_note = True
    r.stamp_note_text = "f%d  %.2fs" % (frame, frame / fps)
    r.stamp_font_size = max(16, round(height / 24))
    r.stamp_foreground = (1.0, 1.0, 1.0, 1.0)
    r.stamp_background = (0.0, 0.0, 0.0, 0.75)


def frame_file(job, shot, frame, quality):
    shot_dir = os.path.join(job["out"], shot["id"])
    if quality == "still":
        return os.path.join(shot_dir, "stills", "t%09d.png" % half_up(frame / job["fps"] * 1000))
    if quality == "sheet":
        return os.path.join(shot_dir, "sheets", job.get("framesDir") or ".frames", "frame_%06d.jpg" % frame)
    extension = "jpg" if quality == "preview" else "png"
    return os.path.join(shot_dir, quality, "frames", "frame_%06d.%s" % (frame, extension))


def handle_frame_file(job, shot, side, frame, quality):
    shot_dir = os.path.join(job["out"], shot["id"])
    extension = "jpg" if quality == "preview" else "png"
    return os.path.join(shot_dir, quality, "frames", "handle_%s_%06d.%s" % (side, frame, extension))


def render_frame(scene, path):
    # Written beside the target and renamed, so a killed render never leaves a
    # truncated frame that a resumed job would take for finished.
    stem, extension = os.path.splitext(path)
    partial = stem + ".part" + extension
    scene.render.filepath = partial
    bpy.ops.render.render(write_still=True)
    if not os.path.isfile(partial):
        raise KeyboardInterrupt("Render interrupted before the frame was written")
    os.replace(partial, path)


def render_shot(job, film, song, shot):
    quality = job["quality"]
    fps = job["fps"]
    first = half_up(shot["start"] * fps)
    end = half_up(shot["end"] * fps)
    # Manifest times use six decimals for storage/comparison. Films need the
    # same exact grid as frame / fps, or shot-relative stepped poses can lag.
    shot = {**shot, "start": first / fps, "end": end / fps}
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    ctx = make_context(job, song, "preview" if quality == "sheet" else quality, shot)
    scene.render.engine = ctx.engine
    device = "GPU"
    if ctx.engine == "CYCLES":
        device = use_cycles_gpu(scene)
        scene.cycles.samples = ctx.samples
    else:
        scene.eevee.taa_render_samples = ctx.samples
    apply_frame_settings(scene, ctx)
    last = end - 1
    handles = shot.get("handles") if isinstance(shot.get("handles"), dict) else {}
    in_frames = 0 if quality in ("still", "sheet") else max(0, half_up(float(handles.get("in") or 0) * fps))
    out_frames = 0 if quality in ("still", "sheet") else max(0, half_up(float(handles.get("out") or 0) * fps))
    scene.frame_start = first - in_frames
    scene.frame_end = max(scene.frame_start, last + out_frames)
    if quality in ("still", "sheet"):
        targets = [(frame, frame_file(job, shot, frame, quality)) for frame in (job.get("frames") or [])]
    else:
        targets = (
            [(frame, handle_frame_file(job, shot, "in", frame, quality)) for frame in range(first - in_frames, first)]
            + [(frame, frame_file(job, shot, frame, quality)) for frame in range(first, last + 1)]
            + [(frame, handle_frame_file(job, shot, "out", frame, quality)) for frame in range(end, end + out_frames)]
        )
    if not targets:
        raise RuntimeError("Shot %s has no frames to render" % shot["id"])

    emit("start", shot=shot["id"], frames=len(targets), blender=blender_version(), engine=ctx.engine, device=device)
    started = time.time()
    film.build_shot(ctx, shot)
    emit("built", shot=shot["id"], sec=round(time.time() - started, 3))

    # The film may have replaced the scene; its look and compositor stay as it left them.
    scene = bpy.context.scene
    apply_frame_settings(scene, ctx)
    apply_output_format(scene, quality)
    pose = getattr(film, "frame", None)
    resume = bool(job.get("resume")) and quality not in ("still", "sheet")
    for index, (frame, path) in enumerate(targets, start=1):
        if os.getppid() == 1:
            raise RuntimeError("PortOS stopped while this shot was rendering")
        if resume and os.path.isfile(path) and os.path.getsize(path) > 0:
            emit("frame", shot=shot["id"], frame=frame, index=index, total=len(targets), sec=0, skipped=True)
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        frame_started = time.time()
        scene.frame_set(frame)
        if callable(pose):
            pose(ctx, shot, frame / fps, frame)
        if quality == "sheet":
            apply_render_stamp(scene, frame, fps, ctx.height)
        render_frame(scene, path)
        emit("frame", shot=shot["id"], frame=frame, index=index, total=len(targets),
             sec=round(time.time() - frame_started, 3), skipped=False)

    if job.get("saveBlend"):
        blend = os.path.join(job["out"], shot["id"], "shot.blend")
        os.makedirs(os.path.dirname(blend), exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=blend, check_existing=False, copy=True)
        emit("blend", shot=shot["id"], path=blend)
    emit("done", shot=shot["id"], sec=round(time.time() - started, 3), imports=workspace_imports(job["src"]))


def main():
    arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not arguments:
        raise RuntimeError("Usage: blender --background --python portos_blender_driver.py -- job.json")
    job_path = os.path.abspath(arguments[0])
    job = read_json(job_path)
    # Film source stays clean: no __pycache__ beside the authored scripts.
    sys.dont_write_bytecode = True
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    song = load_song(job, job_path)
    film = load_film(job["src"])
    if job.get("mode") == "describe":
        describe(job, film, song)
        return
    for shot in job.get("shots", []):
        render_shot(job, film, song, shot)


try:
    main()
except KeyboardInterrupt:
    print("Render canceled", flush=True)
    sys.exit(130)
except BaseException as error:  # noqa: B902 - SystemExit from a film is reported too
    emit("error", message="%s: %s" % (type(error).__name__, error), traceback=traceback.format_exc())
    sys.stdout.flush()
    sys.exit(1)
