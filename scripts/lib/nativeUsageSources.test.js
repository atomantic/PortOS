import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, open, opendir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runNativeUsageRehearsalCli } from '../native-usage-rehearse.js';
import { json, prepare, put } from './nativeUsageSources.testFixture.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, open: vi.fn(actual.open), opendir: vi.fn(actual.opendir), lstat: vi.fn(actual.lstat), link: vi.fn(actual.link) };
});
let dir;
beforeEach(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), 'source-boundaries-'))); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
const run = args => runNativeUsageRehearsalCli(args, { stdout: () => {}, stderr: () => {} });
const backup = f => run(['sources-backup', f.stagePath, f.requestPath, f.source, f.bundle]);
const restore = f => run(['sources-restore', f.stagePath, f.bundle, f.restored]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function rewriteSidecar(f, edit) {
  const path = join(f.bundle, 'data/native-sources.json');
  const sidecar = JSON.parse(await readFile(path)); edit(sidecar);
  const bytes = json(sidecar); await writeFile(path, bytes);
  const manifestPath = join(f.bundle, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath));
  manifest.files['native-sources.json'] = digest(bytes);
  await writeFile(manifestPath, json(manifest));
}

describe('detached sources fail-closed filesystem boundary', () => {
  it.each(['extra-file', 'missing-file', 'changed-bytes', 'extra-directory', 'missing-directory', 'report-change', 'role-change', 'wrong-stage'])
  ('refuses %s in an otherwise completed bundle before creating a restore', async defect => {
    const f = await prepare(dir); await backup(f);
    const data = join(f.bundle, 'data');
    if (defect === 'extra-file') await put(data, 'codexSessions/private-extra.bin', 'extra');
    if (defect === 'missing-file') await rm(join(data, 'codexSessions/private-rollout.jsonl'));
    if (defect === 'changed-bytes') await writeFile(join(data, 'agyIdeConversations/private-ide.pb'), 'changed');
    if (defect === 'extra-directory') await mkdir(join(data, 'codexSessions/private-extra'));
    if (defect === 'missing-directory') await rm(join(data, 'codexSessions/private-empty'), { recursive: true });
    if (defect === 'report-change') await writeFile(join(data, 'participant-report.json'), '{}');
    if (defect === 'role-change') await rewriteSidecar(f, value => { value.roles.codexSessions = 'not-supplied/unknown'; });
    if (defect === 'wrong-stage') await rewriteSidecar(f, value => { value.stageHash = '0'.repeat(64); });
    await expect(restore(f)).rejects.toThrow();
    await expect(lstat(f.restored)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['../outside', '/absolute', 'codexSessions\\alias', 'codexSessions/./alias', 'codexSessions/alias:stream', 'codexSessions/alias.'])
  ('rejects a manifest path alias without reading or writing through it: %s', async name => {
    const f = await prepare(dir, { absent: true }); await backup(f);
    const path = join(f.bundle, 'manifest.json'); const manifest = JSON.parse(await readFile(path));
    manifest.files[name] = '0'.repeat(64); manifest.fileCount++;
    await writeFile(path, json(manifest));
    await expect(restore(f)).rejects.toThrow('sources-path-invalid');
  });

  for (const defect of ['file-link', 'directory-link', 'ancestor-link', 'hardlink', 'fifo', 'case-alias', 'unexpected-config-root']) {
    it.skipIf(process.platform === 'win32' && defect === 'file-link')
    (`refuses ${defect} in detached input without a completed backup`, async () => {
    const f = await prepare(dir, { absent: true });
    f.request.roles.codexSessions = 'provided';
    await writeFile(f.requestPath, json(f.request));
    await mkdir(join(f.source, 'codexSessions'));
    await put(dir, 'outside/private-secret', 'not a source');
    if (defect === 'file-link') await symlink(join(dir, 'outside/private-secret'), join(f.source, 'codexSessions/link'));
    if (defect === 'directory-link') await symlink(join(dir, 'outside'), join(f.source, 'codexSessions/link'), process.platform === 'win32' ? 'junction' : 'dir');
    if (defect === 'ancestor-link') { await symlink(f.source, join(dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir'); f.source = join(dir, 'alias'); }
    if (defect === 'hardlink') await link(join(dir, 'outside/private-secret'), join(f.source, 'codexSessions/link'));
    if (defect === 'fifo') {
      const special = join(f.source, 'codexSessions/pipe'); await writeFile(special, '');
      const actual = await vi.importActual('node:fs/promises');
      vi.mocked(lstat).mockImplementation(async path => {
        const info = await actual.lstat(path);
        return path === special ? Object.assign(info, { isFile: () => false, isDirectory: () => false }) : info;
      });
    }
    if (defect === 'case-alias') {
      await put(f.source, 'codexSessions/A', 'a');
      const actual = await vi.importActual('node:fs/promises');
      vi.mocked(opendir).mockImplementation(async path => path === join(f.source, 'codexSessions') ? {
        async *[Symbol.asyncIterator]() { yield { name: 'A' }; yield { name: 'a' }; },
      } : actual.opendir(path));
    }
    if (defect === 'unexpected-config-root') await put(f.source, 'config/auth.json', 'not a source');
    await expect(backup(f)).rejects.toThrow();
    await expect(lstat(join(f.bundle, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  }

  it('rejects missing role declarations, false absence and an output nested inside detached input', async () => {
    const f = await prepare(dir, { absent: true });
    delete f.request.roles.codexSessions; await writeFile(f.requestPath, json(f.request));
    await expect(backup(f)).rejects.toThrow('sources-request-invalid');
    f.request.roles.codexSessions = 'absent-from-detached-input'; await writeFile(f.requestPath, json(f.request));
    await mkdir(join(f.source, 'codexSessions'));
    await expect(backup(f)).rejects.toThrow('sources-role-inventory-mismatch');
    await rm(join(f.source, 'codexSessions'), { recursive: true });
    f.bundle = join(f.source, 'output');
    await expect(backup(f)).rejects.toThrow('sources-output-overlaps-input');
  });

  it('leaves interrupted publication visibly incomplete and refuses both restore and overwrite retry', async () => {
    const f = await prepare(dir, { absent: true });
    vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error('synthetic interruption'), { code: 'EIO' }));
    await expect(backup(f)).rejects.toThrow('synthetic interruption');
    expect(await readdir(f.bundle)).toContain('.in-progress');
    expect(await readdir(f.bundle)).not.toContain('manifest.json');
    await expect(restore(f)).rejects.toThrow('sources-incomplete-or-unexpected-files');
    await expect(backup(f)).rejects.toThrow('sources-destination-exists');
  });

  for (const defect of ['modified', 'replaced-by-link']) {
    it.skipIf(process.platform === 'win32' && defect === 'replaced-by-link')(`refuses a ${defect} persisted replay verdict before reporting success`, async () => {
    const f = await prepare(dir, { absent: true }); await backup(f);
    const actual = await vi.importActual('node:fs/promises');
    const receipt = join(f.restored, 'replay.json');
    vi.mocked(link).mockImplementation(async (...args) => {
      await actual.link(...args);
      if (args[1] === join(f.restored, 'manifest.json')) {
        if (defect === 'modified') await writeFile(receipt, '{"retainedReplayVerified":true}');
        else {
          const outside = join(dir, 'replacement-receipt');
          await rename(receipt, outside); await symlink(outside, receipt);
        }
      }
    });
    await expect(restore(f)).rejects.toThrow(defect === 'modified' ? 'sources-replay-receipt-mismatch' : 'snapshot-input-not-bounded-regular-file');
    });
  }

  it('detects changes after copy without publishing a manifest', async () => {
    const f = await prepare(dir);
    const target = join(f.source, 'codexSessions/private-rollout.jsonl');
    const actual = await vi.importActual('node:fs/promises');
    let changed = false;
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (args[0] === target && !changed) {
        const close = handle.close.bind(handle);
        handle.close = async () => { await close(); changed = true; await writeFile(target, 'changed while backing up'); };
      }
      return handle;
    });
    await expect(backup(f)).rejects.toThrow('sources-input-changed');
    expect(await readdir(f.bundle)).toContain('.in-progress');
    await expect(lstat(join(f.bundle, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses pinned leaf replacement and bounded-file/depth violations', async () => {
    const f = await prepare(dir);
    const target = join(f.source, 'codexSessions/private-rollout.jsonl');
    const replacement = join(dir, 'replacement'); await writeFile(replacement, await readFile(target));
    const actual = await vi.importActual('node:fs/promises');
    let changed = false;
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (args[0] === target && !changed) { changed = true; await rename(replacement, target); }
      return handle;
    });
    await expect(backup(f)).rejects.toThrow('snapshot-input-changed');
    vi.mocked(open).mockImplementation(actual.open);
    f.bundle = join(dir, 'bounded-bundle');
    vi.mocked(lstat).mockImplementation(async path => {
      const info = await actual.lstat(path);
      if (path === target) Object.defineProperty(info, 'size', { value: 100 * 1024 ** 3 + 1 });
      return info;
    });
    await expect(backup(f)).rejects.toThrow('snapshot-byte-limit-exceeded');
    vi.mocked(lstat).mockImplementation(actual.lstat);
    await mkdir(join(f.source, 'codexSessions', ...Array(65).fill('nested')), { recursive: true });
    f.bundle = join(dir, 'deep-bundle');
    await expect(backup(f)).rejects.toThrow('sources-depth-limit-exceeded');
  });

  it('bounds directory enumeration before materializing an excessive inventory', async () => {
    const f = await prepare(dir, { absent: true });
    const actual = await vi.importActual('node:fs/promises');
    vi.mocked(opendir).mockImplementation(async path => path === f.source ? {
      async *[Symbol.asyncIterator]() { for (let index = 0; index < 100004; index++) yield { name: `entry-${index}` }; },
    } : actual.opendir(path));
    await expect(backup(f)).rejects.toThrow('sources-entry-limit-exceeded');
    await expect(lstat(f.bundle)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('redacts OS errors at the executable boundary without leaking requested paths', async () => {
    const f = await prepare(dir, { absent: true });
    const output = spawnSync(process.execPath, [fileURLToPath(new URL('../native-usage-rehearse.js', import.meta.url)),
      'sources-backup', f.stagePath, f.requestPath, join(dir, 'private-secret-missing'), f.bundle], { encoding: 'utf8' });
    expect(output.status).toBe(1);
    expect(output.stdout + output.stderr).not.toContain(dir);
    expect(output.stdout + output.stderr).not.toContain('private-secret-missing');
    expect(output.stdout).toContain('Native usage rehearsal failed');
  });
});
