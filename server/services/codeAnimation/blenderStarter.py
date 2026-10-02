"""Original procedural scene: a paper lantern crossing a painted night garden.
No downloads, add-ons, external assets or live simulation. All motion is baked.
"""
import bpy
import math
import random
from mathutils import Vector


def build_scene(config):
    rng = random.Random(config['seed'])
    scene = bpy.context.scene
    if scene.world is None:
        scene.world = bpy.data.worlds.new('Painted night')
    scene.world.color = (0.025, 0.04, 0.09)
    scene.view_settings.view_transform = 'Standard'
    # Original pigment atlas: layered irregular brush marks, packed by driver.
    size = 128
    image = bpy.data.images.new('Original pigment brush atlas', width=size, height=size)
    pixels = []
    for y in range(size):
        for x in range(size):
            pigment = 0.62 + 0.18 * math.sin(x * .19 + math.sin(y * .11) * 3) + rng.uniform(-.13, .13)
            pixels.extend((pigment, pigment, pigment, 1))
    image.pixels = pixels
    image.pack()

    def material(name, color, glow=0):
        mat = bpy.data.materials.new(name)
        mat.diffuse_color = (*color, 1)
        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        bsdf = nodes.get('Principled BSDF')
        tex = nodes.new('ShaderNodeTexImage')
        tex.image = image
        tex.projection = 'BOX'
        tex.projection_blend = .25
        coordinate = nodes.new('ShaderNodeTexCoord')
        mat.node_tree.links.new(coordinate.outputs['Generated'], tex.inputs['Vector'])
        mix = nodes.new('ShaderNodeMixRGB')
        mix.blend_type = 'MULTIPLY'
        mix.inputs[0].default_value = .75
        mix.inputs[1].default_value = (*color, 1)
        mat.node_tree.links.new(tex.outputs['Color'], mix.inputs[2])
        mat.node_tree.links.new(mix.outputs[0], bsdf.inputs['Base Color'])
        bsdf.inputs['Roughness'].default_value = .92
        bsdf.inputs['Emission Color'].default_value = (*color, 1)
        bsdf.inputs['Emission Strength'].default_value = glow
        return mat

    indigo = material('Ultramarine pigment', (.055, .09, .22), .25)
    teal = material('Viridian pigment', (.05, .32, .33), .25)
    coral = material('Vermilion paper', (.95, .25, .12), .3)
    gold = material('Warm lantern light', (1, .63, .2), 1.4)
    cream = material('Ivory dry brush', (.94, .83, .59), .3)

    def sphere(name, location, scale, mat, subdivisions=1):
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=1, location=location)
        obj = bpy.context.object
        obj.name = name
        obj.scale = scale
        obj.data.materials.append(mat)
        return obj

    # Scenic layers overlap like torn paper, with broad low-poly brush facets.
    sphere('Midnight cyclorama', (0, 5, 2), (18, .2, 12), indigo, 2)
    for i in range(16):
        x = -10 + i * 1.3
        sphere('Painted garden leaf %02d' % i, (x, 2 + rng.random(), -.8 + rng.random()),
               (.55 + rng.random() * .6, .15, 1.6 + rng.random() * 2), teal, 1)
    sphere('Golden moon', (4.8, 4, 4), (1.5, .2, 1.5), cream, 2)
    for i in range(48):
        sphere('Dry brush star %02d' % i, (rng.uniform(-9, 9), 3.7, rng.uniform(1, 7)),
               (.025, .018, .06), cream)
    lantern = sphere('Lantern - animation on twos', (0, 0, 1), (.7, .55, 1), coral, 2)
    lantern['portos_cadence'] = 2
    heart = sphere('Lantern glow', (0, -.47, 1), (.4, .12, .55), gold, 2)
    # Parent glow follows the exact baked subject keys without another track.
    heart.parent = lantern
    heart.location = (0, -.7, 0)
    sparks = []
    for i in range(9):
        obj = sphere('Baked brush spark %02d' % i, (0, 0, 0), (.045, .035, .12), gold)
        obj['portos_cadence'] = 3
        sparks.append(obj)
    count = config['frameCount']
    fps = config['fps']
    for frame in range(1, count + 1, 2):
        t = (frame - 1) / fps
        lantern.location = (-3.5 + 7 * t / (count / fps), 0, 1.6 + .45 * math.sin(t * 1.2))
        lantern.rotation_euler = (.04 * math.sin(t), .13 * math.sin(t * 1.7), .1 * math.sin(t * .8))
        lantern.keyframe_insert('location', frame=frame)
        lantern.keyframe_insert('rotation_euler', frame=frame)
    for i, obj in enumerate(sparks):
        for frame in range(1, count + 1, 3):
            t = (frame - 1) / fps
            obj.location = (-3.5 + 7 * t / (count / fps) - .2 * i, -.2, .8 + (t * .45 + i * .27) % 2)
            obj.rotation_euler = (0, .35 * math.sin(t + i), 0)
            obj.keyframe_insert('location', frame=frame)
            obj.keyframe_insert('rotation_euler', frame=frame)
    for obj in [lantern, *sparks]:
        for curve in obj.animation_data.action.fcurves:
            for point in curve.keyframe_points:
                point.interpolation = 'CONSTANT'
    bpy.ops.object.camera_add(location=(0, -18, 5))
    camera = bpy.context.object
    camera.name = 'Smooth camera - continuous track'
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = 12
    scene.camera = camera
    for frame in (1, count):
        camera.location = (-.45 + .9 * (frame - 1) / max(1, count - 1), -18, 4.3)
        camera.rotation_euler = (Vector((0, 0, 2.2)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
        camera.keyframe_insert('location', frame=frame)
        camera.keyframe_insert('rotation_euler', frame=frame)
    for curve in camera.animation_data.action.fcurves:
        for point in curve.keyframe_points:
            point.interpolation = 'LINEAR'
    bpy.ops.object.light_add(type='AREA', location=(-3, -5, 8))
    bpy.context.object.data.energy = 900
    bpy.context.object.data.size = 8
