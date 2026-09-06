/** Machine-local Reactor runtime, provisioned only by an authorized render. */
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from '../../lib/childProcess.js';
import { PATHS } from '../../lib/fileUtils.js';

const execute = promisify(execFile);
let preparation;
const probe = (python, expected) => execute(python, ['-c', 'import sys; from importlib.metadata import version; assert version("reactor-sdk") == sys.argv[1]; from reactor_sdk import Reactor; Reactor("reactor/fast-h3")', expected], { timeout: 15_000, maxBuffer: 4096 }).then(() => true, () => false);

export async function ensureReactorRuntime() {
  const requirements = await readFile(join(PATHS.root, 'scripts', 'requirements-reactor.txt'), 'utf8');
  const expected = requirements.match(/^reactor-sdk==([0-9.]+)\r?$/m)?.[1];
  if (!expected) throw new Error('Reactor SDK version pin is missing');
  const override = process.env.REACTOR_PYTHON_PATH;
  const python = override || join(PATHS.data, 'venvs', 'reactor', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (override) {
    // Preserve custom environments; never install into an operator-owned path.
    if (await probe(python, expected)) return python;
    throw new Error('The custom Reactor Python runtime is unavailable or incompatible; remove the custom override to use automatic setup');
  }
  // Share verification as well as installation: a late failed probe must not
  // start a second repair while the first caller is already rendering.
  preparation ||= prepareRuntime(python, expected).finally(() => { preparation = null; });
  return preparation;
}

async function prepareRuntime(python, expected) {
  if (await probe(python, expected)) return python;
  await execute(process.execPath, [join(PATHS.root, 'scripts', 'setup-reactor.js')], {
    env: { ...process.env, PORTOS_REACTOR_DATA: PATHS.data }, timeout: 1_200_000, maxBuffer: 8192,
  }).catch(() => { throw new Error('Automatic Reactor runtime preparation failed; check network access and disk space, then retry the render'); });
  if (!await probe(python, expected)) throw new Error('Reactor runtime verification failed; retry the render to repair the installation');
  return python;
}
