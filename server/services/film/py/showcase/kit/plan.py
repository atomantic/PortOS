"""The showcase film's plan: which shots there are, when, and what every one poses at time `t`.

Standard library only, so describe runs without Blender and a test can call
every function here. Each pose function is pure: its answer depends on its
arguments and nothing else, so frame N alone matches frame N in a sequence and
a render can stop and resume on any frame.

`src/showcase.json` (written by PortOS from the published model) is the data:
size, parts with their measured centers, controls, choreographed actions and the
saved compare cameras. Camera angles follow the model review views: azimuth 0
is the front (camera on -Y looking along +Y) and turns toward +X; elevation +90
looks straight down; the model stands on z = 0 centered on x = y = 0.
"""

import json
import math
import os

from portos_film import music, timing

MAX_CLOSEUPS = 6
SENSOR_MM = 36.0
FIXED_VIEWS = {
    "front": (0.0, 0.0), "right": (90.0, 0.0), "back": (180.0, 0.0), "left": (270.0, 0.0),
    "top": (0.0, 90.0), "bottom": (0.0, -90.0), "three-quarter": (35.0, 25.0),
}
HERO_VIEW = FIXED_VIEWS["three-quarter"]
# Natural length in seconds of each kind of shot; PortOS writes the real numbers into showcase.json.
DEFAULT_TIMINGS = {"turn": 8.0, "assembly": 6.0, "control": 2.5, "closeup": 3.0, "reference": 4.0}
ASSEMBLY_SPREAD = 1.5
DEFAULT_LENS = 50.0
# Poses measured per control (its swing out; the way back repeats them) and at least per action, to frame the controls shot.
POSED_STEPS = 24
POSED_STEPS_PER_SECOND = 12

BACKGROUNDS = {"studio": (0.18, 0.19, 0.21), "dark": (0.012, 0.013, 0.016), "light": (0.8, 0.8, 0.82)}
ACCENTS = {"amber": (1.0, 0.55, 0.08), "teal": (0.05, 0.75, 0.7), "magenta": (0.9, 0.12, 0.55), "blue": (0.1, 0.35, 1.0), "white": (1.0, 1.0, 1.0)}


def option_list():
    """The film's options, in `describe`'s shape."""
    return [
        {"key": "background", "label": "Background", "type": "choice", "default": "studio",
         "choices": [{"value": name, "label": name.capitalize()} for name in BACKGROUNDS],
         "help": "The backdrop and floor color behind the model."},
        {"key": "accent", "label": "Accent color", "type": "choice", "default": "amber",
         "choices": [{"value": name, "label": name.capitalize()} for name in ACCENTS],
         "help": "The color of part labels and the ring on the floor."},
        {"key": "turn", "label": "Turn length (seconds)", "type": "number", "default": DEFAULT_TIMINGS["turn"], "min": 3, "max": 60, "step": 0.5,
         "help": "How long the turntable takes for one full turn. The other shots keep their share of the film."},
        {"key": "labels", "label": "Label parts", "type": "boolean", "default": True,
         "help": "Name each part as it moves in."},
    ]


def read_options(options):
    options = options or {}
    turn = options.get("turn", DEFAULT_TIMINGS["turn"])
    turn = float(turn) if isinstance(turn, (int, float)) and not isinstance(turn, bool) else DEFAULT_TIMINGS["turn"]
    return {
        "background": options.get("background") if options.get("background") in BACKGROUNDS else "studio",
        "accent": options.get("accent") if options.get("accent") in ACCENTS else "amber",
        "turn": timing.clamp(turn, 3.0, 60.0),
        "labels": options.get("labels") is not False,
    }


