"""The showcase set in Blender: lights, a floor, the model and the camera, posed from `plan.pose`.

`build` makes the scene for one shot; `pose` places everything for one pose dict
from `plan.pose`. Every call to `pose` sets all it touches (every control, every
part offset, the camera), so a frame never depends on the one before it.
"""

import math
from types import SimpleNamespace

import bpy
from mathutils import Matrix, Vector

from portos_film import models

from kit import plan

MODEL_SLUG = "model"


def _rgba(color):
    return (color[0], color[1], color[2], 1.0)


def _material(name, color, roughness=0.6, emission=0.0):
    made = bpy.data.materials.new(name)
    if made.node_tree is None:
        made.use_nodes = True
    shader = made.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = _rgba(color)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Emission Color"].default_value = _rgba(color)
    shader.inputs["Emission Strength"].default_value = emission
    return made


def _plane(name, size_x, size_y, material, collection):
    mesh = bpy.data.meshes.new(name)
    half_x, half_y = size_x / 2.0, size_y / 2.0
    mesh.from_pydata([(-half_x, -half_y, 0), (half_x, -half_y, 0), (half_x, half_y, 0), (-half_x, half_y, 0)], [], [(0, 1, 2, 3)])
    mesh.uv_layers.new(name="UVMap")
    for loop, uv in zip(mesh.loops, [(0, 0), (1, 0), (1, 1), (0, 1)]):
        mesh.uv_layers[0].data[loop.index].uv = uv
    mesh.update()
    made = bpy.data.objects.new(name, mesh)
    made.data.materials.append(material)
    collection.objects.link(made)
    return made


def _sky(scene, color):
    world = bpy.data.worlds.new("Showcase sky")
    if world.node_tree is None:
        world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = _rgba(color)
    background.inputs["Strength"].default_value = 1.0
    scene.world = world
    try:
        scene.view_settings.view_transform = "Standard"
    except TypeError as error:
        print("Showcase view transform skipped: %s" % error, flush=True)


def _light(name, kind, energy, location, target, collection, size=None):
    data = bpy.data.lights.new(name, kind)
    data.energy = energy
    if size is not None:
        data.size = size
    made = bpy.data.objects.new(name, data)
    made.location = location
    direction = Vector(target) - Vector(location)
    made.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    collection.objects.link(made)
    return made


def _transparent_mix(name, image=None, color=None):
    """An emission surface that fades with the `Fade` value: 1 shows it, 0 is clear."""
    made = bpy.data.materials.new(name)
    if made.node_tree is None:
        made.use_nodes = True
    # Stochastic transparency where Blender has it, the older blend mode otherwise.
    if hasattr(made, "surface_render_method"):
        made.surface_render_method = "BLENDED"
    elif hasattr(made, "blend_method"):
        made.blend_method = "BLEND"
    nodes, links = made.node_tree.nodes, made.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    mix = nodes.new("ShaderNodeMixShader")
    clear = nodes.new("ShaderNodeBsdfTransparent")
    glow = nodes.new("ShaderNodeEmission")
    glow.inputs["Strength"].default_value = 1.0
    if image is not None:
        texture = nodes.new("ShaderNodeTexImage")
        texture.image = image
        links.new(texture.outputs["Color"], glow.inputs["Color"])
    else:
        glow.inputs["Color"].default_value = _rgba(color)
    mix.inputs[0].default_value = 1.0
    links.new(clear.outputs[0], mix.inputs[1])
    links.new(glow.outputs[0], mix.inputs[2])
    links.new(mix.outputs[0], output.inputs["Surface"])
    return made, mix


def _imported_tracks(prefix, ident):
    """`[(object, action, slot)]` of the imported animation named `<prefix><ident>`."""
    found = []
    wanted = prefix + ident
    for obj in bpy.data.objects:
        if not obj.animation_data:
            continue
        for track in obj.animation_data.nla_tracks:
            if track.name == wanted and track.strips:
                found.append((obj, track.strips[0].action, getattr(track.strips[0], "action_slot", None)))
    return found


def _seek(tracks, seconds):
    """Pose the model at `seconds` into an imported clip, then drop the clip so the pose stays and the next seek is independent."""
    fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    frame = seconds * fps
    for obj, action, slot in tracks:
        data = obj.animation_data
        data.action = action
        if hasattr(data, "action_slot") and slot is not None:
            data.action_slot = slot
        whole = math.floor(frame)
        bpy.context.scene.frame_set(whole, subframe=frame - whole)
        data.action = None


def _settle(data):
    """Stop the clip the importer left playing (every frame and render would replay it) and hold each control at its default."""
    for obj in bpy.data.objects:
        if obj.animation_data:
            obj.animation_data.action = None
    for control in plan.controls_of(data):
        _seek(_imported_tracks("control:", control["id"]), timing_value(plan.default_of(control)))


