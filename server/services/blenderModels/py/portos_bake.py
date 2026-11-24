"""Texture baking for PortOS Blender models (issue #17879).

Imported by portos_model_driver.py inside Blender. A model's describe() may ask for

    "bake": {"size": 2048, "samples": 32, "sets": [{"id": "body", "partIds": ["base", "stem"]}]}

and the driver then works in three stages, each its own Blender process so a
bake can be canceled and reused set by set:

  prepare_sets  (during the build)   unwrap parts without UVs, measure UV overlap,
                                     and hash what a set's bake depends on
  bake_set      (one process per set) Cycles bakes base color, a tangent normal
                                     map (from the parts and every `portos_bake_only`
                                     object) and packed occlusion/roughness/metal
  export_baked  (after every set)    drop the bake-only objects, give each set's
                                     parts one plain glTF material built from its
                                     images, export the GLB and re-import it

Everything here is standard bpy and numpy (both ship with Blender). Facts go
out through the `emit` the driver passes in.
"""

import hashlib
import math
import os

import bpy
import numpy as np

BAKE_ONLY = "portos_bake_only"
# A bake-only object names the sets it shapes in this custom property ("a,b"); absent means every set.
BAKE_SETS = "portos_bake_sets"
UV_NAME = "portos_bake_uv"
IMAGE_FILES = {"baseColor": "base_color.png", "normal": "normal.png", "orm": "orm.png"}
OVERLAP_GRID = 512
# Pixel centers are sampled off the grid so a shared edge on an exact boundary counts once.
SAMPLE_OFFSET = (0.5 + 0.0137, 0.5 + 0.0291)
MARGIN_PIXELS = 16
GLTF_OUTPUT_GROUP = "glTF Material Output"


def is_bake_only(obj):
    return bool(obj.get(BAKE_ONLY))


def bake_only_objects():
    return [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and is_bake_only(obj)]


def remove_bake_only():
    for obj in list(bake_only_objects()):
        bpy.data.objects.remove(obj, do_unlink=True)


def set_parts(spec):
    """The mesh objects of one set, or None when a named part is not a mesh in the scene."""
    objects = []
    for part_id in spec["partIds"]:
        obj = bpy.context.scene.objects.get(part_id)
        if obj is None or obj.type != "MESH" or is_bake_only(obj):
            return None
        objects.append(obj)
    return objects


def shapers_of(set_id):
    """The bake-only objects that shape `set_id`'s normal map."""
    shapers = []
    for obj in bake_only_objects():
        named = str(obj.get(BAKE_SETS, "")).replace(" ", "")
        if not named or set_id in named.split(","):
            shapers.append(obj)
    return shapers


def usable_sets(bake):
    """The sets of describe()'s bake that name an id and a list of part ids; the server judges the rest."""
    sets = bake.get("sets") if isinstance(bake, dict) else None
    usable = []
    for spec in sets if isinstance(sets, list) else []:
        if isinstance(spec, dict) and isinstance(spec.get("id"), str) and isinstance(spec.get("partIds"), list) \
                and all(isinstance(part, str) for part in spec["partIds"]):
            usable.append(spec)
    return usable


# ---------------------------------------------------------------- unwrap and overlap

def evaluated_mesh(obj):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    return obj.evaluated_get(depsgraph), depsgraph


def unwrap(objects):
    """Smart-project every object together so their islands share one 0-1 atlas."""
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        if not obj.data.uv_layers:
            obj.data.uv_layers.new(name=UV_NAME)
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.mode_set(mode="EDIT")
    try:
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=math.radians(66.0), island_margin=0.004)
        bpy.ops.uv.pack_islands(margin=0.004)
    finally:
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")