def load(src):
    """`src/showcase.json`; raises a RuntimeError that says what to do when it is missing or unreadable."""
    path = os.path.join(src, "showcase.json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as error:
        raise RuntimeError("src/showcase.json is missing or not valid JSON (%s). Make the film again from the model page." % error)
    if not isinstance(data, dict) or not isinstance(data.get("size"), dict):
        raise RuntimeError("src/showcase.json has no model size")
    return data


def size_of(data):
    size = data["size"]
    return (float(size["x"]), float(size["y"]), float(size["z"]))


def diagonal(data):
    return math.sqrt(sum(value * value for value in size_of(data)))


def model_center(data):
    return (0.0, 0.0, size_of(data)[2] / 2.0)


def rest_bounds(data):
    """`(low, high)` corners of the model as published, standing at every control's default."""
    x, y, z = size_of(data)
    return ((-x / 2.0, -y / 2.0, 0.0), (x / 2.0, y / 2.0, z))


def _timing(data, key):
    value = (data.get("timings") or {}).get(key)
    return float(value) if isinstance(value, (int, float)) and value > 0 else DEFAULT_TIMINGS[key]


def controls_of(data):
    return [control for control in data.get("controls") or [] if isinstance(control, dict) and control.get("id")]


def actions_of(data):
    return [action for action in data.get("actions") or [] if isinstance(action, dict) and action.get("id") and float(action.get("seconds") or 0) > 0]


def cameras_of(data):
    return [camera for camera in data.get("cameras") or [] if isinstance(camera, dict) and camera.get("id")][:MAX_CLOSEUPS]


def segments(data):
    """The controls shot, in order: each control once, then each action. `[(kind, id, natural seconds)]`."""
    per_control = _timing(data, "control")
    return ([("control", control["id"], per_control) for control in controls_of(data)]
            + [("action", action["id"], float(action["seconds"])) for action in actions_of(data)])


def natural_shots(data, options):
    """`[(kind, label, natural seconds)]` in film order; shots with nothing to show are left out."""
    shots = [("turntable", "Turntable", options["turn"]), ("assembly", "Assembly", _timing(data, "assembly"))]
    parts = segments(data)
    if parts:
        shots.append(("controls", "Controls", sum(seconds for _, _, seconds in parts)))
    for camera in cameras_of(data):
        shots.append(("closeup:" + camera["id"], str(camera.get("label") or camera["id"])[:60], _timing(data, "closeup")))
    if data.get("sheet"):
        shots.append(("reference", "Reference to model", _timing(data, "reference")))
    return shots


def natural_total(data, options=None):
    return sum(seconds for _, _, seconds in natural_shots(data, read_options(options)))


def edges(naturals, end, fps, downbeats=()):
    """Shot boundaries on the frame grid from 0.0 to `end`, in proportion to the natural lengths.

    With a soundtrack each inner boundary moves onto the nearest downbeat that
    lies within a quarter of the shorter neighboring shot; a boundary that could
    not stay ahead of the one before it keeps its fixed time.
    """
    total = float(sum(naturals)) or 1.0
    frame = 1.0 / fps
    bounds = [0.0]
    running = 0.0
    for natural in naturals:
        running += natural
        bounds.append(running / total * end)
    bounds[-1] = end
    snapped = [0.0]
    for index in range(1, len(bounds) - 1):
        reach = min(bounds[index] - bounds[index - 1], bounds[index + 1] - bounds[index]) / 4.0
        near = [beat for beat in downbeats if abs(beat - bounds[index]) <= reach]
        chosen = min(near, key=lambda beat: abs(beat - bounds[index])) if near else bounds[index]
        snapped.append(math.floor(chosen * fps + 0.5) / fps)
    snapped.append(end)
    for index in range(1, len(snapped) - 1):
        snapped[index] = max(snapped[index], snapped[index - 1] + frame)
    for index in range(len(snapped) - 2, 0, -1):
        snapped[index] = min(snapped[index], snapped[index + 1] - frame)
    return [round(value, 6) for value in snapped]


def layout(ctx, data):
    """`[{id, label, kind, start, end}]`: the film's shots tiling the whole timeline."""
    options = read_options(ctx.options)
    fps = ctx.fps
    duration = float((ctx.song or {}).get("durationSec") or 0.0)
    end = math.ceil(duration * fps - 1e-9) / fps
    naturals = natural_shots(data, options)
    bounds = edges([seconds for _, _, seconds in naturals], end, fps, music.downbeats(ctx.song))
    return [{"id": "s%03d" % ((index + 1) * 10), "label": label, "kind": kind, "start": bounds[index], "end": bounds[index + 1]}
            for index, (kind, label, _) in enumerate(naturals)]


def progress(shot, t):
    return timing.remap(t, shot["start"], shot["end"])


# --- cameras -------------------------------------------------------------

def basis(azimuth, elevation):
    """Camera axes in world space: `right`, `up` and `back` (from the target toward the camera)."""
    az, el = math.radians(azimuth), math.radians(elevation)
    return {
        "right": (math.cos(az), math.sin(az), 0.0),
        "up": (-math.sin(az) * math.sin(el), math.cos(az) * math.sin(el), math.cos(el)),
        "back": (math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)),
    }


