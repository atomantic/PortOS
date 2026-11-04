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

export const photorealShotRole = (shotId) => `${PHOTOREAL_ROLE_PREFIX}${shotId}`;
export const photorealShotFile = (shotId) => `shot-${shotId}.png`;

/** The data file the script reads. Pure; the greybox must already be validated. */
export function greyboxBlenderJob(scene, { shotIds, engine = 'eevee', samples } = {}) {
  return {
    engine: engine === 'cycles' ? 'CYCLES' : 'BLENDER_EEVEE_NEXT',
    samples: samples ?? PHOTOREAL_DEFAULT_SAMPLES[engine],
    longEdge: PHOTOREAL_LONG_EDGE[engine],
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

world = bpy.data.worlds.new('Blockout world')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.05, 0.05, 0.06, 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.0
scene.world = world
lights = collection('Blockout lights')
sun_data = bpy.data.lights.new('Blockout sun', 'SUN')
sun_data.energy = 2.5
sun = bpy.data.objects.new('Blockout sun', sun_data)
sun.rotation_euler = (math.radians(35), math.radians(20), math.radians(30))
lights.objects.link(sun)

portos_set_engine(scene, job['engine'])
device, backend = 'CPU', 'CPU'
if job['engine'] == 'CYCLES':
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for kind in ('METAL', 'OPTIX', 'CUDA', 'HIP', 'ONEAPI'):
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
    import gpu
    scene.eevee.taa_render_samples = job['samples']
    device, backend = 'GPU', gpu.platform.backend_type_get()
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

# The downloaded scene opens ready to render from the first chosen camera.
use_shot(job['shotIds'][0])
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, 'blockout.blend'))
rendered = []
for shot_id in job['shotIds']:
    use_shot(shot_id)
    scene.render.filepath = os.path.join(out, 'shot-%s.png' % shot_id)
    started = time.time()
    bpy.ops.render.render(write_still=True)
    rendered.append(dict(shotId=shot_id, seconds=round(time.time() - started, 2),
        width=scene.render.resolution_x, height=scene.render.resolution_y))
with open(os.path.join(out, 'report.json'), 'w') as handle:
    json.dump(dict(version=portos_version(), engine=job['engine'], device=device, backend=backend,
        samples=job['samples'], parts=len(grey['parts']), shots=rendered), handle)
`;
