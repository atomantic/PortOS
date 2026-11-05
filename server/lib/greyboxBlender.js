/**
 * Greybox → Blender blockout. PortOS owns this Python; the place's greybox only
 * enters as JSON data (`greybox-blender.json`), so a render runs no caller code.
 *
 * Geometry follows the three.js viewer exactly (GreyboxViewer.jsx): meters, Y up,
 * box/cylinder centered on `position`, planes lying flat, extrudes swept up from
 * the part's origin, and Euler XYZ rotations in three.js order (Rx·Ry·Rz). Every
 * part is built in that Y-up frame and then turned +90° about X into Blender's
 * Z up, so north (-Z in the greybox) becomes Blender +Y.
 */

import { BLENDER_COMPAT_PY } from './blenderVersion.js';

export const PHOTOREAL_ROLE_PREFIX = 'photoreal:';
export const PHOTOREAL_ENGINES = Object.freeze(['eevee', 'cycles']);
// Long edge of a render; shots keep their saved aspect.
export const PHOTOREAL_LONG_EDGE = Object.freeze({ eevee: 1280, cycles: 1920 });
export const PHOTOREAL_DEFAULT_SAMPLES = Object.freeze({ eevee: 32, cycles: 128 });
export const PHOTOREAL_MAX_SAMPLES = 1024;

export const PHOTOREAL_FLYTHROUGH_FPS = 24;
export const PHOTOREAL_FLYTHROUGH_SECONDS = Object.freeze({ MIN: 2, MAX: 60, DEFAULT: 8 });

export const photorealShotRole = (shotId) => `${PHOTOREAL_ROLE_PREFIX}${shotId}`;
export const photorealShotFile = (shotId) => `shot-${shotId}.png`;
export const photorealFlythroughFrameFile = (frame) => `frame-${String(frame).padStart(4, '0')}.png`;

/**
 * The data file the script reads. Pure; the greybox must already be validated.
 * With `flythroughSeconds`, one camera glides through `shotIds` in order and
 * the script writes numbered frames instead of one still per camera.
 */
export function greyboxBlenderJob(scene, { shotIds, engine = 'eevee', samples, look = null, flythroughSeconds = null, useGpu } = {}) {
  return {
    look,
    flythrough: flythroughSeconds ? { fps: PHOTOREAL_FLYTHROUGH_FPS, frames: Math.round(flythroughSeconds * PHOTOREAL_FLYTHROUGH_FPS) } : null,
    engine: engine === 'cycles' ? 'CYCLES' : 'BLENDER_EEVEE_NEXT',
    samples: samples ?? PHOTOREAL_DEFAULT_SAMPLES[engine],
    longEdge: PHOTOREAL_LONG_EDGE[engine],
    useGpu,
    shotIds,
    greybox: { parts: scene.parts, zones: scene.zones, landmarks: scene.landmarks, anchors: scene.anchors, shots: scene.shots },
  };
}