def _label(text, color, size, collection):
    curve = bpy.data.curves.new("Label " + text, "FONT")
    curve.body = text
    curve.size = size
    curve.align_x = "CENTER"
    made = bpy.data.objects.new("Label " + text, curve)
    made.data.materials.append(_material("Label " + text, color, 0.5, emission=2.0))
    collection.objects.link(made)
    return made


def build(ctx, data, options, shot):
    """Make the scene for `shot`: sky, lights, floor, the model, its rigging and the camera."""
    scene = bpy.context.scene
    collection = scene.collection
    scene.render.film_transparent = False
    size = plan.size_of(data)
    diag = plan.diagonal(data)
    center = plan.model_center(data)
    _sky(scene, plan.BACKGROUNDS[options["background"]])
    accent = plan.ACCENTS[options["accent"]]

    floor = _plane("Floor", diag * 40.0, diag * 40.0, _material("Floor", plan.BACKGROUNDS[options["background"]], roughness=0.9), collection)
    floor.location = (0.0, 0.0, -0.0005)
    ring_radius = max(size[0], size[1]) * 0.75
    ring_mesh = _ring_outline(ring_radius, diag, accent, collection)

    _light("Key", "SUN", 1.0, (center[0] + diag * 2.0, center[1] - diag * 2.0, center[2] + diag * 3.0), center, collection)
    _light("Fill", "AREA", diag * diag * 70.0, (center[0] - diag * 2.5, center[1] - diag * 1.5, center[2] + diag), center, collection, size=diag * 2.0)
    _light("Rim", "AREA", diag * diag * 90.0, (center[0], center[1] + diag * 2.5, center[2] + diag * 1.5), center, collection, size=diag * 2.0)

    root, _actions = models.load(ctx, MODEL_SLUG, settle=lambda: _settle(data))
    scene_camera = bpy.data.objects.new("Showcase camera", bpy.data.cameras.new("Showcase camera"))
    collection.objects.link(scene_camera)
    scene.camera = scene_camera

    stage = SimpleNamespace(
        root=root, camera=scene_camera, rest={}, ring=ring_mesh, labels={}, sheet=None, backdrop=None,
        controls={}, actions={}, scene=scene, accent=accent, label_size=diag * 0.05,
    )
    _index_parts(stage, data)
    for control in plan.controls_of(data):
        stage.controls[control["id"]] = _imported_tracks("control:", control["id"])
    for action in plan.actions_of(data):
        stage.actions[action["id"]] = _imported_tracks("action:", action["id"])
    if shot["kind"] == "assembly" and options["labels"]:
        for part in data.get("parts") or []:
            stage.labels[part["id"]] = _label(str(part.get("label") or part["id"])[:40], accent, stage.label_size, collection)
            constraint = stage.labels[part["id"]].constraints.new("TRACK_TO")
            constraint.target = scene_camera
            constraint.track_axis = "TRACK_Z"
            constraint.up_axis = "UP_Y"
    if shot["kind"] == "reference":
        _build_sheet(ctx, data, options, stage, collection)
    return stage


def _ring_outline(radius, diag, color, collection):
    mesh = bpy.data.meshes.new("Ring outline")
    steps = 96
    inner, outer = radius, radius + diag * 0.004
    vertices, faces = [], []
    for index in range(steps):
        angle = index / steps * math.tau
        vertices += [(math.cos(angle) * inner, math.sin(angle) * inner, 0.0), (math.cos(angle) * outer, math.sin(angle) * outer, 0.0)]
    for index in range(steps):
        a, b = index * 2, index * 2 + 1
        c, d = ((index + 1) % steps) * 2, ((index + 1) % steps) * 2 + 1
        faces.append((a, b, d, c))
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    made = bpy.data.objects.new("Ring outline", mesh)
    made.data.materials.append(_material("Ring", color, 0.5, emission=1.5))
    collection.objects.link(made)
    return made


def _index_parts(stage, data):
    """Remember each part's rest transform so a pose is a displacement from it, not from the last pose."""
    bpy.context.view_layer.update()
    for part in data.get("parts") or []:
        obj = bpy.data.objects.get(part["id"])
        if obj is None:
            continue
        parent = obj.parent
        stage.rest[part["id"]] = SimpleNamespace(
            obj=obj, parent_id=(parent.name if parent is not None and parent.name in {p["id"] for p in data["parts"]} else None),
            parent_linear=(parent.matrix_world.to_3x3() if parent is not None else Matrix.Identity(3)),
            delta=obj.delta_location.copy(),
        )


