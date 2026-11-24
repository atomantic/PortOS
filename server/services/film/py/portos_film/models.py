"""Load a model copied into the film (src/models/<slug>.glb) into a Blender shot.

PortOS puts the copy there from its 3D library (Files tab, "Add 3D model").
Needs Blender's `bpy`, so import this module inside `build_shot`, not at the
top of a file the system-Python describe step also reads.

    from portos_film import models
    root, actions = models.load(ctx, "robot", height=1.8)

Every file loaded is recorded so a render made with it reads as stale once the
copy changes, without listing it in a shot's `deps`.
"""

import os
import re

import bpy
from mathutils import Vector

_SLUG = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_-]*$")
_loaded = set()
_NOT_EXPORTED = "glTF_not_exported"


def reset():
    """Forget what earlier shots loaded (the driver calls this before each shot)."""
    _loaded.clear()


def loaded():
    """src/-relative paths of the models loaded since the last reset, sorted."""
    return sorted(_loaded)


def _world_bounds(objects):
    low = Vector((float("inf"),) * 3)
    high = Vector((float("-inf"),) * 3)
    found = False
    for obj in objects:
        if obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            point = obj.matrix_world @ Vector(corner)
            low = Vector((min(low[i], point[i]) for i in range(3)))
            high = Vector((max(high[i], point[i]) for i in range(3)))
            found = True
    return (low, high) if found else None


def load(ctx, slug, height=None, settle=None):
    """Import src/models/<slug>.glb under one empty and return `(root, actions)`.

    `height` (meters) scales the model uniformly so its bounding box is that
    tall; the model then sits on z = 0. Without it the file keeps its own size
    and is only grounded. `actions` maps each animation the file carried to its
    Blender action. Blender's importer leaves the first one playing on the
    scene's timeline; `settle()`, called before the model is measured, can stop
    it and set the pose to stand on z = 0 in. Raises RuntimeError when the model is not in src/models/.
    """
    if not isinstance(slug, str) or not _SLUG.match(slug):
        raise RuntimeError("models.load: %r is not a model slug (letters, digits, - and _)" % (slug,))
    relative = "models/%s.glb" % slug
    path = os.path.join(ctx.src, "models", slug + ".glb")
    if not os.path.isfile(path):
        raise RuntimeError("models.load: src/%s is missing; add it from the Files tab" % relative)
    _loaded.add(relative)

    objects_before = set(bpy.data.objects)
    actions_before = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=path)
    # The importer parks a rigged file's bone-shape helper (an Icosphere) in a hidden collection; it is not part of the model.
    imported = [obj for obj in bpy.data.objects
                if obj not in objects_before and not any(coll.name == _NOT_EXPORTED for coll in obj.users_collection)]
    new_actions = {action.name: action for action in bpy.data.actions if action not in actions_before}

    root = bpy.data.objects.new(slug, None)
    bpy.context.scene.collection.objects.link(root)
    for obj in imported:
        if obj.parent is None or obj.parent not in imported:
            obj.parent = root
    if settle is not None:
        settle()
    bpy.context.view_layer.update()

    bounds = _world_bounds(imported)
    if bounds and height is not None:
        current = bounds[1].z - bounds[0].z
        if current > 1e-9 and height > 0:
            factor = float(height) / current
            root.scale = (factor, factor, factor)
            bpy.context.view_layer.update()
            bounds = _world_bounds(imported)
    if bounds:
        root.location.z -= bounds[0].z
        bpy.context.view_layer.update()
    return root, new_actions
