/** Owned Blender driver. Package source only supplies build_scene(config). */
export const BLENDER_DRIVER = String.raw`import bpy, json, os, runpy, math
root = os.environ['PORTOS_WORKER_INPUT']
out = os.environ['PORTOS_WORKER_OUTPUT']
with open(os.path.join(root, 'portos-render.json')) as handle:
    config = json.load(handle)
if bpy.app.version_string != config['version']:
    raise RuntimeError('Blender version does not match checked runtime')
bpy.ops.wm.read_factory_settings(use_empty=True)
namespace = runpy.run_path(os.path.join(root, config['entrypoint']))
if not callable(namespace.get('build_scene')):
    raise RuntimeError('Scene entrypoint must define build_scene(config)')
namespace['build_scene'](config)
scene = bpy.context.scene
if not scene.camera:
    raise RuntimeError('Scene needs a camera')
# No live simulations: portable revisions must bake simulation/FX into keys.
for obj in scene.objects:
    if obj.particle_systems or obj.rigid_body or any(m.type in ('CLOTH', 'FLUID', 'SOFT_BODY', 'DYNAMIC_PAINT') for m in obj.modifiers):
        raise RuntimeError('Bake simulations and remove live physics before rendering')
for group in bpy.data.node_groups:
    if any(node.bl_idname.startswith('GeometryNodeSimulation') for node in group.nodes):
        raise RuntimeError('Bake Geometry Nodes simulations into immutable geometry/keyframes')
scene.render.engine = config['engine']
scene.cycles.device = 'CPU'
scene.cycles.samples = config['samples']
scene.cycles.seed = config['seed']
scene.cycles.use_animated_seed = False
scene.cycles.use_denoising = False
scene.eevee.taa_render_samples = config['samples']
scene.render.resolution_x = config['width']
scene.render.resolution_y = config['height']
scene.render.resolution_percentage = 100
scene.render.fps = config['fps']
scene.render.fps_base = 1
scene.frame_start = 1
scene.frame_end = config['frameCount']
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.image_settings.color_depth = '8'
scene.render.use_file_extension = True
scene.render.use_motion_blur = True
scene.render.motion_blur_shutter = 0.35
scene.render.threads_mode = 'FIXED'
scene.render.threads = 2
subjects = [o for o in scene.objects if o.get('portos_cadence') in (2, 3)]
if not subjects:
    raise RuntimeError('Tag at least one baked subject/FX object with portos_cadence=2 or 3')
for obj in subjects:
    step = int(obj['portos_cadence'])
    curves = obj.animation_data.action.fcurves if obj.animation_data and obj.animation_data.action else []
    if not curves or any(p.interpolation != 'CONSTANT' or (round(p.co.x) - 1) % step != 0 for c in curves for p in c.keyframe_points):
        raise RuntimeError('Stepped subjects/FX need constant keys on their declared cadence')
    # Cycles excludes held subjects from shutter interpolation. EEVEE motion
    # blur is disabled because it cannot independently exclude held objects.
    obj.cycles.use_motion_blur = False
    for child in obj.children_recursive:
        child.cycles.use_motion_blur = False
if config['engine'] != 'CYCLES':
    scene.render.use_motion_blur = False
camera_curves = scene.camera.animation_data.action.fcurves if scene.camera.animation_data and scene.camera.animation_data.action else []
if not camera_curves or any(p.interpolation == 'CONSTANT' for c in camera_curves for p in c.keyframe_points):
    raise RuntimeError('Camera needs continuous, non-constant baked keyframes')
# Measure evaluated transforms across EVERY frame, rather than trusting tags.
transforms = {o.name: [] for o in subjects}
camera_transforms = []
for frame in range(1, config['frameCount'] + 1):
    scene.frame_set(frame)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for obj in subjects:
        transforms[obj.name].append([round(v, 6) for row in obj.evaluated_get(depsgraph).matrix_world for v in row])
    camera_transforms.append([round(v, 6) for row in scene.camera.evaluated_get(depsgraph).matrix_world for v in row])
for obj in subjects:
    values = transforms[obj.name]
    step = int(obj['portos_cadence'])
    if any(values[i] != values[i - i % step] for i in range(len(values))):
        raise RuntimeError('Evaluated subject/FX transforms violate stepped holds')
if any(a == b for a, b in zip(camera_transforms, camera_transforms[1:])):
    raise RuntimeError('Camera movement is not continuous across the sequence')
# Pack original textures into the immutable scene artifact; no live caches.
# Repacking an already packed image re-encodes it and corrupts its colour channels.
for image in bpy.data.images:
    if image.source in ('FILE', 'GENERATED') and image.has_data and not image.packed_file:
        image.pack()
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, 'scene.blend'))
for frame in config['frames']:
    scene.frame_set(frame)
    scene.render.filepath = os.path.join(out, 'frame-%06d.png' % frame)
    bpy.ops.render.render(write_still=True)
device, backend = 'CPU', 'CPU'
if config['engine'] != 'CYCLES':
    import gpu
    device, backend = 'GPU', gpu.platform.backend_type_get()
report = dict(version=bpy.app.version_string, engine=scene.render.engine, device=device, backend=backend,
    width=scene.render.resolution_x, height=scene.render.resolution_y, fps=scene.render.fps,
    frames=config['frames'], frameCount=config['frameCount'], samples=config['samples'], seed=scene.cycles.seed,
    cadence=[dict(name=o.name, step=int(o['portos_cadence']), holdsVerified=True, motionBlur=False) for o in subjects],
    cameraSmooth=True, motionBlur=scene.render.use_motion_blur, baked=True)
with open(os.path.join(out, 'report.json'), 'w') as handle:
    json.dump(report, handle)
`;