def fit_distance(data, lens, aspect, radius=None):
    """How far a camera must stand to fit a sphere (the model's bounding sphere by default) with a little room."""
    radius = diagonal(data) / 2.0 if radius is None else radius
    half = math.atan(SENSOR_MM / 2.0 / lens * min(aspect, 1.0 / aspect))
    return radius / math.sin(half) * 1.15


def camera(data, azimuth, elevation, distance, lens, target=None):
    target = tuple(target) if target else model_center(data)
    axes = basis(azimuth, elevation)
    location = tuple(target[axis] + axes["back"][axis] * distance for axis in range(3))
    return {"location": location, "right": axes["right"], "up": axes["up"], "back": axes["back"], "lens": lens, "target": target,
            "clipStart": max(distance / 1000.0, 1e-5), "clipEnd": distance + max(distance, diagonal(data) * 12.0)}


def turntable_pose(data, options, shot, t, aspect):
    """One full turn at a low three-quarter height."""
    turn = timing.ease(progress(shot, t), "linear")
    return {"camera": camera(data, HERO_VIEW[0] + 360.0 * turn, 16.0, fit_distance(data, DEFAULT_LENS, aspect), DEFAULT_LENS)}


def _offset(data, part):
    center = part.get("center")
    if not center:
        return (0.0, 0.0, 0.0)
    middle = model_center(data)
    return tuple((center[axis] - middle[axis]) * ASSEMBLY_SPREAD for axis in range(3))


def assembly_pose(data, options, shot, t, aspect):
    """Parts arrive one after another, in declared order, each along its own offset from the model center.

    `parts[id]` is `{arrived: 0..1, offset: (x, y, z) world displacement, visible}`.
    """
    parts = data.get("parts") or []
    count = max(1, len(parts))
    spread = 0.6 / count
    length = 1.0 - (count - 1) * spread
    now = progress(shot, t)
    placed = {}
    for index, part in enumerate(parts):
        arrived = timing.ease(timing.remap(now, index * spread, index * spread + length), "out", 3.0)
        remaining = 1.0 - arrived
        offset = _offset(data, part)
        placed[part["id"]] = {
            "arrived": arrived, "visible": now > index * spread,
            "offset": tuple(value * remaining for value in offset),
        }
    sweep = timing.ease(now, "smooth")
    return {"parts": placed, "camera": camera(data, HERO_VIEW[0] - 20.0 + 40.0 * sweep, 24.0, fit_distance(data, DEFAULT_LENS, aspect) * 1.05, DEFAULT_LENS)}


def _unmet_free(data, control_id, values):
    """Set the controls `control_id` depends on to a value that satisfies them (listed controls only)."""
    by_id = {control["id"]: control for control in controls_of(data)}
    for dep in by_id.get(control_id, {}).get("dependsOn") or []:
        low = dep.get("atLeast", 0.0)
        high = dep.get("atMost", 1.0)
        values[dep["control"]] = (low + high) / 2.0
        _unmet_free(data, dep["control"], values)


def posed_bounds(data, options, shot, corners):
    """`(low, high)` around everything the controls shot shows: the rest bounds and every sampled pose of `shot`.

    `corners(pose)` gives world points around the model in a pose from `controls_pose`
    (`stage.corners` in Blender). Where the parts go is known only there: showcase.json
    has each part's rest center, not its hinges or an action's keys.
    """
    low, high = (list(corner) for corner in rest_bounds(data))
    parts = segments(data)
    total = sum(seconds for _, _, seconds in parts) or 1.0
    walked = 0.0
    for kind, _, seconds in parts:
        steps = POSED_STEPS if kind == "control" else max(POSED_STEPS, math.ceil(seconds * POSED_STEPS_PER_SECOND))
        reach = seconds / 2.0 if kind == "control" else seconds
        for step in range(steps + 1):
            # Just inside the segment, or its ends would be posed as the neighbor's.
            into = timing.clamp(reach * step / steps, seconds * 1e-6, seconds * (1.0 - 1e-6))
            t = shot["start"] + (walked + into) / total * (shot["end"] - shot["start"])
            for point in corners(controls_pose(data, options, shot, t, 1.0)):
                for axis in range(3):
                    low[axis] = min(low[axis], point[axis])
                    high[axis] = max(high[axis], point[axis])
        walked += seconds
    return (tuple(low), tuple(high))


