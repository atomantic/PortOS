"""PortOS Blender model driver.

Runs inside Blender (4.2 or newer), started by PortOS:

    blender --background --factory-startup --disable-autoexec --python-exit-code 1 \
        --python portos_model_driver.py -- job.json

It loads a model (`<src>/model.py`), calls `describe(ctx)` and `build(ctx)` in
an empty factory scene, measures what was built, saves `model.blend`, exports
`model.glb`, imports that GLB into a fresh empty scene and measures it again.
The model contract is documented in docs/features/blender-models.md.

A job with `"mode": "review"` instead opens a build's saved `model.blend` and
renders each view it lists, textured and clay, under flat light. The server
computes the cameras; the model's own cameras, lights, world, compositor and
render settings do not take part, and nothing is saved back.

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
from mathutils import Matrix, Vector

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


def flat_light(scene):
    """A uniform white surround the camera sees as mid gray, so light and dark models both read."""
    world = bpy.data.worlds.new("portos_review")
    world.use_nodes = True
    tree = world.node_tree
    tree.nodes.clear()
    output = tree.nodes.new("ShaderNodeOutputWorld")
    mix = tree.nodes.new("ShaderNodeMixShader")
    path = tree.nodes.new("ShaderNodeLightPath")
    surround = tree.nodes.new("ShaderNodeBackground")
    backdrop = tree.nodes.new("ShaderNodeBackground")
    surround.inputs["Color"].default_value = (1.0, 1.0, 1.0, 1.0)
    surround.inputs["Strength"].default_value = 0.55
    backdrop.inputs["Color"].default_value = (0.12, 0.12, 0.12, 1.0)
    tree.links.new(path.outputs["Is Camera Ray"], mix.inputs["Fac"])
    tree.links.new(surround.outputs["Background"], mix.inputs[1])
    tree.links.new(backdrop.outputs["Background"], mix.inputs[2])
    tree.links.new(mix.outputs["Shader"], output.inputs["Surface"])
    scene.world = world
    for obj in scene.objects:
        if obj.type in ("LIGHT", "LIGHT_PROBE"):
            obj.hide_render = True
    # A shadowless sun along the view direction gives every view the same relief.
    sun = bpy.data.lights.new("portos_review_sun", "SUN")
    sun.energy = 1.6
    sun.use_shadow = False
    lamp = bpy.data.objects.new("portos_review_sun", sun)
    scene.collection.objects.link(lamp)
    return lamp


def clay_material():
    clay = bpy.data.materials.new("portos_review_clay")
    clay.use_nodes = True
    shader = next(node for node in clay.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
    shader.inputs["Base Color"].default_value = (0.5, 0.48, 0.45, 1.0)
    shader.inputs["Roughness"].default_value = 1.0
    shader.inputs["Specular IOR Level"].default_value = 0.0
    return clay


def review_settings(scene, size):
    render = scene.render
    # Blender 5 named EEVEE's engine BLENDER_EEVEE again.
    render.engine = "BLENDER_EEVEE_NEXT" if bpy.app.version < (5, 0, 0) else "BLENDER_EEVEE"
    render.resolution_x = render.resolution_y = size
    render.resolution_percentage = 100
    render.pixel_aspect_x = render.pixel_aspect_y = 1.0
    render.use_border = False
    render.use_compositing = False
    render.use_sequencer = False
    render.use_multiview = False
    render.use_freestyle = False
    render.film_transparent = False
    render.use_stamp = False
    render.image_settings.file_format = "PNG"
    render.image_settings.color_mode = "RGB"
    scene.eevee.taa_render_samples = 32
    scene.display_settings.display_device = "sRGB"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0


def aim_camera(camera, lamp, view):
    right, up, back = (Vector(view[axis]) for axis in ("right", "up", "back"))
    rotation = Matrix((right, up, back)).transposed().to_4x4()
    camera.matrix_world = Matrix.Translation(Vector(view["location"])) @ rotation
    lamp.matrix_world = rotation
    data = camera.data
    data.type = view["projection"]
    data.sensor_fit = "AUTO"
    data.sensor_width = 36.0
    data.clip_start = view["clipStart"]
    data.clip_end = view["clipEnd"]
    if view["projection"] == "ORTHO":
        data.ortho_scale = view["orthoScale"]
    else:
        data.lens = view["lens"]


def review(job):
    started = time.time()
    emit("start", blender=blender_version(), quality=None)
    bpy.ops.wm.open_mainfile(filepath=job["blend"], load_ui=False, use_scripts=False)
    scene = bpy.context.scene
    review_settings(scene, job["size"])
    lamp = flat_light(scene)
    data = bpy.data.cameras.new("portos_review")
    camera = bpy.data.objects.new("portos_review", data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    clay = clay_material()
    os.makedirs(job["out"], exist_ok=True)
    for look in job["looks"]:
        for layer in scene.view_layers:
            layer.material_override = clay if look == "clay" else None
        for view in job["views"]:
            aim_camera(camera, lamp, view)
            path = os.path.join(job["out"], "%s-%s.png" % (view["id"], look))
            scene.render.filepath = path
            bpy.ops.render.render(write_still=True)
            if not os.path.isfile(path):
                raise RuntimeError("The %s %s view was not written" % (look, view["id"]))
            emit("view", id=view["id"], look=look)
    emit("done", sec=round(time.time() - started, 3))


def main():
    arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not arguments:
        raise RuntimeError("Usage: blender --background --python portos_model_driver.py -- job.json")
    job = read_json(os.path.abspath(arguments[0]))
    # Model source stays clean: no __pycache__ beside the authored scripts.
    sys.dont_write_bytecode = True
    if job.get("mode") == "review":
        review(job)
    else:
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