export const GREYBOX_BLENDER_PY = String.raw`import bpy, bmesh, json, math, os, time
from mathutils import Matrix, Vector
${BLENDER_COMPAT_PY}
root = os.environ['PORTOS_WORKER_INPUT']
out = os.environ['PORTOS_WORKER_OUTPUT']
with open(os.path.join(root, 'greybox-blender.json')) as handle:
    job = json.load(handle)
grey = job['greybox']
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
Y_UP = Matrix.Rotation(math.pi / 2, 4, 'X')

def to_blender(p):
    return Vector((p[0], -p[2], p[1]))

def collection(name, parent=None):
    found = bpy.data.collections.get(name)
    if found is None:
        found = bpy.data.collections.new(name)
        (parent or scene.collection).children.link(found)
    return found

def srgb(hex_color):
    def channel(c):
        c = c / 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return tuple(channel(int(hex_color[i:i + 2], 16)) for i in (1, 3, 5)) + (1.0,)

materials = {}
def material(hex_color):
    if hex_color not in materials:
        mat = bpy.data.materials.new('Greybox ' + hex_color)
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get('Principled BSDF')
        bsdf.inputs['Base Color'].default_value = srgb(hex_color)
        bsdf.inputs['Roughness'].default_value = 0.85
        mat.diffuse_color = srgb(hex_color)
        materials[hex_color] = mat
    return materials[hex_color]

def box(sx, sy, sz):
    x, y, z = sx / 2, sy / 2, sz / 2
    verts = [(-x, -y, -z), (x, -y, -z), (x, y, -z), (-x, y, -z), (-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z)]
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return verts, faces

def cylinder(radius, height, segments=32):
    h = height / 2
    ring = [(radius * math.cos(2 * math.pi * i / segments), radius * math.sin(2 * math.pi * i / segments)) for i in range(segments)]
    verts = [(x, -h, z) for x, z in ring] + [(x, h, z) for x, z in ring]
    faces = [tuple(range(segments - 1, -1, -1)), tuple(range(segments, 2 * segments))]
    faces += [(i, (i + 1) % segments, segments + (i + 1) % segments, segments + i) for i in range(segments)]
    return verts, faces

def plane(sx, sz):
    x, z = sx / 2, sz / 2
    return [(-x, 0, -z), (x, 0, -z), (x, 0, z), (-x, 0, z)], [(0, 3, 2, 1)]

def extrude(outline, height):
    n = len(outline)
    verts = [(x, 0, z) for x, z in outline] + [(x, height, z) for x, z in outline]
    faces = [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
    faces += [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    return verts, faces

zone_by_id = {z['id']: z for z in grey['zones']}
part_objects = []
parts_root = collection('Greybox parts')
for part in grey['parts']:
    kind = part['type']
    if kind == 'box':
        verts, faces = box(*part['size'])
    elif kind == 'cylinder':
        verts, faces = cylinder(part['radius'], part['height'])
    elif kind == 'plane':
        verts, faces = plane(*part['size'])
    else:
        verts, faces = extrude(part['outline'], part['height'])
    label = part.get('label') or part['id']
    mesh = bpy.data.meshes.new(label)
    mesh.from_pydata(verts, [], faces)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    mesh.validate()
    zone = zone_by_id.get(part.get('zone'))
    mesh.materials.append(material(zone['color'] if zone else '#8a8f98'))
    obj = bpy.data.objects.new('%s [%s]' % (label, part['id']), mesh)
    obj['portos_greybox_id'] = part['id']
    rx, ry, rz = (math.radians(v) for v in part['rotationDegrees'])
    rotation = Matrix.Rotation(rx, 4, 'X') @ Matrix.Rotation(ry, 4, 'Y') @ Matrix.Rotation(rz, 4, 'Z')
    obj.matrix_world = Y_UP @ Matrix.Translation(Vector(part['position'])) @ rotation
    collection(zone['label'] if zone else 'Unzoned', parts_root).objects.link(obj)
    # Real edges catch a highlight; a knife-sharp one reads as CG (#14941).
    if kind != 'plane':
        dims = part['size'] if kind == 'box' else [part['radius'] * 2, part['height']] if kind == 'cylinder' else [part['height']]
        bevel = obj.modifiers.new('Bevel', 'BEVEL')
        bevel.width = min(0.012, 0.15 * min(dims))
        bevel.segments = 2
        bevel.limit_method = 'ANGLE'
    part_objects.append((part, obj))

marks = collection('Landmarks and anchors')
for item in grey['landmarks'] + grey['anchors']:
    empty = bpy.data.objects.new('%s [%s]' % (item['label'], item['id']), None)
    empty.empty_display_type = 'SINGLE_ARROW' if 'kind' in item else 'PLAIN_AXES'
    empty.location = to_blender(item['position'])
    if 'kind' in item:
        empty.rotation_euler = (0, 0, math.radians(item.get('facingDegrees', 0)) + math.pi)
    marks.objects.link(empty)

cameras = collection('Cameras')
camera_by_shot = {}
for shot in grey['shots']:
    data = bpy.data.cameras.new(shot['label'])
    data.sensor_fit = 'VERTICAL'
    data.sensor_height = 24
    data.lens = shot.get('focalLengthMm', 35)
    data.clip_start = 0.05
    data.clip_end = 2000
    cam = bpy.data.objects.new('%s [%s]' % (shot['label'], shot['id']), data)
    cam.location = to_blender(shot['position'])
    cam.rotation_euler = (to_blender(shot['target']) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cameras.objects.link(cam)
    camera_by_shot[shot['id']] = (cam, shot)

# Photoreal look: allowlisted presets mapped to procedural node setups.
PRESETS = {
    'wood-floor': dict(roughness=0.45, coat=0.5, grain='wood'),
    'painted-wall': dict(roughness=0.8),
    'painted-metal': dict(roughness=0.35, metallic=0.0, coat=0.3),
    'carpet': dict(roughness=1.0, grain='pile'),
    'tile': dict(roughness=0.4, grain='tile'),
    'concrete': dict(roughness=0.7, grain='speckle'),
    'plastic': dict(roughness=0.4),
    'vinyl': dict(roughness=0.45, coat=0.2),
    'fabric': dict(roughness=0.95, sheen=0.5),
    'glass': dict(roughness=0.02, transmission=1.0),
    'mirror': dict(roughness=0.02, metallic=1.0),
    'chrome': dict(roughness=0.08, metallic=1.0),
    'neon': dict(roughness=0.3),
}

def set_input(node, name, value):
    if name in node.inputs:
        node.inputs[name].default_value = value

def look_material(rule):
    preset = PRESETS[rule['preset']]
    mat = bpy.data.materials.new('%s [%s]' % (rule['preset'], rule['id']))
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes.get('Principled BSDF')
    base = srgb(rule['color'])
    mat.diffuse_color = base
    roughness = rule.get('roughness', preset['roughness'])
    set_input(bsdf, 'Roughness', roughness)
    set_input(bsdf, 'Metallic', preset.get('metallic', 0.0))
    set_input(bsdf, 'Transmission Weight', preset.get('transmission', 0.0))
    set_input(bsdf, 'Coat Weight', preset.get('coat', 0.0))
    set_input(bsdf, 'Sheen Weight', preset.get('sheen', 0.0))
    coord = nodes.new('ShaderNodeTexCoord')
    color_out = None
    grain = preset.get('grain')
    if grain == 'wood':
        # Narrow maple strips laid along the part's long X axis, in metres (#14941).
        # Mesh-local X/Z is the floor plane; the mapping turns it onto the texture's X/Y.
        boards = nodes.new('ShaderNodeMapping')
        boards.inputs['Rotation'].default_value = (math.radians(90), 0, 0)
        links.new(coord.outputs['Object'], boards.inputs['Vector'])
        brick = nodes.new('ShaderNodeTexBrick')
        brick.offset = 0.37
        brick.offset_frequency = 1
        brick.squash = 1.0
        brick.inputs['Scale'].default_value = 1.0
        brick.inputs['Brick Width'].default_value = 1.8
        brick.inputs['Row Height'].default_value = 0.057
        brick.inputs['Mortar Size'].default_value = 0.0012
        brick.inputs['Mortar Smooth'].default_value = 0.4
        brick.inputs['Bias'].default_value = 0.0
        brick.inputs['Color1'].default_value = base
        brick.inputs['Color2'].default_value = tuple(c * 0.8 for c in base[:3]) + (1.0,)
        brick.inputs['Mortar'].default_value = tuple(c * 0.35 for c in base[:3]) + (1.0,)
        links.new(boards.outputs['Vector'], brick.inputs['Vector'])
        # Fine grain streaks run with each strip: noise stretched along X.
        streak = nodes.new('ShaderNodeMapping')
        streak.inputs['Scale'].default_value = (0.6, 60.0, 1.0)
        links.new(boards.outputs['Vector'], streak.inputs['Vector'])
        fibre = nodes.new('ShaderNodeTexNoise')
        fibre.inputs['Scale'].default_value = 3.0
        fibre.inputs['Detail'].default_value = 6.0
        links.new(streak.outputs['Vector'], fibre.inputs['Vector'])
        mix = nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        mix.blend_type = 'MULTIPLY'
        mix.inputs['Factor'].default_value = 0.25
        links.new(brick.outputs['Color'], mix.inputs['A'])
        links.new(fibre.outputs['Color'], mix.inputs['B'])
        color_out = mix.outputs['Result']
        # Seams sink a little and scuffs break up the lacquer, so lights smear
        # into soft streaks instead of mirroring as hard rectangles.
        seam = nodes.new('ShaderNodeBump')
        seam.invert = True
        seam.inputs['Strength'].default_value = 0.4
        seam.inputs['Distance'].default_value = 0.002
        links.new(brick.outputs['Fac'], seam.inputs['Height'])
        scuff = nodes.new('ShaderNodeTexNoise')
        scuff.inputs['Scale'].default_value = 9.0
        scuff.inputs['Detail'].default_value = 10.0
        links.new(coord.outputs['Object'], scuff.inputs['Vector'])
        scuff_bump = nodes.new('ShaderNodeBump')
        scuff_bump.inputs['Strength'].default_value = 0.04
        links.new(scuff.outputs['Fac'], scuff_bump.inputs['Height'])
        links.new(seam.outputs['Normal'], scuff_bump.inputs['Normal'])
        links.new(scuff_bump.outputs['Normal'], bsdf.inputs['Normal'])
        if 'Coat Normal' in bsdf.inputs:
            links.new(scuff_bump.outputs['Normal'], bsdf.inputs['Coat Normal'])
        coat_rough = nodes.new('ShaderNodeMapRange')
        coat_rough.inputs['To Min'].default_value = 0.04
        coat_rough.inputs['To Max'].default_value = 0.22
        links.new(scuff.outputs['Fac'], coat_rough.inputs['Value'])
        if 'Coat Roughness' in bsdf.inputs:
            links.new(coat_rough.outputs['Result'], bsdf.inputs['Coat Roughness'])
    elif grain == 'tile':
        brick = nodes.new('ShaderNodeTexBrick')
        brick.inputs['Scale'].default_value = 3.0
        brick.inputs['Color1'].default_value = base
        brick.inputs['Color2'].default_value = tuple(c * 0.92 for c in base[:3]) + (1.0,)
        brick.inputs['Mortar'].default_value = (0.6, 0.6, 0.6, 1.0)
        brick.offset = 0.0
        links.new(coord.outputs['Object'], brick.inputs['Vector'])
        color_out = brick.outputs['Color']
    elif grain in ('pile', 'speckle'):
        noise = nodes.new('ShaderNodeTexNoise')
        noise.inputs['Scale'].default_value = 400.0 if grain == 'pile' else 60.0
        links.new(coord.outputs['Object'], noise.inputs['Vector'])
        bump = nodes.new('ShaderNodeBump')
        bump.inputs['Strength'].default_value = 0.3
        links.new(noise.outputs['Fac'], bump.inputs['Height'])
        links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
    wear = rule.get('wear', 0)
    if wear > 0:
        dirt = nodes.new('ShaderNodeTexNoise')
        dirt.inputs['Scale'].default_value = 4.0
        dirt.inputs['Detail'].default_value = 8.0
        links.new(coord.outputs['Object'], dirt.inputs['Vector'])
        ramp = nodes.new('ShaderNodeMapRange')
        ramp.inputs['From Min'].default_value = 0.45
        ramp.inputs['From Max'].default_value = 0.75
        ramp.inputs['To Max'].default_value = wear
        links.new(dirt.outputs['Fac'], ramp.inputs['Value'])
        grime = nodes.new('ShaderNodeMix')
        grime.data_type = 'RGBA'
        if color_out is not None:
            links.new(color_out, grime.inputs['A'])
        else:
            grime.inputs['A'].default_value = base
        grime.inputs['B'].default_value = tuple(c * 0.45 for c in base[:3]) + (1.0,)
        links.new(ramp.outputs['Result'], grime.inputs['Factor'])
        color_out = grime.outputs['Result']
        rough = nodes.new('ShaderNodeMath')
        rough.operation = 'ADD'
        rough.use_clamp = True
        rough.inputs[1].default_value = roughness
        links.new(ramp.outputs['Result'], rough.inputs[0])
        links.new(rough.outputs['Value'], bsdf.inputs['Roughness'])
    if color_out is not None:
        links.new(color_out, bsdf.inputs['Base Color'])
    else:
        set_input(bsdf, 'Base Color', base)
    if rule.get('emission', 0) > 0:
        set_input(bsdf, 'Emission Color', base)
        set_input(bsdf, 'Emission Strength', rule['emission'])
    return mat

def apply_look(look):
    built = {}
    chosen = {}
    for rule in look['materials']:
        for part, obj in part_objects:
            if rule.get('part') == part['id'] or (rule.get('zone') and rule.get('zone') == part.get('zone')):
                chosen[part['id']] = rule
    for part, obj in part_objects:
        rule = chosen.get(part['id'])
        if rule is None:
            continue
        if rule['id'] not in built:
            built[rule['id']] = look_material(rule)
        obj.data.materials.clear()
        obj.data.materials.append(built[rule['id']])
    look_lights = collection('Look lights')
    for spec in look['lights']:
        kind = spec['type'].upper()
        data = bpy.data.lights.new(spec.get('label') or spec['id'], kind)
        data.energy = spec['watts']
        data.color = srgb(spec['color'])[:3]
        if kind == 'SPOT':
            data.spot_size = math.radians(spec['spotDegrees'])
            # A stage wash fades out at its rim; Blender's default 0.15 draws a hard disc.
            data.spot_blend = 0.8
            data.shadow_soft_size = spec['size']
        elif kind == 'AREA':
            data.shape = 'SQUARE'
            data.size = max(spec['size'], 0.01)
        else:
            data.shadow_soft_size = spec['size']
        light = bpy.data.objects.new('%s [%s]' % (spec.get('label') or spec['id'], spec['id']), data)
        light.location = to_blender(spec['position'])
        aim = spec.get('target')
        if kind != 'POINT':
            direction = (to_blender(aim) - light.location) if aim else Vector((0, 0, -1))
            if direction.length > 0:
                light.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
        look_lights.objects.link(light)
    haze = look['atmosphere'].get('haze', 0)
    if haze > 0 and part_objects:
        # The air the cameras look through: parts, cameras and lights, at least
        # 4 m tall, with a margin, so an open or floor-only layout still gets haze.
        corners = [obj.matrix_world @ Vector(c) for _, obj in part_objects for c in obj.bound_box]
        corners += [cam.location.copy() for cam, _ in camera_by_shot.values()]
        corners += [to_blender(spec['position']) for spec in look['lights']]
        low = Vector((min(c.x for c in corners) - 1, min(c.y for c in corners) - 1, min(c.z for c in corners)))
        high = Vector((max(c.x for c in corners) + 1, max(c.y for c in corners) + 1, max(c.z for c in corners) + 1))
        high.z = max(high.z, low.z + 4)
        mesh = bpy.data.meshes.new('Haze')
        size = high - low
        verts, faces = box(size.x, size.y, size.z)
        mesh.from_pydata(verts, [], faces)
        volume = bpy.data.objects.new('Haze volume', mesh)
        volume.location = (low + high) / 2
        mat = bpy.data.materials.new('Haze')
        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        nodes.remove(nodes.get('Principled BSDF'))
        scatter = nodes.new('ShaderNodeVolumeScatter')
        scatter.inputs['Density'].default_value = 0.002 + haze * 0.06
        mat.node_tree.links.new(scatter.outputs['Volume'], nodes.get('Material Output').inputs['Volume'])
        mesh.materials.append(mat)
        volume.visible_shadow = False
        look_lights.objects.link(volume)
    scene.view_settings.exposure = look['atmosphere'].get('exposure', 0)

look = job.get('look')
atmos = (look or {}).get('atmosphere', {})
world = bpy.data.worlds.new('Blockout world')
world.use_nodes = True
background = world.node_tree.nodes['Background']
background.inputs['Color'].default_value = srgb(atmos['worldColor']) if look else (0.05, 0.05, 0.06, 1)
background.inputs['Strength'].default_value = atmos.get('worldStrength', 1.0) if look else 1.0
scene.world = world
lights = collection('Blockout lights')
if not look or atmos.get('sun'):
    sun_data = bpy.data.lights.new('Blockout sun', 'SUN')
    sun_data.energy = 2.5
    sun = bpy.data.objects.new('Blockout sun', sun_data)
    sun.rotation_euler = (math.radians(35), math.radians(20), math.radians(30))
    lights.objects.link(sun)

if look:
    apply_look(look)

portos_set_engine(scene, job['engine'])
device, backend = 'CPU', 'CPU'
if job['engine'] == 'CYCLES':
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for kind in ('METAL', 'OPTIX', 'CUDA', 'HIP', 'ONEAPI') if job['useGpu'] else ():
        try:
            prefs.compute_device_type = kind
        except TypeError:
            continue
        prefs.get_devices()
        gpus = [d for d in prefs.devices if d.type != 'CPU']
        if gpus:
            for d in prefs.devices:
                d.use = d.type != 'CPU'
            scene.cycles.device = 'GPU'
            device, backend = 'GPU', kind
            break
    scene.cycles.samples = job['samples']
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = 0.02
    scene.cycles.use_denoising = True
else:
    scene.eevee.taa_render_samples = job['samples']
    # The GPU module starts with the first render; it is read after rendering (#14937).
    device, backend = 'GPU', None

def eevee_backend():
    try:
        import gpu
        return gpu.platform.backend_type_get()
    except Exception:
        return None
scene.view_settings.view_transform = 'AgX'
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGB'
scene.render.image_settings.color_depth = '8'
scene.render.resolution_percentage = 100

def use_shot(shot_id):
    cam, shot = camera_by_shot[shot_id]
    w, h = (float(v) for v in shot.get('aspect', '16:9').split(':'))
    edge = job['longEdge']
    width, height = (edge, round(edge * h / w)) if w >= h else (round(edge * w / h), edge)
    scene.render.resolution_x = width - width % 2
    scene.render.resolution_y = height - height % 2
    scene.camera = cam

def fly_camera(fly):
    # One camera keyed at each chosen camera in order, aimed by a keyed target so
    # it turns smoothly; its frame, lens and aspect start from the first camera.
    use_shot(job['shotIds'][0])
    stops = [camera_by_shot[shot_id][1] for shot_id in job['shotIds']]
    data = bpy.data.cameras.new('Fly-through')
    data.sensor_fit = 'VERTICAL'
    data.sensor_height = 24
    data.clip_start = 0.05
    data.clip_end = 2000
    cam = bpy.data.objects.new('Fly-through', data)
    aim = bpy.data.objects.new('Fly-through target', None)
    cameras.objects.link(cam)
    cameras.objects.link(aim)
    track = cam.constraints.new('TRACK_TO')
    track.target = aim
    track.track_axis = 'TRACK_NEGATIVE_Z'
    track.up_axis = 'UP_Y'
    last = fly['frames']
    for i, shot in enumerate(stops):
        frame = 1 + round(i * (last - 1) / (len(stops) - 1))
        cam.location = to_blender(shot['position'])
        aim.location = to_blender(shot['target'])
        data.lens = shot.get('focalLengthMm', 35)
        cam.keyframe_insert('location', frame=frame)
        aim.keyframe_insert('location', frame=frame)
        data.keyframe_insert('lens', frame=frame)
    scene.frame_start = 1
    scene.frame_end = last
    scene.render.fps = fly['fps']
    scene.camera = cam

fly = job.get('flythrough')
if fly:
    fly_camera(fly)
else:
    # The downloaded scene opens ready to render from the first chosen camera.
    use_shot(job['shotIds'][0])
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, 'blockout.blend'))
rendered = []
report = dict(version=portos_version(), engine=job['engine'], device=device, backend=backend,
    samples=job['samples'], parts=len(grey['parts']))
if fly:
    started = time.time()
    for frame in range(1, fly['frames'] + 1):
        scene.frame_set(frame)
        scene.render.filepath = os.path.join(out, 'frame-%04d.png' % frame)
        bpy.ops.render.render(write_still=True)
    report.update(frames=fly['frames'], fps=fly['fps'], seconds=round(time.time() - started, 2),
        width=scene.render.resolution_x, height=scene.render.resolution_y)
else:
    for shot_id in job['shotIds']:
        use_shot(shot_id)
        scene.render.filepath = os.path.join(out, 'shot-%s.png' % shot_id)
        started = time.time()
        bpy.ops.render.render(write_still=True)
        rendered.append(dict(shotId=shot_id, seconds=round(time.time() - started, 2),
            width=scene.render.resolution_x, height=scene.render.resolution_y))
    report.update(shots=rendered)
if backend is None:
    report['backend'] = eevee_backend()
with open(os.path.join(out, 'report.json'), 'w') as handle:
    json.dump(report, handle)
`;
