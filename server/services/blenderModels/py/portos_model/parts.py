"""Part builders: bolt circle, hinge barrel, pipe with bends, lathe. Meters, Z up; each returns one mesh object."""

import math

import bmesh
import bpy
from mathutils import Matrix, Vector

AXIS_ROTATIONS = {
    "X": Matrix.Rotation(math.radians(90.0), 4, "Y"),
    "Y": Matrix.Rotation(math.radians(-90.0), 4, "X"),
    "Z": Matrix.Identity(4),
}


def object_from(name, bm, location):
    """Turn `bm` into a mesh object named `name` at `location`, with outward normals."""
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = location
    bpy.context.scene.collection.objects.link(obj)
    return obj


def add_prism(bm, radius, depth, sides, center, rotation=0.0):
    matrix = Matrix.Translation(center) @ Matrix.Rotation(rotation, 4, "Z")
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=sides, radius1=radius, radius2=radius, depth=depth, matrix=matrix)


def lathe(name, profile, segments=32, location=(0.0, 0.0, 0.0)):
    """A solid of revolution around Z. `profile` is a list of (radius, z) points from one end to the other.

    A point with radius 0 is an apex; an end with a radius is closed by a flat cap.
    """
    if len(profile) < 2:
        raise ValueError("lathe needs at least two profile points")
    bm = bmesh.new()
    rings = []
    for radius, z in profile:
        if radius <= 1e-9:
            rings.append([bm.verts.new((0.0, 0.0, z))])
        else:
            rings.append([bm.verts.new((radius * math.cos(2 * math.pi * i / segments), radius * math.sin(2 * math.pi * i / segments), z))
                          for i in range(segments)])
    for low, high in zip(rings, rings[1:]):
        for i in range(segments):
            j = (i + 1) % segments
            if len(low) == 1:
                bm.faces.new((low[0], high[j], high[i]))
            elif len(high) == 1:
                bm.faces.new((low[i], low[j], high[0]))
            else:
                bm.faces.new((low[i], low[j], high[j], high[i]))
    for end in (rings[0], rings[-1]):
        if len(end) > 1:
            bm.faces.new(end)
    return object_from(name, bm, location)


def bolt_circle(name, radius, count, head_radius, head_height, location=(0.0, 0.0, 0.0), sides=6, start_angle=0.0):
    """`count` bolt heads (hexagonal by default) on a circle in the XY plane, standing on it along +Z, as one object."""
    bm = bmesh.new()
    for index in range(count):
        angle = start_angle + 2 * math.pi * index / count
        center = Vector((radius * math.cos(angle), radius * math.sin(angle), head_height / 2))
        add_prism(bm, head_radius, head_height, sides, center, rotation=angle)
    return object_from(name, bm, location)


def hinge_barrel(name, length, radius, knuckles=3, gap=0.0015, axis="Y", location=(0.0, 0.0, 0.0), sides=24):
    """A hinge barrel along `axis` ("X", "Y" or "Z"): `knuckles` cylinders with a small gap between, centered on `location`."""
    if axis not in AXIS_ROTATIONS:
        raise ValueError("axis must be X, Y or Z")
    knuckles = max(1, int(knuckles))
    each = (length - gap * (knuckles - 1)) / knuckles
    if each <= 0:
        raise ValueError("the knuckle gaps are longer than the barrel")
    bm = bmesh.new()
    for index in range(knuckles):
        z = -length / 2 + each / 2 + index * (each + gap)
        add_prism(bm, radius, each, sides, Vector((0.0, 0.0, z)))
    bmesh.ops.transform(bm, matrix=AXIS_ROTATIONS[axis], verts=bm.verts)
    return object_from(name, bm, location)


def rounded_path(points, bend_radius, steps=6):
    """`points` with each interior corner replaced by an arc of `bend_radius` (clamped to fit its legs)."""
    path = [Vector(points[0])]
    for before, corner, after in zip(points, points[1:], points[2:]):
        before, corner, after = Vector(before), Vector(corner), Vector(after)
        into = (corner - before).normalized()
        out = (after - corner).normalized()
        angle = math.acos(max(-1.0, min(1.0, into.dot(out))))
        if angle < 1e-4:
            path.append(corner)
            continue
        # The arc leaves the legs `reach` before and after the corner.
        reach = min(bend_radius * math.tan(angle / 2), (corner - before).length / 2, (after - corner).length / 2)
        start = corner - into * reach
        end = corner + out * reach
        for step in range(steps + 1):
            t = step / steps
            # A quadratic Bezier through the corner is a close, smooth bend.
            path.append((1 - t) ** 2 * start + 2 * (1 - t) * t * corner + t ** 2 * end)
    path.append(Vector(points[-1]))
    return path


def pipe(name, points, radius, bend_radius=None, sides=16, steps=6, location=(0.0, 0.0, 0.0)):
    """A round pipe along the polyline `points`, its corners bent to `bend_radius` (default 3 x radius), ends capped."""
    if len(points) < 2:
        raise ValueError("pipe needs at least two points")
    path = rounded_path(points, bend_radius if bend_radius is not None else radius * 3, steps)
    bm = bmesh.new()
    rings = []
    normal = None
    for index, point in enumerate(path):
        tangent = ((path[min(index + 1, len(path) - 1)] - path[max(index - 1, 0)])).normalized()
        if normal is None:
            seed = Vector((0.0, 0.0, 1.0)) if abs(tangent.z) < 0.9 else Vector((1.0, 0.0, 0.0))
            normal = tangent.cross(seed).normalized()
        else:
            # Parallel transport: keep the frame from twisting along the bends.
            normal = (normal - tangent * normal.dot(tangent)).normalized()
        side = tangent.cross(normal)
        rings.append([bm.verts.new(point + (normal * math.cos(2 * math.pi * i / sides) + side * math.sin(2 * math.pi * i / sides)) * radius)
                      for i in range(sides)])
    for low, high in zip(rings, rings[1:]):
        for i in range(sides):
            j = (i + 1) % sides
            bm.faces.new((low[i], low[j], high[j], high[i]))
    bm.faces.new(rings[0])
    bm.faces.new(list(reversed(rings[-1])))
    return object_from(name, bm, location)