def uv_overlap(objects):
    """The fraction of the covered 0-1 area that two or more UV triangles cover."""
    grid = np.zeros((OVERLAP_GRID, OVERLAP_GRID), dtype=np.uint16)
    for obj in objects:
        evaluated, _ = evaluated_mesh(obj)
        mesh = evaluated.to_mesh()
        try:
            layer = mesh.uv_layers.active
            if layer is None:
                continue
            mesh.calc_loop_triangles()
            loops = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int64)
            mesh.loop_triangles.foreach_get("loops", loops)
            uv = np.empty(len(mesh.loops) * 2, dtype=np.float64)
            layer.data.foreach_get("uv", uv)
            points = uv.reshape(-1, 2)[loops].reshape(-1, 3, 2) * OVERLAP_GRID
            for triangle in points:
                rasterize(grid, triangle)
        finally:
            evaluated.to_mesh_clear()
    covered = int((grid >= 1).sum())
    return round(float((grid >= 2).sum()) / covered, 6) if covered else 0.0


def rasterize(grid, triangle):
    (x0, y0), (x1, y1), (x2, y2) = triangle
    low_x = max(int(math.floor(min(x0, x1, x2))), 0)
    high_x = min(int(math.ceil(max(x0, x1, x2))) + 1, OVERLAP_GRID)
    low_y = max(int(math.floor(min(y0, y1, y2))), 0)
    high_y = min(int(math.ceil(max(y0, y1, y2))) + 1, OVERLAP_GRID)
    if low_x >= high_x or low_y >= high_y:
        return
    area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
    if abs(area) < 1e-9:
        return
    xs, ys = np.meshgrid(np.arange(low_x, high_x) + SAMPLE_OFFSET[0], np.arange(low_y, high_y) + SAMPLE_OFFSET[1])
    w1 = ((xs - x0) * (y2 - y0) - (x2 - x0) * (ys - y0)) / area
    w2 = ((x1 - x0) * (ys - y0) - (xs - x0) * (y1 - y0)) / area
    inside = (w1 >= 0) & (w2 >= 0) & (w1 + w2 <= 1)
    grid[low_y:high_y, low_x:high_x] += inside.astype(np.uint16)


# ---------------------------------------------------------------- hashing

SKIP_NODE_PROPS = {"name", "label", "location", "width", "height", "width_hidden", "select", "show_options", "show_preview",
                   "show_texture", "hide", "rna_type", "bl_idname", "bl_label", "bl_description", "bl_icon", "bl_static_type",
                   "bl_width_default", "bl_width_min", "bl_width_max", "bl_height_default", "bl_height_min", "bl_height_max"}


def feed(digest, value):
    digest.update(repr(value).encode("utf-8"))
    digest.update(b"\x00")


def socket_value(socket):
    value = getattr(socket, "default_value", None)
    if value is None:
        return None
    try:
        return [round(float(item), 5) for item in value]
    except TypeError:
        return round(float(value), 5) if isinstance(value, (int, float)) else str(value)


def hash_tree(digest, tree, seen):
    """Node types, settings, input values and links; names of nodes that carry no meaning are left out."""
    if tree is None or id(tree) in seen:
        return
    seen.add(id(tree))
    nodes = sorted(tree.nodes, key=lambda node: node.name)
    for node in nodes:
        feed(digest, ("node", node.name, node.bl_idname))
        for prop in node.bl_rna.properties:
            if prop.identifier in SKIP_NODE_PROPS or prop.type not in ("BOOLEAN", "INT", "FLOAT", "ENUM", "STRING"):
                continue
            value = getattr(node, prop.identifier, None)
            feed(digest, (prop.identifier, tuple(value) if hasattr(value, "__len__") and not isinstance(value, str) else value))
        for socket in node.inputs:
            feed(digest, ("in", socket.identifier, socket_value(socket)))
        image = getattr(node, "image", None)
        if image is not None:
            feed(digest, ("image", image.filepath, image.size[0], image.size[1]))
        hash_tree(digest, getattr(node, "node_tree", None), seen)
    for link in sorted(tree.links, key=lambda item: (item.from_node.name, item.from_socket.identifier, item.to_node.name, item.to_socket.identifier)):
        feed(digest, ("link", link.from_node.name, link.from_socket.identifier, link.to_node.name, link.to_socket.identifier))


def hash_material(digest, material):
    if material is None:
        feed(digest, "no-material")
        return
    feed(digest, ("material", [round(float(item), 5) for item in material.diffuse_color]))
    if material.use_nodes:
        hash_tree(digest, material.node_tree, set())


def hash_geometry(digest, obj, with_materials):
    evaluated, _ = evaluated_mesh(obj)
    mesh = evaluated.to_mesh()
    try:
        matrix = obj.matrix_world
        feed(digest, ("object", obj.name, [round(float(item), 5) for row in matrix for item in row]))
        coords = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
        mesh.vertices.foreach_get("co", coords)
        digest.update(np.round(coords, 5).tobytes())
        loops = np.empty(len(mesh.loops), dtype=np.int64)
        mesh.loops.foreach_get("vertex_index", loops)
        digest.update(loops.tobytes())
        layer = mesh.uv_layers.active
        if layer is not None:
            uv = np.empty(len(mesh.loops) * 2, dtype=np.float64)
            layer.data.foreach_get("uv", uv)
            digest.update(np.round(uv, 5).tobytes())
        if with_materials:
            slots = [slot.material for slot in obj.material_slots]
            indices = np.empty(len(mesh.polygons), dtype=np.int64)
            mesh.polygons.foreach_get("material_index", indices)
            digest.update(indices.tobytes())
            for material in slots:
                hash_material(digest, material)
    finally:
        evaluated.to_mesh_clear()


def hash_set(spec, objects):
    """What this set's textures depend on: its parts' geometry, UVs and materials, and the objects that shape its normal map."""
    digest = hashlib.sha256()
    feed(digest, "portos-bake-v1")
    for obj in sorted(objects, key=lambda item: item.name):
        hash_geometry(digest, obj, True)
    for obj in sorted(shapers_of(spec["id"]), key=lambda item: item.name):
        feed(digest, "shaper")
        hash_geometry(digest, obj, False)
    return digest.hexdigest()


def prepare_sets(bake, emit, log):
    """Unwrap, measure overlap and hash each usable set; one `bakeSet` event per set."""
    for spec in usable_sets(bake):
        objects = set_parts(spec)
        if not objects:
            log("Bake set %s names a part that is not a mesh in the scene; the build report says which" % spec["id"])
            continue
        unwrapped = any(not obj.data.uv_layers for obj in objects)
        if unwrapped:
            unwrap(objects)
            log("Bake set %s: unwrapped %d part(s) into one atlas" % (spec["id"], len(objects)))
        else:
            # Only the active UV map is baked and exported, so the others go.
            for obj in objects:
                keep = obj.data.uv_layers.active
                for layer in [layer for layer in obj.data.uv_layers if layer != keep]:
                    obj.data.uv_layers.remove(layer)
        emit("bakeSet", id=spec["id"], partIds=spec["partIds"], hash=hash_set(spec, objects), uvOverlap=uv_overlap(objects), unwrapped=unwrapped)


# ---------------------------------------------------------------- baking

def choose_device(scene, requested, log):
    """GPU when Cycles finds one and `requested` is not "cpu", else CPU. Returns the device label."""
    scene.cycles.device = "CPU"
    if requested == "cpu":
        return "CPU"
    try:
        preferences = bpy.context.preferences.addons["cycles"].preferences
        for kind in ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI"):
            try:
                preferences.compute_device_type = kind
                preferences.get_devices()
            except (TypeError, RuntimeError):
                continue
            gpus = [device for device in preferences.devices if device.type != "CPU"]
            if gpus:
                for device in preferences.devices:
                    device.use = device.type != "CPU"
                scene.cycles.device = "GPU"
                log("Using the GPU (%s). The first bake on a machine compiles its kernels, which can take several minutes." % kind)
                return "GPU (%s)" % kind
    except (KeyError, AttributeError, RuntimeError) as error:
        log("No GPU bake device (%s); baking on the CPU" % error)
    return "CPU"


