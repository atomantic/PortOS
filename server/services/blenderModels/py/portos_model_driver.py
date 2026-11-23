"""PortOS Blender model driver.

Runs inside Blender (4.2 or newer), started by PortOS:

    blender --background --factory-startup --disable-autoexec --python-exit-code 1 \
        --python portos_model_driver.py -- job.json

It loads a model (`<src>/model.py`), calls `describe(ctx)` and `build(ctx)` in
an empty factory scene, measures what was built, saves `model.blend`, exports
`model.glb`, imports that GLB into a fresh empty scene and measures it again.
The model contract is documented in docs/features/blender-models.md.

The driver reports facts, not verdicts: the server turns them into the build's
findings. Facts go to stdout as one JSON object per line, prefixed with
`PORTOS_MODEL `, one event per declared part and per mesh so no line grows
large. Every other line is free-form log text.
"""

import importlib.util
import json
import os
import sys
import time
import traceback
from types import SimpleNamespace

import bpy

PREFIX = "PORTOS_MODEL "
# The most parts and meshes a build reports by name; the rest are still counted.
MAX_LISTED = 2000


def emit(event, **fields):
    # Flushed per line: Blender block-buffers a piped stdout.
    # default=str: a model may hand describe() values JSON cannot spell; the server checks them.
    sys.stdout.write(PREFIX + json.dumps({"event": event, **fields}, default=str) + "\n")
    sys.stdout.flush()


def log(message):
    sys.stdout.write(str(message) + "\n")
    sys.stdout.flush()


def blender_version():
    return "%d.%d.%d" % tuple(bpy.app.version)


def read_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def load_model(src):
    path = os.path.join(src, "model.py")
    if not os.path.isfile(path):
        raise RuntimeError("src/model.py is missing: a model defines describe(ctx) and build(ctx) there")
    # The model's own folders import as packages from src/.
    if src not in sys.path:
        sys.path.insert(0, src)
    spec = importlib.util.spec_from_file_location("model", path)
    model = importlib.util.module_from_spec(spec)
    sys.modules["model"] = model
    spec.loader.exec_module(model)
    for name in ("describe", "build"):
        if not callable(getattr(model, name, None)):
            raise RuntimeError("src/model.py must define %s" % name)
    return model


def make_context(job):
    return SimpleNamespace(
        workspace=job["workspace"],
        src=job["src"],
        out_dir=job["out"],
        quality=job.get("quality", "draft"),
        log=log,
    )


def describe(model, ctx):
    description = model.describe(ctx)
    if not isinstance(description, dict):
        raise RuntimeError("describe(ctx) must return a dict")
    parts = description.get("parts")
    parts = parts if isinstance(parts, list) else []
    for part in parts[:MAX_LISTED]:
        part = part if isinstance(part, dict) else {}
        emit("part", id=part.get("id"), label=part.get("label"), parent=part.get("parent"))
    emit(
        "described",
        title=description.get("title"),
        sizeMeters=description.get("sizeMeters"),
        triangleBudget=description.get("triangleBudget"),
        controls=description.get("controls"),
        partsTruncated=len(parts) > MAX_LISTED,
    )


def mesh_facts(obj, depsgraph):
    """Triangles and world-space bounds of `obj` as it exports (modifiers applied)."""
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    try:
        mesh.calc_loop_triangles()
        triangles = len(mesh.loop_triangles)
        matrix = obj.matrix_world
        low = [float("inf")] * 3
        high = [float("-inf")] * 3
        for vertex in mesh.vertices:
            point = matrix @ vertex.co
            for axis in range(3):
                low[axis] = min(low[axis], point[axis])
                high[axis] = max(high[axis], point[axis])
        if not mesh.vertices:
            low, high = None, None
        return triangles, low, high
    finally:
        evaluated.to_mesh_clear()


def merge_bounds(total, low, high):
    if low is None:
        return total
    if total is None:
        return [list(low), list(high)]
    return [[min(a, b) for a, b in zip(total[0], low)], [max(a, b) for a, b in zip(total[1], high)]]


def used_images():
    return [image for image in bpy.data.images if image.users and image.type not in ("RENDER_RESULT", "COMPOSITING")]


def measure(report_meshes):
    """Measure every mesh object in the scene; `report_meshes` also emits one event per mesh."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    scene_objects = list(bpy.context.scene.objects)
    meshes = [obj for obj in scene_objects if obj.type == "MESH"]
    total_triangles = 0
    bounds = None
    materials = set()
    for index, obj in enumerate(meshes):
        triangles, low, high = mesh_facts(obj, depsgraph)
        total_triangles += triangles
        bounds = merge_bounds(bounds, low, high)
        slots = {slot.material.name for slot in obj.material_slots if slot.material}
        materials |= slots
        if report_meshes and index < MAX_LISTED:
            emit(
                "mesh",
                name=obj.name,
                parent=obj.parent.name if obj.parent else None,
                triangles=triangles,
                min=low,
                max=high,
                scale=list(obj.scale),
                negative=obj.matrix_world.determinant() < 0,
                materials=len(slots),
            )
    return {
        "objects": len(scene_objects),
        "meshes": len(meshes),
        "triangles": total_triangles,
        "materials": len(materials),
        "images": len(used_images()),
        "actions": len([action for action in bpy.data.actions if action.users]),
        "min": bounds[0] if bounds else None,
        "max": bounds[1] if bounds else None,
        "truncated": len(meshes) > MAX_LISTED,
    }


def export_glb(path):
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_apply=True,
        export_yup=True,
        use_selection=False,
    )


def build(job):
    started = time.time()
    emit("start", blender=blender_version(), quality=job.get("quality", "draft"))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ctx = make_context(job)
    model = load_model(job["src"])
    describe(model, ctx)
    model.build(ctx)
    scene = measure(True)
    emit("scene", **scene)

    out = job["out"]
    os.makedirs(out, exist_ok=True)
    blend = os.path.join(out, "model.blend")
    glb = os.path.join(out, "model.glb")
    bpy.ops.wm.save_as_mainfile(filepath=blend, check_existing=False, copy=True)
    export_glb(glb)
    emit("saved", blend=blend, glb=glb, glbBytes=os.path.getsize(glb) if os.path.isfile(glb) else None)

    # A fresh empty scene: what a consumer of the GLB gets back.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=glb)
    reimported = measure(False)
    reimported.pop("truncated", None)
    emit("reimport", **reimported)
    emit("done", sec=round(time.time() - started, 3))


def main():
    arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not arguments:
        raise RuntimeError("Usage: blender --background --python portos_model_driver.py -- job.json")
    job = read_json(os.path.abspath(arguments[0]))
    # Model source stays clean: no __pycache__ beside the authored scripts.
    sys.dont_write_bytecode = True
    build(job)


try:
    main()
except KeyboardInterrupt:
    print("Build canceled", flush=True)
    sys.exit(130)
except BaseException as error:  # noqa: B902 - SystemExit from a model is reported too
    emit("error", message="%s: %s" % (type(error).__name__, error), traceback=traceback.format_exc())
    sys.stdout.flush()
    sys.exit(1)
