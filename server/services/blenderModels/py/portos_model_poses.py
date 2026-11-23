"""Which poses a Blender model's moving parts are checked in.

Pure Python (no bpy): reading `describe().controls`, the 0-1 value of each
control, what its dependencies require, and the list of poses a sweep visits.
`portos_model_motion.py` builds the bones and measures the poses. The server
validates the same fields and reports on them (server/lib/blenderModelsValidation.js, motion.js);
here a control that cannot be rigged is only left out, with the reason.
"""

import math
import re

TYPES = ("hinge", "slide", "wheel")
# Blender caps a bone or action name at 63 characters, `control:` included.
MOTION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$")
MAX_CONTROLS = 64
MAX_ACTIONS = 32
# Positions per 0-1 range: 0.05 steps alone, 0.1 steps in a grid of two controls.
STEPS = 20
GRID_STEPS = 10
EPSILON = 1e-6
FPS = 24


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def vector(value):
    return isinstance(value, (list, tuple)) and len(value) == 3 and all(number(item) for item in value)


def clamp(value, low=0.0, high=1.0):
    return min(high, max(low, value))


def items(value):
    return list(value) if isinstance(value, (list, tuple)) else []


def unusable(control, part_ids, seen):
    """Why `control` cannot be rigged, or None."""
    if not isinstance(control, dict):
        return "is not an object"
    if not isinstance(control.get("id"), str) or not MOTION_ID.match(control["id"]):
        return "has no valid id"
    if control["id"] in seen:
        return "repeats an id"
    if control.get("type") not in TYPES:
        return "type must be hinge, slide or wheel"
    if control.get("partId") not in part_ids:
        return "partId names no built part"
    if not vector(control.get("origin")) or not vector(control.get("axis")):
        return "origin and axis must be three numbers"
    if math.sqrt(sum(item * item for item in control["axis"])) < 1e-9:
        return "axis has no direction"
    if not all(number(control.get(key)) for key in ("min", "max", "default")):
        return "min, max and default must be numbers"
    if control["max"] <= control["min"] or not control["min"] <= control["default"] <= control["max"]:
        return "needs min < max with default between them"
    return None


def clean_controls(raw, part_ids):
    """`(controls, skipped)`: the usable controls, and `(id, reason)` for the rest."""
    controls, skipped, seen = [], [], set()
    listed = items(raw)
    for control in listed[:MAX_CONTROLS]:
        reason = unusable(control, part_ids, seen)
        if reason:
            skipped.append((control.get("id") if isinstance(control, dict) else None, reason))
            continue
        seen.add(control["id"])
        length = math.sqrt(sum(item * item for item in control["axis"]))
        low, high = float(control["min"]), float(control["max"])
        controls.append({
            "id": control["id"],
            "type": control["type"],
            "partId": control["partId"],
            "origin": [float(item) for item in control["origin"]],
            "axis": [float(item) / length for item in control["axis"]],
            "min": low,
            "max": high,
            "default": float(control["default"]),
            "default01": (float(control["default"]) - low) / (high - low),
            "dependsOn": [dep for dep in items(control.get("dependsOn")) if isinstance(dep, dict)],
        })
    for control in listed[MAX_CONTROLS:]:
        skipped.append((control.get("id") if isinstance(control, dict) else None, "is past the %d controls a build rigs" % MAX_CONTROLS))
    for control in controls:
        control["dependsOn"] = [
            (dep["control"], float(dep["atLeast"]) if number(dep.get("atLeast")) else 0.0, float(dep["atMost"]) if number(dep.get("atMost")) else 1.0)
            for dep in control["dependsOn"] if dep.get("control") in seen and dep.get("control") != control["id"]
        ]
    return controls, skipped


def joint_value(control, value):
    """The joint position (degrees or meters) a 0-1 value commands; outside 0-1 clamps."""
    return control["min"] + (control["max"] - control["min"]) * clamp(value)


def defaults(controls):
    return {control["id"]: control["default01"] for control in controls}