def new_image(name, size, color_space, color=(0.0, 0.0, 0.0, 1.0)):
    image = bpy.data.images.new(name, size, size, alpha=False, float_buffer=True)
    image.colorspace_settings.name = color_space
    image.generated_color = color
    return image


def principled_of(material):
    if not material.use_nodes:
        return None
    for node in material.node_tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            return node
    return None


def output_of(tree):
    outputs = [node for node in tree.nodes if node.type == "OUTPUT_MATERIAL"]
    for node in outputs:
        if node.is_active_output:
            return node
    return outputs[0] if outputs else tree.nodes.new("ShaderNodeOutputMaterial")


def emission_material(source, channel):
    """A copy of `source` that emits one Principled input (`Base Color`, `Roughness` or `Metallic`) as its color."""
    material = source.copy() if source.use_nodes else bpy.data.materials.new(source.name)
    material.use_nodes = True
    tree = material.node_tree
    principled = principled_of(material)
    emission = tree.nodes.new("ShaderNodeEmission")
    emission.inputs["Strength"].default_value = 1.0
    defaults = {"Base Color": tuple(source.diffuse_color), "Roughness": 0.5, "Metallic": 0.0}
    if principled is not None and channel in principled.inputs:
        socket = principled.inputs[channel]
        if socket.is_linked:
            tree.links.new(socket.links[0].from_socket, emission.inputs["Color"])
        else:
            value = socket.default_value
            emission.inputs["Color"].default_value = tuple(value) if channel == "Base Color" else (value, value, value, 1.0)
    else:
        value = defaults[channel]
        emission.inputs["Color"].default_value = tuple(value) if channel == "Base Color" else (value, value, value, 1.0)
    tree.links.new(emission.outputs["Emission"], output_of(tree).inputs["Surface"])
    return material


def target_node(material, image):
    node = material.node_tree.nodes.new("ShaderNodeTexImage")
    node.image = image
    material.node_tree.nodes.active = node
    node.select = True
    return node


def flat_materials(low):
    """Every slot of `low` holds a material, so each can take a bake target."""
    if not low.material_slots:
        low.data.materials.append(bpy.data.materials.new("portos_bake_default"))
    for slot in low.material_slots:
        if slot.material is None:
            slot.material = bpy.data.materials.new("portos_bake_default")


def apply_materials(low, originals, channel, image):
    for slot, source in zip(low.material_slots, originals):
        slot.material = emission_material(source, channel) if channel else bpy.data.materials.new("portos_bake_ao")
        slot.material.use_nodes = True
        target_node(slot.material, image)


def baked_copy(obj, name):
    """A world-space, modifier-applied copy of `obj` linked into the scene, with the active UV map under one name."""
    evaluated, depsgraph = evaluated_mesh(obj)
    mesh = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=depsgraph)
    mesh.transform(obj.matrix_world)
    copy = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(copy)
    if mesh.uv_layers:
        keep = mesh.uv_layers.active or mesh.uv_layers[0]
        for layer in [layer for layer in mesh.uv_layers if layer != keep]:
            mesh.uv_layers.remove(layer)
        mesh.uv_layers[0].name = UV_NAME
    return copy


def join_objects(objects, name):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    if len(objects) > 1:
        bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    joined.name = name
    return joined


