// Opt-in real Recycle Bin check for the Windows CI job (issue #12325). The
// mocked suite in nativeTrash.test.js cannot notice a Windows update breaking
// the shipped windows-trash.exe, and a developer's real bin must stay untouched
// unless they set PORTOS_NATIVE_TRASH_SMOKE themselves.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { execFileSync } from './childProcess.js';
import { moveToNativeTrash } from './nativeTrash.js';

// $I<id>: 8-byte version, 8-byte size, 8-byte FILETIME, then (version 2) a
// 4-byte path length and the UTF-16LE original path; version 1 is a padded path.
const readOriginalPath = (buf) => (buf.readBigUInt64LE(0) >= 2n
  ? buf.toString('utf16le', 28, 28 + (buf.readUInt32LE(24) - 1) * 2)
  : buf.toString('utf16le', 24).replace(/\0.*$/s, ''));

describe.runIf(process.platform === 'win32' && process.env.PORTOS_NATIVE_TRASH_SMOKE)('native recycling adapter on a real Recycle Bin', () => {
  let dir;
  let binDir;
  let infoFile;
  afterEach(async () => {
    // Remove only the pair this test created, then its temp directory.
    if (infoFile) {
      await unlink(infoFile).catch(() => {});
      await unlink(join(binDir, `$R${parse(infoFile).base.slice(2)}`)).catch(() => {});
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('recycles a temp file and leaves a $I record naming its original path', async () => {
    // The shell records the long form; the runner's tmpdir is an 8.3 short path.
    dir = await mkdtemp(join(realpathSync.native(tmpdir()), 'portos-native-trash-smoke-'));
    const file = join(dir, 'smoke target.txt');
    await writeFile(file, 'native trash smoke');
    const sid = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
      .trim().split(',')[1].replaceAll('"', '');
    binDir = join(parse(file).root, '$Recycle.Bin', sid);

    await moveToNativeTrash([file]);

    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    const seen = [];
    for (const name of await readdir(binDir)) {
      if (!name.startsWith('$I')) continue;
      const original = readOriginalPath(await readFile(join(binDir, name)));
      seen.push(original);
      if (original.toLowerCase() === file.toLowerCase()) infoFile = join(binDir, name);
    }
    expect(infoFile, `a $I record naming ${file}; bin holds ${JSON.stringify(seen)}`).toBeDefined();
  });
});
