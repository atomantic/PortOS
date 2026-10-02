/** On-demand fixed-scene proof, never execution of a project's source. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { RIGGING_RUNTIME } from '../rigging/runtime.js';
import { runContainedWorker } from './containedWorker.js';

// Match the existing supported bpy baseline; this is not a claim that an import
// or a newer Blender version proves render compatibility.
const VERSION = RIGGING_RUNTIME.moduleVersion;
const reportSchema = engine => z.object({
  version: z.literal(VERSION), engine: z.literal(engine), device: z.literal(engine === 'CYCLES' ? 'CPU' : 'GPU'),
  backend: engine === 'CYCLES' ? z.literal('CPU') : z.enum(['OPENGL', 'METAL', 'VULKAN']), width: z.literal(64), height: z.literal(64),
  seed: z.literal(0), samples: z.literal(8), frame: z.literal(1),
}).strict();

const sceneSource = engine => `import bpy, json, os
from mathutils import Vector
if bpy.app.version_string != ${JSON.stringify(VERSION)}:
    raise RuntimeError("Unsupported Blender version; expected ${VERSION}")
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = ${JSON.stringify(engine)}
scene.cycles.device = 'CPU'
scene.cycles.samples = 8
scene.cycles.seed = 0
scene.cycles.use_animated_seed = False
scene.cycles.use_denoising = False
scene.eevee.taa_render_samples = 8
scene.render.resolution_x = 64
scene.render.resolution_y = 64
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.image_settings.color_depth = '8'
scene.frame_set(1)
bpy.ops.mesh.primitive_cube_add()
bpy.ops.object.camera_add(location=(4, -6, 3))
camera = bpy.context.object
camera.rotation_euler = (Vector((0, 0, 0)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
scene.camera = camera
bpy.ops.object.light_add(type='AREA', location=(2, -3, 5))
bpy.context.object.data.energy = 500
bpy.context.object.data.shape = 'DISK'
bpy.context.object.data.size = 4
out = os.environ['PORTOS_WORKER_OUTPUT']
scene.render.filepath = os.path.join(out, 'probe.png')
bpy.ops.render.render(write_still=True)
device, backend = 'CPU', 'CPU'
if scene.render.engine != 'CYCLES':
    import gpu
    device, backend = 'GPU', gpu.platform.backend_type_get()
with open(os.path.join(out, 'report.json'), 'w') as handle:
    json.dump(dict(version=bpy.app.version_string, engine=scene.render.engine,
        device=device, backend=backend, width=scene.render.resolution_x,
        height=scene.render.resolution_y, seed=scene.cycles.seed,
        samples=scene.cycles.samples, frame=scene.frame_current), handle)
`;

/**
 * A successful exit/version banner is insufficient: require a decoded,
 * nonuniform 64px PNG and exact runtime/engine evidence from the fixed script.
 * Probe the operator-selected engine in the explicitly selected worker mode.
 * Failed EEVEE/GPU access never silently substitutes CPU Cycles or another mode.
 * Injection covers failure contracts on CI; fixtures are not renderer proof.
 */
export async function probeBlenderRender({ executable, fingerprint }, workspaceRoot, { worker = runContainedWorker, signal, engine = 'CYCLES', executionMode = 'contained' } = {}) {
  if (!executable) return null;
  let evidence = null;
  let invalidOutput = false;
  const run = await worker({
    tool: { executable, argv: entry => ['--background', '--factory-startup', '--disable-autoexec', '--threads', '2', '--python-exit-code', '1', '--python', entry] },
    workspaceRoot, entrypoint: 'probe.py', files: [{ path: 'probe.py', content: sceneSource(engine) }], signal,
    limits: { wallSeconds: 120, diskBytes: 64 * 1024 * 1024, maxFiles: 1000 },
    onOutput: async (directory, outputs) => {
      const report = outputs.find(file => file.path === 'report.json');
      const png = outputs.find(file => file.path === 'probe.png');
      if (!report || report.bytes > 16_384 || !png || png.bytes > 1024 * 1024) { invalidOutput = true; return; }
      // Decode under a strict pixel cap as well as the worker's file-size cap.
      const parsed = reportSchema(engine).safeParse(JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')));
      if (!parsed.success) { invalidOutput = true; return; }
      const bytes = await readFile(join(directory, 'probe.png'));
      const { default: sharp } = await import('sharp');
      const image = sharp(bytes, { limitInputPixels: 64 * 64 });
      const metadata = await image.metadata();
      if (metadata.format !== 'png' || metadata.width !== 64 || metadata.height !== 64) { invalidOutput = true; return; }
      const { data } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let min = 255; let max = 0;
      for (let i = 0; i < data.length; i += 4) {
        const luma = (data[i] + data[i + 1] + data[i + 2]) / 3;
        min = Math.min(min, luma); max = Math.max(max, luma);
      }
      if (max - min < 8) { invalidOutput = true; return; }
      evidence = { ...parsed.data, imageSha256: createHash('sha256').update(bytes).digest('hex') };
    },
  }).catch(() => ({ status: 'failed', reason: 'probe-or-output-failed', processGroupClear: false }));
  const passed = run.status === 'completed' && run.processGroupClear === true && !invalidOutput && Boolean(evidence);
  return {
    executable, fingerprint, executionMode, contained: executionMode === 'contained', engine, passed, version: passed ? evidence.version : null,
    render: passed ? evidence : null,
    durationMs: run.durationMs ?? null,
    detail: passed
      ? `Blender ${VERSION} rendered a 64 × 64 scene with ${engine} / ${evidence.device} / ${evidence.backend} in ${executionMode} mode. ${executionMode === 'trusted-local' ? 'Host access is not contained. ' : ''}This proves fixed-scene readiness; production-sequence acceptance remains separate. CPU Cycles may be slow.`
      : `Blender render check failed: expected ${VERSION}, ${engine} and a valid nonblank 64 × 64 PNG in ${executionMode} mode. A version banner or bpy import is insufficient; no fallback was attempted.`,
  };
}
