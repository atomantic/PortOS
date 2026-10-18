import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { trashFiles } from './trashFiles.js';

const { trash, probe } = vi.hoisted(() => ({ trash: vi.fn(), probe: vi.fn() }));
vi.mock('node:fs/promises', async original => {
  const actual = await original();
  return { ...actual, lstat: probe.mockImplementation(actual.lstat) };
});
vi.mock('./nativeTrash.js', () => ({ moveToNativeTrash: trash }));
let root;
beforeEach(async () => {
  probe.mockImplementation((await vi.importActual('node:fs/promises')).lstat);
  root = await mkdtemp(join(tmpdir(), 'portos-trash-contract-'));
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe('recoverable file deletion', () => {
  it('moves literal originals and sidecars into a recoverable bin, skipping absent derivatives', async () => {
    const bin = join(root, 'bin');
    await mkdir(bin);
    const image = join(root, 'scene[1].png');
    const metadata = join(root, 'scene[1].metadata.json');
    await writeFile(image, 'pixels');
    await writeFile(metadata, '{"prompt":"example"}');
    trash.mockImplementationOnce(async paths => { for (const path of paths) await rename(path, join(bin, basename(path))); });
    await trashFiles([image, image, metadata, join(root, 'missing.webp')]);
    expect(trash).toHaveBeenLastCalledWith([image, metadata]);
    expect(await readFile(join(bin, basename(image)), 'utf8')).toBe('pixels');
    expect(JSON.parse(await readFile(join(bin, basename(metadata)), 'utf8'))).toEqual({ prompt: 'example' });
  });

  it.each(['rejected', 'false success'])('refuses %s recycling without permanently deleting the file', async failure => {
    const file = join(root, 'clip.mp4');
    await writeFile(file, 'video');
    if (failure === 'rejected') trash.mockRejectedValueOnce(new Error('native trash unavailable'));
    else trash.mockResolvedValueOnce();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(trashFiles([file])).rejects.toMatchObject({ code: 'MEDIA_TRASH_FAILED' });
    expect(await readFile(file, 'utf8')).toBe('video');
  });
});

it('refuses an unreadable post-trash probe instead of inferring the file is gone', async () => {
  const file = join(root, 'clip.mp4');
  const binFile = join(root, 'recycled.mp4');
  await writeFile(file, 'video');
  const actual = await vi.importActual('node:fs/promises');
  probe.mockImplementationOnce(actual.lstat).mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
  trash.mockImplementationOnce(async () => { await rename(file, binFile); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(trashFiles([file])).rejects.toMatchObject({ code: 'MEDIA_TRASH_FAILED' });
  expect(await readFile(binFile, 'utf8')).toBe('video');
});
