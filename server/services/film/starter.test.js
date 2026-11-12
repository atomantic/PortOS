/** The shipped describe() must tile silent and non-frame-aligned soundtracks exactly. */
import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from '../../lib/childProcess.js';
import { resolveTestPython, PY_SUBPROCESS_TIMEOUT_MS, PY_TEST_TIMEOUT_MS } from '../../lib/testHelper.js';
import { validateBlenderManifest, blenderFilmProblems } from './manifest.js';

it('describes starter shots through the last frame for a short silent film and fractional audio duration', async () => {
  const bootstrap = `import importlib.util,json,sys,types
sys.path.insert(0,sys.argv[2])
kit=types.ModuleType('kit'); kit.look=types.SimpleNamespace(PALETTES={'warm':{}}); kit.stage=types.SimpleNamespace(); sys.modules['kit']=kit
shots=types.ModuleType('shots')
for name in ('hero','orbit','wide'):
    setattr(shots,name,types.SimpleNamespace(__name__=name,SUMMARY='',ACTION='',STAGING='',CAMERA='',DEPS=[]))
sys.modules['shots']=shots
spec=importlib.util.spec_from_file_location('film',sys.argv[1]); film=importlib.util.module_from_spec(spec); spec.loader.exec_module(film)
print(json.dumps([film.describe(types.SimpleNamespace(song={'durationSec':d,'analysis':{}},fps=24)) for d in (1,6.01)]))`;
  const { stdout } = await promisify(execFile)(resolveTestPython(), ['-c', bootstrap,
    fileURLToPath(new URL('./py/starter/film.py', import.meta.url)), fileURLToPath(new URL('./py/', import.meta.url))], { timeout: PY_SUBPROCESS_TIMEOUT_MS });
  JSON.parse(stdout).forEach((raw, index) => {
    const timeline = { durationSec: [1, 6.01][index], fps: 24 };
    const checked = validateBlenderManifest(raw, timeline);
    expect(checked.errors).toEqual([]);
    expect(blenderFilmProblems({ ...checked.manifest, fps: 24 }, timeline)).toEqual([]);
    expect(Math.round(checked.manifest.shots.at(-1).end * 24)).toBe(Math.ceil(timeline.durationSec * 24));
  });
}, PY_TEST_TIMEOUT_MS);
