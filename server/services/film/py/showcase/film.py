"""Showcase film for a published PortOS Blender model.

PortOS made this workspace from the model page: src/models/model.glb is the
published build, src/showcase.json says what it holds (size, parts, controls,
choreographed actions, saved compare cameras) and, when the model has an
approved overall reference sheet, src/showcase/sheet.* is that image.

    describe(ctx)               the shots, tiling the whole timeline
    build_shot(ctx, shot)       the scene for one shot
    frame(ctx, shot, t, frame)  pose everything for time `t`

Shots: Turntable, Assembly, Controls (skipped with none), one Close-up per saved
compare camera (at most six), and Reference to model (skipped without an approved
sheet). Every shot is a pure function of `t` (kit/plan.py). The shots are
ordinary film shots: edit this file, kit/plan.py or showcase.json freely.

Options (set under Film options): background, accent color, turn length, label parts.
"""

from kit import plan

# What the shot being rendered needs; build_shot fills it.
current = {}


def describe(ctx):
    data = plan.load(ctx.src)
    shots = []
    for entry in plan.layout(ctx, data):
        shots.append({
            "id": entry["id"],
            "label": entry["label"],
            "start": entry["start"],
            "end": entry["end"],
            "set": "showcase",
            "summary": SUMMARIES.get(entry["kind"].split(":")[0], ""),
            "transition": "Cut",
            # Editing one shot's data or code marks the film's renders stale; models/model.glb is tracked on its own.
            "deps": ["film.py", "kit", "showcase.json", "showcase"],
        })
    return {"title": data.get("title") or "Showcase", "shots": shots, "options": plan.option_list()}


SUMMARIES = {
    "turntable": "One full turn around the model.",
    "assembly": "Each part moves in along its offset from the model center, in declared order.",
    "controls": "Each control goes from 0 to 1 and back in turn, then any choreographed action.",
    "closeup": "A saved compare camera, easing closer.",
    "reference": "The approved reference sheet cross-dissolves to the render from the same angle.",
}


def build_shot(ctx, shot):
    from kit import stage

    data = plan.load(ctx.src)
    options = plan.read_options(ctx.options)
    entry = next(item for item in plan.layout(ctx, data) if item["id"] == shot["id"])
    current["stage"] = stage.build(ctx, data, options, entry)
    entry = {**entry, "start": shot["start"], "end": shot["end"]}
    if entry["kind"] == "controls":
        data = {**data, "posedBounds": plan.posed_bounds(data, options, entry, lambda pose: stage.corners(current["stage"], pose))}
    current.update(stage_module=stage, data=data, options=options, entry=entry)


def frame(ctx, shot, t, frame):
    pose = plan.pose(current["data"], current["options"], current["entry"], t, ctx.width / ctx.height)
    current["stage_module"].pose(current["stage"], ctx, pose)
