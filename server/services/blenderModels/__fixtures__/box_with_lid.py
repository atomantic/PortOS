"""A box with a hinged lid and a clip that only closes on a shut lid: the moving-parts fixture.

PORTOS_FIXTURE_AXIS_INSET moves the lid's hinge axis in from the back edge, over the box, by that many meters.
"""

import os

import bpy

WIDTH, DEPTH, HEIGHT, WALL, LID = 0.3, 0.2, 0.15, 0.01, 0.012
# The lid rests this far above the rim, so nothing touches as built.
GAP = 0.001
AXIS_INSET = float(os.environ.get("PORTOS_FIXTURE_AXIS_INSET", "0"))
TOP = HEIGHT + GAP + LID


def describe(ctx):
    return {
        "title": "Box with a lid",
        "sizeMeters": {"x": WIDTH, "y": DEPTH + 0.004, "z": TOP + 0.0041},
        "triangleBudget": 400,
        "parts": [
            {"id": "box", "label": "Box"},
            {"id": "lid", "label": "Lid", "parent": "box"},
            {"id": "knob", "label": "Knob", "parent": "lid"},
            {"id": "clip", "label": "Clip", "parent": "box"},
        ],
        "controls": [
            {
                "id": "lid", "label": "Lid", "type": "hinge", "partId": "lid",
                "origin": [0, DEPTH / 2 - AXIS_INSET, HEIGHT + GAP], "axis": [-1, 0, 0], "min": 0, "max": 110, "default": 0,
            },
            {
                "id": "clip", "label": "Clip", "type": "slide", "partId": "clip",
                "origin": [0, -DEPTH / 2, 0.05], "axis": [1, 0, 0], "min": 0, "max": 0.1, "default": 0,
                "dependsOn": [{"control": "lid", "atMost": 0.02}],
            },
        ],
        "actions": [{"id": "open", "label": "Open", "seconds": 1}],
    }


def pose(ctx, action, t):
    return {"lid": t}


def part(name, parent, size, at):
    x, y, z = (side / 2 for side in size)
    vertices = [(sx * x, sy * y, sz * z) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = at
    bpy.context.view_layer.update()
    if parent is not None:
        obj.parent = parent
        obj.matrix_parent_inverse = parent.matrix_world.inverted()
    return obj


def build(ctx):
    box = open_box()
    lid = part("lid", box, (WIDTH, DEPTH, LID), (0, 0, HEIGHT + GAP + LID / 2))
    part("knob", lid, (0.02, 0.02, 0.004), (0, -DEPTH / 2 + 0.03, TOP + 0.0021))
    part("clip", box, (0.03, 0.003, 0.02), (-0.05, -DEPTH / 2 - 0.0025, 0.1))


def open_box():
    """Four walls and a floor as one mesh, open at the top."""
    x, y = WIDTH / 2, DEPTH / 2
    ix, iy = x - WALL, y - WALL
    outer = [(-x, -y), (x, -y), (x, y), (-x, y)]
    inner = [(-ix, -iy), (ix, -iy), (ix, iy), (-ix, iy)]
    vertices = [(*p, 0) for p in outer] + [(*p, HEIGHT) for p in outer] + [(*p, HEIGHT) for p in inner] + [(*p, WALL) for p in inner]
    faces = [(3, 2, 1, 0), (12, 13, 14, 15)]
    for i in range(4):
        j = (i + 1) % 4
        faces += [(i, j, 4 + j, 4 + i), (4 + i, 4 + j, 8 + j, 8 + i), (8 + i, 8 + j, 12 + j, 12 + i)]
    mesh = bpy.data.meshes.new("box")
    mesh.from_pydata(vertices, [], faces)
    obj = bpy.data.objects.new("box", mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj
