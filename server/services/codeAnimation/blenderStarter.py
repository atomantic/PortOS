"""Original procedural scene: a paper lantern crossing a painted night garden.
No downloads, add-ons, external assets or live simulation. All motion is baked.
"""
import bpy
import math
import random
from mathutils import Vector


def brush_atlas(rng, size=256):
    """Layered, directional bristle strokes painted into a tiling grey pigment map."""
    pixels = [0.72 + rng.uniform(-.05, .05) for _ in range(size * size)]
    for _ in range(170):
        cx, cy = rng.uniform(0, size), rng.uniform(0, size)
        angle = rng.uniform(-.55, .55) + (math.pi / 2 if rng.random() < .35 else 0)
        length, width = rng.randint(36, 110), rng.randint(5, 13)
        dx, dy = math.cos(angle), math.sin(angle)
        tone = rng.uniform(-.3, .2)
        for bristle in range(width):
            offset = bristle - width / 2
            shade = tone * (.45 + rng.random())
            for step in range(length):
                # Strokes thin out toward the end like a lifting brush.
                weight = .62 * (1 - step / length) ** .6
                x = int(cx + dx * step - dy * offset) % size
                y = int(cy + dy * step + dx * offset) % size
                index = y * size + x
                pixels[index] += (min(1, max(.25, .78 + shade)) - pixels[index]) * weight
    out = []
    for value in pixels:
        out.extend((value, value, value, 1))
    return out