def off_default(control, values):
    return abs(values[control["id"]] - control["default01"]) > EPSILON


def unmet(controls, values):
    """The controls off their default whose dependencies do not hold."""
    return [
        control["id"] for control in controls
        if off_default(control, values)
        and any(not low - EPSILON <= values[other] <= high + EPSILON for other, low, high in control["dependsOn"])
    ]


def satisfy(by_id, values, control_id, pinned, seen=None):
    """Move what `control_id` depends on (and what that depends on) into range; `pinned` controls stay put."""
    seen = seen or {control_id}
    for other, low, high in by_id[control_id]["dependsOn"]:
        if other in pinned or other in seen:
            continue
        values[other] = min(max(values[other], low), high)
        if off_default(by_id[other], values):
            satisfy(by_id, values, other, pinned, seen | {other})


def posed(controls, commanded):
    """The pose with `commanded` values set, everything else at default or where a dependency needs it."""
    by_id = {control["id"]: control for control in controls}
    values = defaults(controls)
    values.update(commanded)
    for control_id in commanded:
        if off_default(by_id[control_id], values):
            satisfy(by_id, values, control_id, set(commanded))
    return values


def allowed(controls, poses):
    """`(reachable, blocked)`: the poses every dependency allows, and how many it rules out."""
    kept = [values for values in poses if not unmet(controls, values)]
    return kept, len(poses) - len(kept)


def grid_pairs(controls, moved):
    """Pairs of controls that move a part in common, or where one's dependency concerns the other."""
    pairs = []
    depends = {control["id"]: {other for other, _, _ in control["dependsOn"]} for control in controls}
    for index, first in enumerate(controls):
        for second in controls[index + 1:]:
            a, b = first["id"], second["id"]
            if moved[a] & moved[b] or b in depends[a] or a in depends[b] or depends[a] & depends[b]:
                pairs.append((a, b))
    return pairs


def control_scopes(controls, moved):
    """Every control alone, then every pair grid: `{kind, ids, poses, blocked}`, poses built when asked for."""
    for control in controls:
        poses, blocked = allowed(controls, [posed(controls, {control["id"]: step / STEPS}) for step in range(STEPS + 1)])
        yield {"kind": "control", "ids": [control["id"]], "poses": poses, "blocked": blocked}
    for a, b in grid_pairs(controls, moved):
        poses, blocked = allowed(controls, [
            posed(controls, {a: first / GRID_STEPS, b: second / GRID_STEPS})
            for first in range(GRID_STEPS + 1) for second in range(GRID_STEPS + 1)
        ])
        yield {"kind": "pair", "ids": [a, b], "poses": poses, "blocked": blocked}


def clean_actions(raw):
    """`(actions, skipped)`: the choreographed actions that can be evaluated."""
    actions, skipped, seen = [], [], set()
    for action in items(raw)[:MAX_ACTIONS]:
        action_id = action.get("id") if isinstance(action, dict) else None
        seconds = action.get("seconds") if isinstance(action, dict) else None
        if not isinstance(action_id, str) or not MOTION_ID.match(action_id) or action_id in seen or not number(seconds) or not 0 < seconds <= 60:
            skipped.append((action_id, "needs a unique id and seconds above 0, at most 60"))
            continue
        seen.add(action_id)
        actions.append({"id": action_id, "frames": max(1, round(seconds * FPS))})
    return actions, skipped


def action_pose(controls, answer):
    """The pose `pose(ctx, action, t)` answered: a dict of control values, clamped; the rest stay at default."""
    if not isinstance(answer, dict):
        raise ValueError("pose(ctx, action, t) must return a dict of control values")
    values = defaults(controls)
    for control_id, value in answer.items():
        if control_id not in values:
            raise ValueError("pose(ctx, action, t) returned %r, which is not a control" % (control_id,))
        if not number(value):
            raise ValueError("pose(ctx, action, t) returned no number for %s" % control_id)
        values[control_id] = clamp(float(value))
    return values