def controls_pose(data, options, shot, t, aspect):
    """Each control goes 0 to 1 and back in turn, then each choreographed action plays through.

    Returns `{controls: {id: 0..1}, action: None | {id, seconds}, camera}`; a control not being shown holds its default.
    The camera frames `data["posedBounds"]` (what `posed_bounds` measured), so one framing holds every pose of the shot.
    """
    controls = {control["id"]: float(control.get("default01", 0.0)) for control in controls_of(data)}
    naturals = segments(data)
    total = sum(seconds for _, _, seconds in naturals) or 1.0
    now = progress(shot, t) * total
    action = None
    walked = 0.0
    for kind, ident, seconds in naturals:
        if now <= walked + seconds or (kind, ident, seconds) == naturals[-1]:
            local = timing.clamp((now - walked) / seconds)
            if kind == "control":
                swing = 1.0 - abs(2.0 * local - 1.0)
                _unmet_free(data, ident, controls)
                controls[ident] = timing.ease(swing, "smooth")
            else:
                action = {"id": ident, "seconds": local * next(entry["seconds"] for entry in actions_of(data) if entry["id"] == ident)}
            break
        walked += seconds
    sweep = timing.ease(progress(shot, t), "smooth")
    low, high = data.get("posedBounds") or rest_bounds(data)
    middle = tuple((low[axis] + high[axis]) / 2.0 for axis in range(3))
    distance = fit_distance(data, DEFAULT_LENS, aspect, math.dist(low, high) / 2.0) * 0.95
    return {"controls": controls, "action": action,
            "camera": camera(data, HERO_VIEW[0] - 10.0 + 24.0 * sweep, 20.0, distance, DEFAULT_LENS, middle)}


def closeup_pose(data, options, shot, t, aspect, saved):
    """A saved compare camera, easing a few percent closer over the shot."""
    push = 1.0 - 0.06 * timing.ease(progress(shot, t), "smooth")
    orbit = saved.get("orbit")
    if orbit:
        return {"camera": camera(data, orbit["azimuth"], orbit["elevation"], orbit["distance"] * push, orbit.get("lens") or DEFAULT_LENS, orbit.get("target"))}
    azimuth, elevation = FIXED_VIEWS.get(saved.get("view"), HERO_VIEW)
    return {"camera": camera(data, azimuth, elevation, fit_distance(data, DEFAULT_LENS, aspect) * push, DEFAULT_LENS)}


def reference_pose(data, options, shot, t, aspect):
    """The approved sheet holds, cross-dissolves to the render from the same angle, and the render holds."""
    now = progress(shot, t)
    dissolve = timing.ease(timing.remap(now, 0.3, 0.65), "smooth")
    return {"sheetAlpha": 1.0 - dissolve, "camera": camera(data, HERO_VIEW[0], HERO_VIEW[1], fit_distance(data, DEFAULT_LENS, aspect), DEFAULT_LENS)}


def pose(data, options, shot, t, aspect):
    """The pose of `shot` (a `layout` entry) at song time `t`; one dict for every kind of shot."""
    kind = shot["kind"]
    if kind == "turntable":
        return turntable_pose(data, options, shot, t, aspect)
    if kind == "assembly":
        return assembly_pose(data, options, shot, t, aspect)
    if kind == "controls":
        return controls_pose(data, options, shot, t, aspect)
    if kind == "reference":
        return reference_pose(data, options, shot, t, aspect)
    saved = next((camera for camera in cameras_of(data) if "closeup:" + camera["id"] == kind), None)
    if saved is None:
        raise RuntimeError("showcase shot %s names a camera that is not in showcase.json" % shot["id"])
    return closeup_pose(data, options, shot, t, aspect, saved)