def bake_pass(scene, low, bake_type, high=None, extent=1.0):
    bake = scene.render.bake
    bake.use_selected_to_active = bool(high)
    bake.margin = MARGIN_PIXELS
    bake.margin_type = "EXTEND"
    bake.use_clear = True
    bake.target = "IMAGE_TEXTURES"
    if high:
        bake.cage_extrusion = extent * 0.01
        bake.max_ray_distance = extent * 0.02
        bake.normal_space = "TANGENT"
    bpy.ops.object.select_all(action="DESELECT")
    for obj in high or []:
        obj.select_set(True)
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    bpy.ops.object.bake(type=bake_type)


def pixels_of(image):
    values = np.empty(len(image.pixels), dtype=np.float32)
    image.pixels.foreach_get(values)
    return values


def saved(image, path):
    scene = bpy.context.scene
    settings = scene.render.image_settings
    settings.file_format = "PNG"
    settings.color_mode = "RGB"
    settings.color_depth = "8"
    image.save_render(filepath=path, scene=scene)


def max_byte(values, channels):
    """The brightest color channel in `values` as 0-255, ignoring alpha."""
    shaped = values.reshape(-1, 4)[:, :channels]
    return int(round(float(shaped.max()) * 255)) if shaped.size else 0


def run_bake(scene, kind, log):
    """One bake pass; a GPU that refuses is retried on the CPU."""
    try:
        return kind()
    except RuntimeError as error:
        if scene.cycles.device == "GPU":
            log("GPU bake failed (%s); retrying on the CPU" % str(error).strip().splitlines()[-1])
            scene.cycles.device = "CPU"
            return kind()
        raise


def bake_set(job, emit, log):
    """Bake one set into `job["out"]`: base_color.png, normal.png and orm.png (R occlusion, G roughness, B metal)."""
    spec = job["set"]
    size = int(job["size"])
    scene = bpy.context.scene
    objects = set_parts(spec)
    if not objects:
        raise RuntimeError("Bake set %s names a part that is not a mesh in the scene" % spec["id"])
    scene.render.engine = "CYCLES"
    scene.cycles.samples = int(job["samples"])
    scene.cycles.use_denoising = False
    device = choose_device(scene, job.get("device"), log)
    log("Baking set %s at %d px, %d samples on %s" % (spec["id"], size, int(job["samples"]), device))

    shapers = shapers_of(spec["id"])
    high = [baked_copy(obj, "hi_%s" % obj.name) for obj in objects + shapers]
    lows = [baked_copy(obj, "lo_%s" % obj.name) for obj in objects]
    low = join_objects(lows, "portos_bake_low")
    flat_materials(low)
    originals = [slot.material for slot in low.material_slots]
    dimensions = low.dimensions
    extent = max(dimensions) or 1.0
    # Hide the originals so a ray from the low mesh cannot hit them instead of the copies.
    for obj in objects + shapers:
        obj.hide_viewport = True
        obj.hide_render = True

    world = bpy.data.worlds.new("portos_bake_world")
    world.light_settings.distance = max(extent * 0.25, 0.001)
    scene.world = world

    images = {name: new_image("portos_%s" % name, size, "sRGB" if name == "baseColor" else "Non-Color") for name in IMAGE_FILES}
    rough = new_image("portos_rough", size, "Non-Color")
    metal = new_image("portos_metal", size, "Non-Color")
    occlusion = new_image("portos_occlusion", size, "Non-Color")

    def bake_into(image, bake_type, channel=None, high_objects=None):
        apply_materials(low, originals, channel, image)
        run_bake(scene, lambda: bake_pass(scene, low, bake_type, high_objects, extent), log)

    bake_into(images["baseColor"], "EMIT", "Base Color")
    bake_into(rough, "EMIT", "Roughness")
    bake_into(metal, "EMIT", "Metallic")
    bake_into(occlusion, "AO")
    # The normal map lands on materials that still need a target image.
    apply_materials(low, originals, "Base Color", images["normal"])
    run_bake(scene, lambda: bake_pass(scene, low, "NORMAL", high, extent), log)

    orm = np.ones(size * size * 4, dtype=np.float32)
    orm.reshape(-1, 4)[:, 0] = pixels_of(occlusion).reshape(-1, 4)[:, 0]
    orm.reshape(-1, 4)[:, 1] = pixels_of(rough).reshape(-1, 4)[:, 0]
    orm.reshape(-1, 4)[:, 2] = pixels_of(metal).reshape(-1, 4)[:, 0]
    images["orm"].pixels.foreach_set(orm)

    os.makedirs(job["out"], exist_ok=True)
    report = []
    for name, filename in IMAGE_FILES.items():
        path = os.path.join(job["out"], filename)
        saved(images[name], path)
        report.append({"name": name, "file": filename, "max": max_byte(pixels_of(images[name]), 3)})
    emit("bakeResult", id=spec["id"], size=size, samples=int(job["samples"]), device=device, images=report)


