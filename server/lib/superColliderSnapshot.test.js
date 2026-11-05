import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PATHS } from './paths.js';

const recipe = join(PATHS.root, 'docker/supercollider');
const fixtures = join(PATHS.root, 'server/test/fixtures/supercollider-snapshot');
const pins = join(recipe, 'debian-inrelease.sha256');
const names = Object.fromEntries(['trixie', 'trixie-updates', 'trixie-security'].map((suite) => {
  const line = readFileSync(pins, 'utf8').split('\n').find((entry) => entry.endsWith(`_dists_${suite}_InRelease`));
  return [suite, line?.split('  ')[1]];
}));

describe.skipIf(process.platform === 'win32')('SuperCollider Debian snapshot verification', () => {
  let temp;
  let lists;
  let env;
  const content = (fixture) => readFileSync(join(fixtures, `${fixture}.InRelease`));
  const verify = () => spawnSync('sh', [join(recipe, 'verify-snapshot.sh'), lists, pins], { encoding: 'utf8', env });

  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), 'portos-snapshot-test-'));
    lists = join(temp, 'lists');
    mkdirSync(lists);
    env = { ...process.env };
    // macOS has shasum by default; production runs GNU sha256sum in Debian.
    if (process.platform === 'darwin') {
      const bin = join(temp, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'sha256sum'), '#!/bin/sh\nexec shasum -a 256 "$@"\n', { mode: 0o755 });
      env.PATH = `${bin}:${env.PATH}`;
    }
    for (const [suite, name] of Object.entries(names)) {
      expect(name).toBeTruthy();
      writeFileSync(join(lists, name), content(suite));
    }
  });

  afterEach(() => rmSync(temp, { recursive: true, force: true }));

  it('accepts the intended signed metadata for all three suites', () => {
    const result = verify();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects an older, independently verified Debian-signed updates file', () => {
    writeFileSync(join(lists, names['trixie-updates']), content('older-trixie-updates'));
    const result = verify();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('FAILED');
  });

  it('rejects a missing or substituted suite', () => {
    rmSync(join(lists, names['trixie-security']));
    expect(verify().status).not.toBe(0);
    writeFileSync(join(lists, names['trixie-security']), content('trixie-updates'));
    expect(verify().status).not.toBe(0);
  });

  it.each(['unexpected_InRelease', 'unexpected_Release', 'unexpected_Release.gpg'])(
    'rejects an extra signed source (%s)',
    (name) => {
      writeFileSync(join(lists, name), content('trixie-updates'));
      expect(verify().status).not.toBe(0);
    },
  );
});
