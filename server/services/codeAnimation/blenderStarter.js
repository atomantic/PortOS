/** Data-only original starter; fetching it never runs code or calls a provider. */
import { readFile } from 'node:fs/promises';
import { createCodeAnimationPackage } from '../../lib/codeAnimationPackage.js';
import { LATEST_BLENDER_VERSION } from '../../lib/blenderVersion.js';

/** `version` is the checked executable's version when one passed, so the starter can render as-is. */
export async function getBlenderStarterPackage({ version = LATEST_BLENDER_VERSION } = {}) {
  return createCodeAnimationPackage({
    title: 'Lantern in a Painted Garden',
    brief: { concept: 'A glowing paper lantern crosses an indigo garden under an ivory moon, trailing hand-painted sparks.', cast: 'One vermilion paper lantern', onScreenText: '' },
    styleGuide: 'Original procedural pigment atlas, faceted paper shapes, warm coral and gold against cool indigo and teal. Subject on twos, baked sparks on threes, smooth camera.',
    renderer: { kind: 'blender', version, engine: 'CYCLES' },
    format: { width: 1920, height: 1080, fps: 24, durationSeconds: 10 }, seed: 17,
    entrypoints: [{ role: 'scene', path: 'scene.py' }], assets: [],
    shots: [{ label: 'Lantern crossing', startSeconds: 0, endSeconds: 10 }], events: [],
    audio: { kind: 'silence' }, execution: { requested: null, effective: null },
  }, [{ path: 'scene.py', content: await readFile(new URL('./blenderStarter.py', import.meta.url), 'utf8') }]);
}
