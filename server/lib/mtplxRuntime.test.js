import { chmod, mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { describeMtplxRuntime } from './mtplxRuntime.js';

// The real Homebrew shim, trimmed to the two lines the probe reads.
const wrapperScript = (venv) => `#!/bin/bash
set -euo pipefail
VENV="\${MTPLX_BREW_VENV:-${venv}}"
PYTHON="/opt/homebrew/opt/python@3.13/bin/python3.13"

if [ ! -x "$VENV/bin/mtplx" ]; then
  echo "MTPLX runtime is not installed. Bootstrapping with pip..."
  "$PYTHON" -m venv "$VENV"
fi
exec "$VENV/bin/mtplx" "$@"
`;

describe('describeMtplxRuntime', () => {
  let dir = null;
  const wrapperAt = async (name, body) => {
    const path = join(dir, name);
    await writeFile(path, body);
    await chmod(path, 0o755);
    return path;
  };
  const buildVenv = async (venv) => {
    await mkdir(join(venv, 'bin'), { recursive: true });
    const real = join(venv, 'bin', 'mtplx');
    await writeFile(real, '#!/bin/sh\necho 2.10.1\n');
    await chmod(real, 0o755);
  };

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'portos-mtplx-runtime-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('reports NOT ready for a wrapper whose version-keyed venv has never been built', async () => {
    // The whole point: this is the state in which running the binary would
    // start a several-hundred-megabyte pip install.
    const path = await wrapperAt('mtplx', wrapperScript(join(dir, 'var', 'venv-2.10.1')));
    expect(await describeMtplxRuntime(path, { env: {} })).toEqual({
      ready: false,
      wrapper: true,
      venvPath: join(dir, 'var', 'venv-2.10.1'),
    });
  });

  it('reports ready once the venv holds an executable mtplx', async () => {
    const venv = join(dir, 'var', 'venv-2.10.1');
    await buildVenv(venv);
    const path = await wrapperAt('mtplx', wrapperScript(venv));
    expect(await describeMtplxRuntime(path, { env: {} })).toMatchObject({ ready: true, wrapper: true });
  });

  it('honours $MTPLX_BREW_VENV, exactly as the wrapper\'s ${MTPLX_BREW_VENV:-…} does', async () => {
    const override = join(dir, 'elsewhere', 'venv');
    await buildVenv(override);
    // The wrapper's own default is empty, so a probe that ignored the override
    // would report "not ready" for a runtime that is right there.
    const path = await wrapperAt('mtplx', wrapperScript(join(dir, 'var', 'venv-2.10.1')));
    expect(await describeMtplxRuntime(path, { env: { MTPLX_BREW_VENV: override } }))
      .toMatchObject({ ready: true, venvPath: override });
  });

  // Everything below is the "keep today's behaviour" half. Reporting `false`
  // for a binary this parser does not recognise would block a working install
  // over a parse failure, so each of these must come back ready.
  it('reports ready for a pip install — the real console script, not a wrapper', async () => {
    const path = await wrapperAt('mtplx', '#!/usr/bin/env python3\nfrom mtplx.cli import main\nmain()\n');
    expect(await describeMtplxRuntime(path, { env: {} })).toEqual({ ready: true, wrapper: false, venvPath: null });
  });

  it('reports ready for a compiled binary rather than decoding it', async () => {
    const path = join(dir, 'mtplx');
    await writeFile(path, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00, 0x01, 0x00, 0x00]));
    await chmod(path, 0o755);
    expect(await describeMtplxRuntime(path, { env: {} })).toMatchObject({ ready: true, wrapper: false });
  });

  it('reports ready for a wrapper-shaped script whose VENV it cannot resolve', async () => {
    const path = await wrapperAt('mtplx', '#!/bin/bash\nVENV="$(dirname "$0")/../var/venv"\nexec "$VENV/bin/mtplx" "$@"\n');
    expect(await describeMtplxRuntime(path, { env: {} })).toMatchObject({ ready: true, wrapper: false });
  });

  it('reports ready when the file cannot be read at all', async () => {
    expect(await describeMtplxRuntime(join(dir, 'not-here'), { env: {} }))
      .toMatchObject({ ready: true, wrapper: false });
  });

  it('reports not-ready for no binary at all — there is nothing installed to warm', async () => {
    expect(await describeMtplxRuntime(null, { env: {} })).toEqual({ ready: false, wrapper: false, venvPath: null });
  });
});
