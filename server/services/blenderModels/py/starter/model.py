"""A small desk lamp: the PortOS Blender model starter.

A model defines two functions; PortOS calls both in an empty Blender scene:

    describe(ctx) -> {"title", "sizeMeters": {"x", "y", "z"}, "triangleBudget", "parts": [...]}
    build(ctx)    -> None: one mesh object per declared part, named by its id

Build in meters, Z up, with the front of the model facing -Y. Each build is
measured against describe(): missing parts, size, triangles, scale and a
re-import of the exported GLB. Read the build's report.json, then fix and
build again.

describe() also asks for a texture bake. A full build bakes each set into base
color, normal and packed occlusion/roughness/metal images and exports a GLB
that uses them; a draft build skips the bake and keeps the plain materials.
`base_bolts` is modeled only to shape the metal set's normal map: it is marked
bake-only, so it stays out of the GLB and the triangle count.
"""

import bpy
from portos_model import bolt_circle, mark_bake_only, worn_metal_material

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
        "bake": {
            "size": 1024,
            "samples": 16,
            "sets": [
                {"id": "metal", "partIds": ["base", "stem"]},
                {"id": "cloth", "partIds": ["shade"]},
            ],
        },
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
    # Primitives come with UVs that all cover the same 0-1 square. With none, PortOS unwraps each bake set into one atlas.
    for layer in list(obj.data.uv_layers):
        obj.data.uv_layers.remove(layer)
    if parent is not None:
        # Keep the world placement: the inverse cancels the parent's transform.
        obj.parent = parent
        obj.matrix_parent_inverse = parent.matrix_world.inverted()
    return obj


def build(ctx):
    sides = 16 if ctx.quality == "draft" else 48
    # Worn paint is procedural, so it only pays off where it will be baked.
    if ctx.quality == "full":
        metal = worn_metal_material("lamp_metal", base_color=(0.08, 0.08, 0.09), worn_color=(0.6, 0.6, 0.62), edge_wear=0.6, grime=0.5)
    else:
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

    # Six bolt heads on the base: detail for the normal map, not for the GLB.
    bolts = bolt_circle("base_bolts", BASE_RADIUS * 0.7, 6, 0.008, 0.004, location=(0, 0, BASE_HEIGHT))
    mark_bake_only(bolts, "metal")
    ctx.log("Built the lamp with %d sides" % sides)
