"""Starter film for a PortOS Blender music video.

PortOS calls three functions here, inside Blender:

    describe(ctx)               the shot list: ids, times on the song, a line of intent each
    build_shot(ctx, shot)       build the scene for one shot (objects, lights, camera)
    frame(ctx, shot, t, frame)  pose everything for song time `t` before each frame renders

`ctx.song` is song.json: duration, beats, sections, loudness envelopes and
timed lyrics. This film cuts the song into three shots on its sections and
stages one set (kit/stage.py) three ways (shots/*.py). Replace any of it: the
scripts are the film.

`ctx.options` holds the film's options: `describe` declares them, the operator
sets them under Film options in PortOS, and every call reads them. This film
declares one, `palette`, which repaints the whole set.
"""

import math

from portos_film import music

from kit import look, stage as stage_kit
from shots import hero, orbit, wide

SHOTS = [("s010", "Wide push", wide), ("s020", "Orbit", orbit), ("s030", "Hero pull back", hero)]
MODULES = {shot_id: module for shot_id, _, module in SHOTS}

# "shot" keeps each shot's own palette; any other value paints every shot with that one.
PALETTE_PER_SHOT = "shot"
OPTIONS = [{
    "key": "palette",
    "label": "Palette",
    "type": "choice",
    "choices": [{"value": PALETTE_PER_SHOT, "label": "Each shot's own"}]
               + [{"value": name, "label": name.capitalize()} for name in sorted(look.PALETTES)],
    "default": PALETTE_PER_SHOT,
    "help": "The colors of the sky, the lights and the three figures.",
}]

# The set and shot module of the shot being rendered; build_shot fills it.
current = {}


def _cuts(song, fps):
    """Two cut times that split the song in three, moved onto a section start when one is near."""
    duration = float(song.get("durationSec") or 0.0)
    end = math.ceil(duration * fps - 1e-9) / fps
    starts = [section["startSec"] for section in music.sections(song) if 1.0 < section.get("startSec", 0.0) < end - 1.0]
    cuts = []
    for third in (end / 3.0, end * 2.0 / 3.0):
        near = [start for start in starts if abs(start - third) < end * 0.12]
        cut = min(near, key=lambda start: abs(start - third)) if near else third
        cuts.append(round(cut * fps) / fps)
    return [0.0, cuts[0], cuts[1], end]


def describe(ctx):
    edges = _cuts(ctx.song, ctx.fps)
    shots = []
    for index, (shot_id, label, module) in enumerate(SHOTS):
        if edges[index + 1] <= edges[index]:
            continue
        shots.append({
            "id": shot_id,
            "label": label,
            "start": edges[index],
            "end": edges[index + 1],
            "set": "stage",
            "summary": module.SUMMARY,
            "action": module.ACTION,
            "staging": module.STAGING,
            "camera": module.CAMERA,
            "transition": "Cut",
            # What this shot is built from: editing another shot's file leaves this render current.
            "deps": ["film.py", "kit", "shots/%s.py" % module.__name__.split(".")[-1]],
        })
    return {"title": ctx.song.get("title") or "Starter film", "shots": shots, "options": OPTIONS}


def build_shot(ctx, shot):
    module = MODULES[shot["id"]]
    chosen = ctx.options.get("palette", PALETTE_PER_SHOT)
    stage = stage_kit.build(ctx, palette=chosen if chosen in look.PALETTES else module.PALETTE)
    module.build(ctx, shot, stage)
    current["stage"] = stage
    current["module"] = module


def frame(ctx, shot, t, frame):
    stage_kit.pose(current["stage"], ctx, t)
    current["module"].frame(ctx, shot, current["stage"], t)
