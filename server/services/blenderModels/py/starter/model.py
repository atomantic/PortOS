"""A small desk lamp: the PortOS Blender model starter.

A model defines two functions; PortOS calls both in an empty Blender scene:

    describe(ctx) -> {"title", "sizeMeters": {"x", "y", "z"}, "triangleBudget", "parts": [...]}
    build(ctx)    -> None: one mesh object per declared part, named by its id

Build in meters, Z up, with the front of the model facing -Y. Each build is
measured against describe(): missing parts, size, triangles, scale and a
re-import of the exported GLB. Read the build's report.json, then fix and
build again.
"""

import bpy

BASE_RADIUS = 0.09
BASE_HEIGHT = 0.02
STEM_RADIUS = 0.012
STEM_HEIGHT = 0.36
SHADE_BOTTOM_RADIUS = 0.11
SHADE_TOP_RADIUS = 0.05
SHADE_HEIGHT = 0.14


def describe(ctx):
    return {
        "title": "Desk lamp",
        "sizeMeters": {
            "x": SHADE_BOTTOM_RADIUS * 2,
            "y": SHADE_BOTTOM_RADIUS * 2,
            "z": BASE_HEIGHT + STEM_HEIGHT + SHADE_HEIGHT,
        },
        "triangleBudget": 2000,
        "parts": [
            {"id": "base", "label": "Weighted base"},
            {"id": "stem", "label": "Stem", "parent": "base"},
            {"id": "shade", "label": "Shade", "parent": "stem"},
        ],
    }


def material(name, color, roughness):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1.0)
    shader.inputs["Roughness"].default_value = roughness
    return mat


def part(name, mat, parent=None):
    """Name the object just added after its part id, give it a material and a parent."""
    obj = bpy.context.active_object
    obj.name = name
    obj.data.name = name
    obj.data.materials.append(mat)
    if parent is not None:
        # Keep the world placement: the inverse cancels the parent's transform.
        obj.parent = parent
        obj.matrix_parent_inverse = parent.matrix_world.inverted()
    return obj


def build(ctx):
    sides = 16 if ctx.quality == "draft" else 48
    metal = material("lamp_metal", (0.08, 0.08, 0.09), 0.35)
    cloth = material("shade_cloth", (0.86, 0.78, 0.62), 0.9)

    bpy.ops.mesh.primitive_cylinder_add(vertices=sides, radius=BASE_RADIUS, depth=BASE_HEIGHT, location=(0, 0, BASE_HEIGHT / 2))
    base = part("base", metal)

    bpy.ops.mesh.primitive_cylinder_add(vertices=sides, radius=STEM_RADIUS, depth=STEM_HEIGHT, location=(0, 0, BASE_HEIGHT + STEM_HEIGHT / 2))
    stem = part("stem", metal, base)

    bpy.ops.mesh.primitive_cone_add(
        vertices=sides, radius1=SHADE_BOTTOM_RADIUS, radius2=SHADE_TOP_RADIUS, depth=SHADE_HEIGHT,
        location=(0, 0, BASE_HEIGHT + STEM_HEIGHT + SHADE_HEIGHT / 2),
    )
    part("shade", cloth, stem)
    ctx.log("Built the lamp with %d sides" % sides)
