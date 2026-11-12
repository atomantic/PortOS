"""The starter film's set: a round stage, three figures and lights that follow the song.

`build(ctx, palette)` makes the scene and returns its moving parts; `pose(stage,
ctx, t)` places every one of them for song time `t`. Each frame is a pure
function of `t`, so a render can stop and resume on any frame.
"""

import math
from types import SimpleNamespace

import bmesh
import bpy
from mathutils import Vector

from portos_film import music, timing

from kit import look

BAR_COUNT = 21
SPARK_COUNT = 36
STAGE_CENTER = Vector((0.0, 0.0, 0.0))


def _object(name, build, collection, smooth=False):
    mesh = bpy.data.meshes.new(name)
    scratch = bmesh.new()
    build(scratch)
    scratch.to_mesh(mesh)
    scratch.free()
    if smooth:
        for polygon in mesh.polygons:
            polygon.use_smooth = True
    made = bpy.data.objects.new(name, mesh)
    collection.objects.link(made)
    return made


def _cylinder(radius_bottom, radius_top, depth, segments=48):
    return lambda mesh: bmesh.ops.create_cone(
        mesh, cap_ends=True, cap_tris=False, segments=segments,
        radius1=radius_bottom, radius2=radius_top, depth=depth)


def _sphere(radius, segments=32):
    return lambda mesh: bmesh.ops.create_uvsphere(mesh, u_segments=segments, v_segments=segments // 2, radius=radius)


def aim(item, target):
    """Point a camera or a light (which look down -Z) at `target`."""
    direction = Vector(target) - item.location
    item.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def _light(name, kind, color, location, target, collection, size=2.0, cone=50.0):
    data = bpy.data.lights.new(name, kind)
    data.color = color
    if kind == "AREA":
        data.shape = "DISK"
        data.size = size
    else:
        data.spot_size = math.radians(cone)
        data.spot_blend = 0.5
        data.shadow_soft_size = 0.35
    made = bpy.data.objects.new(name, data)
    made.location = location
    collection.objects.link(made)
    aim(made, target)
    return made


def _figure(index, color, x, collection):
    """A body, a head and an instrument: enough to read as a player from any distance."""
    skin = look.material("Figure %d" % index, color, roughness=0.45)
    root = bpy.data.objects.new("Figure %d root" % index, None)
    root.location = (x, 0.35 if index == 1 else 0.0, 0.25)
    collection.objects.link(root)
    body = _object("Figure %d body" % index, _cylinder(0.44, 0.24, 1.15), collection, smooth=True)
    body.location = (0.0, 0.0, 0.6)
    head = _object("Figure %d head" % index, _sphere(0.32), collection, smooth=True)
    head.location = (0.0, 0.0, 1.5)
    prop_color = (0.9, 0.9, 0.95)
    prop_material = look.material("Figure %d prop" % index, prop_color, roughness=0.25, metallic=0.8)
    if index == 0:
        prop = _object("Keys", lambda mesh: bmesh.ops.create_cube(mesh, size=1.0), collection)
        prop.scale = (0.95, 0.3, 0.09)
        prop.location = (0.0, -0.45, 0.95)
    elif index == 1:
        prop = _object("Mic stand", _cylinder(0.025, 0.025, 1.35, segments=12), collection)
        prop.location = (0.0, -0.5, 0.68)
    else:
        prop = _object("Drum", _cylinder(0.36, 0.36, 0.4), collection, smooth=True)
        prop.location = (0.0, -0.5, 0.55)
    for part in (body, head):
        part.data.materials.append(skin)
        part.parent = root
    prop.data.materials.append(prop_material)
    prop.parent = root
    return SimpleNamespace(root=root, body=body, head=head, base=Vector(root.location), phase=index * 0.37)


def build(ctx, palette="dusk"):
    """Build the whole set in the current scene and return its moving parts."""
    colors = look.PALETTES[palette]
    scene = bpy.context.scene
    collection = scene.collection
    look.sky(scene, colors["sky"])

    floor = _object("Floor", lambda mesh: bmesh.ops.create_grid(mesh, x_segments=1, y_segments=1, size=40.0), collection)
    floor.data.materials.append(look.material("Floor", colors["floor"], roughness=0.22, metallic=0.3))
    riser = _object("Riser", _cylinder(4.4, 4.4, 0.25, segments=72), collection, smooth=True)
    riser.location = (0.0, 0.0, 0.125)
    riser.data.materials.append(look.material("Riser", (0.09, 0.09, 0.12), roughness=0.35))
    edge = _object("Riser edge", _cylinder(4.5, 4.5, 0.05, segments=72), collection, smooth=True)
    edge.location = (0.0, 0.0, 0.02)
    edge_material = look.material("Riser edge", colors["rim"][0], glow=3.0)
    edge.data.materials.append(edge_material)

    # A fan of light bars behind the band: each one is a column of the song's spectrum.
    bars = []
    for index in range(BAR_COUNT):
        spread = index / (BAR_COUNT - 1) - 0.5
        angle = math.radians(90.0 + spread * 150.0)
        bar = _object("Bar %d" % index, lambda mesh: bmesh.ops.create_cube(mesh, size=1.0), collection)
        bar.location = (math.cos(angle) * 9.0, math.sin(angle) * 9.0, 0.0)
        bar.rotation_euler = (0.0, 0.0, angle + math.pi / 2)
        mix = abs(spread) * 2.0
        tint = tuple(colors["rim"][0][c] * (1.0 - mix) + colors["rim"][1][c] * mix for c in range(3))
        made = look.material("Bar %d" % index, tint, glow=2.0)
        bar.data.materials.append(made)
        bars.append(SimpleNamespace(item=bar, material=made, spread=spread))

    sun = _object("Sun", _sphere(1.5, segments=48), collection, smooth=True)
    sun.location = (0.0, 7.0, 4.2)
    sun_material = look.material("Sun", colors["sun"], glow=6.0)
    sun.data.materials.append(sun_material)

    sparks = []
    spark_material = look.material("Sparks", colors["rim"][1], glow=3.5)
    for index in range(SPARK_COUNT):
        spark = _object("Spark %d" % index, lambda mesh: bmesh.ops.create_icosphere(mesh, subdivisions=1, radius=0.06), collection)
        spark.data.materials.append(spark_material)
        # Fixed pseudo-random placement: the same film every time it renders.
        seed = math.sin(index * 12.9898) * 43758.5453
        sparks.append(SimpleNamespace(
            item=spark, radius=3.0 + (seed - math.floor(seed)) * 6.0,
            height=1.2 + ((index * 7) % 11) * 0.42, offset=index * (2.0 * math.pi / SPARK_COUNT), speed=0.06 + (index % 5) * 0.015))

    cast = [_figure(index, colors["cast"][index], x, collection) for index, x in enumerate((-1.9, 0.0, 1.9))]

    key = _light("Key", "AREA", colors["key"], (-4.5, -6.5, 6.5), (0.0, 0.0, 1.2), collection, size=4.0)
    fill = _light("Fill", "AREA", colors["rim"][0], (6.0, -5.0, 3.0), (0.0, 0.0, 1.0), collection, size=5.0)
    rims = [
        _light("Rim left", "SPOT", colors["rim"][0], (-5.5, 5.0, 5.5), (0.0, 0.0, 1.2), collection, cone=55.0),
        _light("Rim right", "SPOT", colors["rim"][1], (5.5, 5.0, 5.5), (0.0, 0.0, 1.2), collection, cone=55.0),
    ]

    if ctx.engine != "CYCLES":
        scene.eevee.use_raytracing = True
    look.grade(scene)
    look.bloom(scene)
    return SimpleNamespace(
        scene=scene, collection=collection, colors=colors, bars=bars, sun=sun, sun_material=sun_material,
        edge_material=edge_material, sparks=sparks, cast=cast, key=key, fill=fill, rims=rims)


def add_camera(stage, lens=35.0):
    data = bpy.data.cameras.new("Camera")
    data.lens = lens
    data.sensor_width = 36.0
    data.clip_start = 0.1
    data.clip_end = 200.0
    camera = bpy.data.objects.new("Camera", data)
    stage.collection.objects.link(camera)
    stage.scene.camera = camera
    return camera


def pose(stage, ctx, t):
    """Place everything for song time `t`."""
    song = ctx.song
    low = music.envelope(song, "low", t)
    mid = music.envelope(song, "mid", t)
    high = music.envelope(song, "high", t)
    loud = music.envelope(song, "rms", t)
    hit = music.pulse(song, t, decay=3.0)
    beat, _ = music.beat_phase(song, t)

    for bar in stage.bars:
        # Low notes live in the middle of the fan, high ones at its edges; each
        # bar reads the song slightly earlier than its neighbour, so levels ripple outward.
        edge = abs(bar.spread) * 2.0
        level = low * (1.0 - edge) + high * edge + mid * 0.35
        level = timing.clamp(music.envelope(song, "rms", max(0.0, t - edge * 0.12)) * 0.4 + level * 0.9)
        height = 0.8 + level * 6.5
        bar.item.scale = (0.5, 0.18, height)
        bar.item.location.z = height / 2.0
        look.set_glow(bar.material, 0.35 + level * 2.6)

    swell = 1.0 + low * 0.35 + hit * 0.08
    stage.sun.scale = (swell, swell, swell)
    look.set_glow(stage.sun_material, 1.6 + low * 3.2 + hit * 1.2)
    look.set_glow(stage.edge_material, 0.8 + hit * 4.0)

    for spark in stage.sparks:
        angle = spark.offset + t * spark.speed * 2.0 * math.pi
        lift = math.sin(t * 0.7 + spark.offset * 3.0) * 0.35 + high * 0.9
        spark.item.location = (math.cos(angle) * spark.radius, math.sin(angle) * spark.radius, spark.height + lift)
        size = 0.7 + high * 2.2
        spark.item.scale = (size, size, size)

    # The band moves on twos: poses hold for two frames, as in drawn animation.
    held = timing.stepped(t, ctx.fps, on=2)
    held_hit = music.pulse(song, held, decay=2.2)
    for figure in stage.cast:
        bounce = held_hit * (0.22 + loud * 0.3)
        squash = 1.0 - held_hit * 0.12
        figure.root.location = figure.base + Vector((0.0, 0.0, bounce))
        figure.root.scale = (1.0 + (1.0 - squash) * 0.6, 1.0 + (1.0 - squash) * 0.6, squash + bounce * 0.25)
        figure.root.rotation_euler = (0.0, math.sin(held * 2.1 + figure.phase * 6.0) * 0.12, math.sin(held * 1.3 + figure.phase * 4.0) * 0.35)
        figure.head.location.z = 1.5 + math.sin(held * 4.0 + figure.phase * 5.0) * 0.04 + held_hit * 0.08

    stage.key.data.energy = 650.0 + loud * 450.0
    stage.fill.data.energy = 60.0 + mid * 120.0
    # The rim lights trade hits: left on even beats, right on odd ones.
    for index, rim in enumerate(stage.rims):
        mine = hit if beat % 2 == index else hit * 0.25
        rim.data.energy = 500.0 + mine * 2600.0 + high * 600.0