# ---------------------------------------------------------------- export

def gltf_output_group():
    group = bpy.data.node_groups.get(GLTF_OUTPUT_GROUP)
    if group is None:
        group = bpy.data.node_groups.new(GLTF_OUTPUT_GROUP, "ShaderNodeTree")
        group.interface.new_socket("Occlusion", socket_type="NodeSocketFloat")
        group.nodes.new("NodeGroupOutput")
        group.nodes.new("NodeGroupInput").location = (-200, 0)
    return group


def baked_material(spec, directory, blend_dir):
    """Plain glTF materials: base color, packed occlusion/roughness/metal and a tangent normal map."""
    material = bpy.data.materials.new("bake_%s" % spec["id"])
    material.use_nodes = True
    tree = material.node_tree
    shader = principled_of(material)

    def texture(filename, color_space, x, y):
        node = tree.nodes.new("ShaderNodeTexImage")
        image = bpy.data.images.load(os.path.join(directory, filename), check_existing=False)
        image.colorspace_settings.name = color_space
        image.filepath = bpy.path.relpath(image.filepath, start=blend_dir)
        node.image = image
        node.location = (x, y)
        return node

    base = texture(IMAGE_FILES["baseColor"], "sRGB", -700, 300)
    orm = texture(IMAGE_FILES["orm"], "Non-Color", -700, -50)
    normal = texture(IMAGE_FILES["normal"], "Non-Color", -700, -400)
    tree.links.new(base.outputs["Color"], shader.inputs["Base Color"])
    split = tree.nodes.new("ShaderNodeSeparateColor")
    split.location = (-420, -50)
    tree.links.new(orm.outputs["Color"], split.inputs["Color"])
    tree.links.new(split.outputs["Green"], shader.inputs["Roughness"])
    tree.links.new(split.outputs["Blue"], shader.inputs["Metallic"])
    occlusion = tree.nodes.new("ShaderNodeGroup")
    occlusion.node_tree = gltf_output_group()
    occlusion.location = (-200, -250)
    tree.links.new(split.outputs["Red"], occlusion.inputs["Occlusion"])
    bump = tree.nodes.new("ShaderNodeNormalMap")
    bump.space = "TANGENT"
    bump.location = (-420, -400)
    tree.links.new(normal.outputs["Color"], bump.inputs["Color"])
    tree.links.new(bump.outputs["Normal"], shader.inputs["Normal"])
    return material


def export_baked(job, emit, log):
    """Replace each baked set's materials with its glTF material and drop the bake-only objects."""
    blend_dir = os.path.dirname(job["blend"])
    remove_bake_only()
    for spec in job["sets"]:
        objects = set_parts(spec)
        if not objects:
            raise RuntimeError("Bake set %s names a part that is not a mesh in the scene" % spec["id"])
        material = baked_material(spec, spec["dir"], blend_dir)
        for obj in objects:
            obj.data.materials.clear()
            obj.data.materials.append(material)
            for polygon in obj.data.polygons:
                polygon.material_index = 0
        log("Set %s: %d part(s) use one material from its baked images" % (spec["id"], len(objects)))