def build_scene(config):
    rng = random.Random(config['seed'])
    scene = bpy.context.scene
    if scene.world is None:
        scene.world = bpy.data.worlds.new('Painted night')
    scene.world.color = (0.008, 0.016, 0.045)
    scene.view_settings.view_transform = 'Standard'
    size = 256
    image = bpy.data.images.new('Original pigment brush atlas', width=size, height=size)
    image.pixels = brush_atlas(rng, size)  # the owned driver packs it into the scene artifact

    def material(name, color, glow=0, tiling=3.0):
        mat = bpy.data.materials.new(name)
        mat.diffuse_color = (*color, 1)
        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links
        bsdf = nodes.get('Principled BSDF')
        tex = nodes.new('ShaderNodeTexImage')
        tex.image = image
        tex.projection = 'BOX'
        tex.projection_blend = .25
        coordinate = nodes.new('ShaderNodeTexCoord')
        mapping = nodes.new('ShaderNodeMapping')
        mapping.inputs['Scale'].default_value = (tiling, tiling, tiling)
        links.new(coordinate.outputs['Generated'], mapping.inputs['Vector'])
        links.new(mapping.outputs['Vector'], tex.inputs['Vector'])
        mix = nodes.new('ShaderNodeMixRGB')
        mix.blend_type = 'MULTIPLY'
        mix.inputs[0].default_value = .9
        mix.inputs[1].default_value = (*color, 1)
        links.new(tex.outputs['Color'], mix.inputs[2])
        links.new(mix.outputs[0], bsdf.inputs['Base Color'])
        bsdf.inputs['Roughness'].default_value = .95
        links.new(mix.outputs[0], bsdf.inputs['Emission Color'])
        bsdf.inputs['Emission Strength'].default_value = glow
        return mat

    indigo = material('Ultramarine pigment', (.07, .11, .3), .05, 2.0)
    teal = material('Viridian pigment', (.06, .38, .4), .04)
    deep = material('Prussian shadow', (.015, .03, .08), .0, 2.0)
    coral = material('Vermilion paper', (1, .24, .1), .3, 2.0)
    gold = material('Warm lantern light', (1, .68, .22), 1.5, 2.0)
    cream = material('Ivory dry brush', (.98, .84, .52), .6, 2.0)

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
    # Dark foreground leaves frame the subject and push value contrast toward it.
    for side in (-1, 1):
        for i in range(3):
            sphere('Foreground shadow leaf %d%d' % (side > 0, i), (side * (4.6 + i * .9), -4, -.4 + i * .5),
                   (.7 + i * .15, .2, 2.6 - i * .35), deep, 1)

    lantern = sphere('Lantern - animation on twos', (0, 0, 1), (.7, .55, 1), coral, 2)
    lantern['portos_cadence'] = 2
    heart = sphere('Lantern glow', (0, -.47, 1), (.4, .12, .55), gold, 2)
    # Parent glow follows the exact baked subject keys without another track.
    heart.parent = lantern
    heart.location = (0, -.7, 0)
    # A real warm light rides with the lantern, so the garden answers its motion.
    bpy.ops.object.light_add(type='POINT', location=(0, 0, 0))
    glow = bpy.context.object
    glow.name = 'Lantern light'
    glow.data.color = (1, .62, .2)
    glow.data.energy = 420
    glow.data.shadow_soft_size = .35
    glow.parent = lantern
    glow.location = (0, -1.4, .2)
    sparks = []
    for i in range(9):
        obj = sphere('Baked brush spark %02d' % i, (0, 0, 0), (.05, .035, .16), gold)
        obj['portos_cadence'] = 3
        sparks.append(obj)
    count = config['frameCount']
    fps = config['fps']
    for frame in range(1, count + 1, 2):
        t = (frame - 1) / fps
        run = t / (count / fps)
        # Anticipation: draw back and squash before travelling, then overshoot and settle.
        wind = min(1, t / .9)
        pull = -.32 * math.sin(math.pi * wind)
        squash = .14 * math.sin(math.pi * wind)
        stretch = .1 * max(0, math.sin(math.pi * min(1, max(0, (t - .9) / .7))))
        lantern.location = (-3.5 + 7 * run + pull, 0, 1.6 + .45 * math.sin(t * 1.2) - squash * .8)
        lantern.rotation_euler = (.04 * math.sin(t), .13 * math.sin(t * 1.7) + .1 * pull, .1 * math.sin(t * .8))
        lantern.scale = (.7 * (1 + squash - stretch * .4), .55 * (1 + squash), 1 * (1 - squash + stretch))
        lantern.keyframe_insert('location', frame=frame)
        lantern.keyframe_insert('rotation_euler', frame=frame)
        lantern.keyframe_insert('scale', frame=frame)
    for i, obj in enumerate(sparks):
        for frame in range(1, count + 1, 3):
            t = (frame - 1) / fps
            # Sparks lag behind the lantern and flicker outward: overlapping action.
            lag = .22 * i + .18
            obj.location = (-3.5 + 7 * max(0, t - lag * .35) / (count / fps) - .2 * i, -.2, .8 + (t * .45 + i * .27) % 2)
            obj.rotation_euler = (0, .35 * math.sin(t + i), .5 * math.sin(t * 2 + i))
            s = .6 + .8 * abs(math.sin(t * 3 + i * .9))
            obj.scale = (.05 * s, .035 * s, .16 * s)
            obj.keyframe_insert('location', frame=frame)
            obj.keyframe_insert('rotation_euler', frame=frame)
            obj.keyframe_insert('scale', frame=frame)
    for obj in [lantern, *sparks]:
        for curve in obj.animation_data.action.fcurves:
            for point in curve.keyframe_points:
                point.interpolation = 'CONSTANT'
    bpy.ops.object.camera_add(location=(0, -18, 5))
    camera = bpy.context.object
    camera.name = 'Smooth camera - continuous track'
    camera.data.type = 'PERSP'
    camera.data.lens = 54
    # Shallow focus on the lantern softens both the far garden and the foreground leaves.
    camera.data.dof.use_dof = True
    camera.data.dof.focus_object = lantern
    camera.data.dof.aperture_fstop = 5.6
    scene.camera = camera
    for frame in (1, count):
        camera.location = (-.45 + .9 * (frame - 1) / max(1, count - 1), -18, 4.3)
        camera.rotation_euler = (Vector((0, 0, 2.2)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
        camera.keyframe_insert('location', frame=frame)
        camera.keyframe_insert('rotation_euler', frame=frame)
    for curve in camera.animation_data.action.fcurves:
        for point in curve.keyframe_points:
            point.interpolation = 'LINEAR'
    # Cool moon-side fill against the warm lantern: the colour contrast carries the mood.
    bpy.ops.object.light_add(type='AREA', location=(6, -6, 9))
    fill = bpy.context.object
    fill.name = 'Cool moon fill'
    fill.data.color = (.45, .72, .85)
    fill.data.energy = 320
    fill.data.size = 9
    fill.rotation_euler = (Vector((0, 0, 1)) - fill.location).to_track_quat('-Z', 'Y').to_euler()