def _build_sheet(ctx, data, options, stage, collection):
    path = bpy.path.abspath(ctx.src + "/" + str(data["sheet"]))
    image = bpy.data.images.load(path)
    image.colorspace_settings.name = "sRGB"
    fade_material, fade_mix = _transparent_mix("Sheet", image=image)
    back_material, back_mix = _transparent_mix("Sheet backdrop", color=plan.BACKGROUNDS[options["background"]])
    width, height = image.size
    stage.sheet = SimpleNamespace(mixes=(fade_mix, back_mix), aspect=(width / height) if height else 1.0)
    stage.sheet.plane = _plane("Sheet", 1.0, 1.0, fade_material, collection)
    stage.sheet.backdrop = _plane("Sheet backdrop", 1.0, 1.0, back_material, collection)
    for item in (stage.sheet.plane, stage.sheet.backdrop):
        item.parent = stage.camera


def _aim(stage, cam):
    axes = (Vector(cam["right"]), Vector(cam["up"]), Vector(cam["back"]))
    rotation = Matrix((axes[0], axes[1], axes[2])).transposed()
    stage.camera.matrix_world = Matrix.Translation(cam["location"]) @ rotation.to_4x4()
    data = stage.camera.data
    data.lens = cam["lens"]
    data.sensor_width = plan.SENSOR_MM
    data.sensor_fit = "AUTO"
    data.clip_start = cam["clipStart"]
    data.clip_end = cam["clipEnd"]


def _fit_sheet(stage, ctx, cam):
    """Lay the sheet and its backdrop just inside the lens, the sheet fitted whole (letterboxed) in the frame."""
    distance = cam["clipStart"] * 40.0
    frame_aspect = ctx.width / ctx.height
    half_fov = math.atan(plan.SENSOR_MM / 2.0 / cam["lens"])
    # Width of the view at `distance` along the longer frame side, then each side in meters.
    long_side = 2.0 * distance * math.tan(half_fov)
    view_w, view_h = (long_side, long_side / frame_aspect) if frame_aspect >= 1.0 else (long_side * frame_aspect, long_side)
    scale_w = min(view_w, view_h * stage.sheet.aspect)
    scale_h = scale_w / stage.sheet.aspect
    stage.sheet.backdrop.scale = (view_w * 1.01, view_h * 1.01, 1.0)
    stage.sheet.backdrop.location = (0.0, 0.0, -distance * 1.001)
    stage.sheet.plane.scale = (scale_w, scale_h, 1.0)
    stage.sheet.plane.location = (0.0, 0.0, -distance)


def pose(stage, ctx, pose_dict):
    """Place everything for `pose_dict`."""
    cam = pose_dict["camera"]
    _aim(stage, cam)
    if "controls" in pose_dict:
        for ident, value in pose_dict["controls"].items():
            _seek(stage.controls.get(ident, []), timing_value(value))
        action = pose_dict.get("action")
        if action:
            _seek(stage.actions.get(action["id"], []), action["seconds"])
    if "parts" in pose_dict:
        _displace(stage, pose_dict["parts"])
    if stage.sheet is not None:
        _fit_sheet(stage, ctx, cam)
        for mix in stage.sheet.mixes:
            mix.inputs[0].default_value = pose_dict["sheetAlpha"]
    bpy.context.view_layer.update()
    for ident, label in stage.labels.items():
        placed = pose_dict["parts"].get(ident)
        rest = stage.rest.get(ident)
        label.hide_render = label.hide_viewport = not (placed and placed["visible"] and rest)
        if rest is not None and placed:
            low = Vector((float("inf"),) * 3)
            high = Vector((float("-inf"),) * 3)
            for corner in rest.obj.bound_box:
                point = rest.obj.matrix_world @ Vector(corner)
                low = Vector(min(low[axis], point[axis]) for axis in range(3))
                high = Vector(max(high[axis], point[axis]) for axis in range(3))
            label.location = ((low + high) / 2.0) + Vector((0.0, 0.0, (high.z - low.z) / 2.0 + stage.label_size * 1.6))


def timing_value(value):
    """A 0-1 control value as seconds into its one-second clip."""
    return max(0.0, min(1.0, value))


def _displace(stage, parts):
    """Move each part by its world displacement; a child of a moved part only moves by the difference."""
    for ident, rest in stage.rest.items():
        placed = parts.get(ident)
        world = Vector(placed["offset"]) if placed else Vector((0.0, 0.0, 0.0))
        parent_placed = parts.get(rest.parent_id) if rest.parent_id else None
        parent_world = Vector(parent_placed["offset"]) if parent_placed else Vector((0.0, 0.0, 0.0))
        rest.obj.delta_location = rest.delta + rest.parent_linear.inverted_safe() @ (world - parent_world)
        rest.obj.hide_render = rest.obj.hide_viewport = not (placed["visible"] if placed else True)
