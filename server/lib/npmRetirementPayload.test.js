import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createNpmRetirementVerifier } from './npmRetirementPayload.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const work = { check() {}, add() {} };
const integrity = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
function tarball(members) {
  const parts = [];
  for (const { name, content = '', type = '0' } of members) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148);
    parts.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

async function fixture(members = [{ name: 'package/index.js', content: 'export const value = 1;\n' }], localContent = 'export const value = 1;\n') {
  const root = await mkdtemp(join(tmpdir(), 'npm-retirement-'));
  roots.push(root);
  const checkout = join(root, 'checkout'); const primary = join(root, 'primary'); const cacheRoot = join(root, 'cache');
  const archive = tarball(members);
  const entry = { version: '1.0.0', integrity: integrity(archive), optional: true };
  const lock = { name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { 'node_modules/example': entry } };
  for (const dir of [checkout, primary]) {
    await mkdir(join(dir, 'node_modules'), { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    await writeFile(join(dir, 'package-lock.json'), JSON.stringify(lock));
  }
  await writeFile(join(checkout, 'node_modules/.package-lock.json'), JSON.stringify(lock));
  await mkdir(join(checkout, 'node_modules/example'));
  await writeFile(join(checkout, 'node_modules/example/index.js'), localContent);
  const hex = Buffer.from(entry.integrity.slice(7), 'base64').toString('hex');
  const cached = join(cacheRoot, '_cacache/content-v2/sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
  await mkdir(join(cached, '..'), { recursive: true }); await writeFile(cached, archive);
  const verifier = () => createNpmRetirementVerifier(checkout, primary, work, { cacheRoot });
  return { root, checkout, primary, cached, lock, verifier };
}

describe('private npm payload retirement proof', () => {
  it('accepts exact pinned cached bytes and generated metadata, but retains modifications and extra user files', async () => {
    const f = await fixture(); const verify = f.verifier();
    expect(await verify('node_modules/.package-lock.json')).toBe(true);
    expect(await verify('node_modules/example/index.js')).toBe(true);
    await writeFile(join(f.checkout, 'node_modules/example/index.js'), 'local debugging change');
    expect(await f.verifier()('node_modules/example/index.js')).toBe(false);
    await writeFile(join(f.checkout, 'node_modules/example/index.js'), 'export const value = 1;\n');
    await writeFile(join(f.checkout, 'node_modules/example/notes.txt'), 'unique user notes');
    expect(await f.verifier()('node_modules/example/notes.txt')).toBe(false);
    expect(await f.verifier()('node_modules/example/index.js')).toBe(false);
  });

  it('requires matching tracked inputs and an unchanged integrity-verified cache artifact', async () => {
    const f = await fixture();
    await writeFile(f.cached, 'corrupt cached archive');
    expect(await f.verifier()('node_modules/example/index.js')).toBe(false);
    await writeFile(join(f.checkout, 'package.json'), '{"name":"different"}');
    expect(await f.verifier()('node_modules/.package-lock.json')).toBe(false);
  });

  it('accepts a byte-identical protected primary counterpart without trusting arbitrary hidden-lock fields', async () => {
    const f = await fixture();
    await mkdir(join(f.primary, 'node_modules/example'));
    await writeFile(join(f.primary, 'node_modules/example/index.js'), 'export const value = 1;\n');
    await rm(f.cached);
    expect(await f.verifier()('node_modules/example/index.js')).toBe(true);
    f.lock.privateNotes = 'unique metadata';
    await writeFile(join(f.checkout, 'node_modules/.package-lock.json'), JSON.stringify(f.lock));
    expect(await f.verifier()('node_modules/.package-lock.json')).toBe(false);
  });

  it('refuses cached-package fallback for install-script outputs', async () => {
    const f = await fixture();
    f.lock.packages['node_modules/example'].hasInstallScript = true;
    for (const path of [join(f.checkout, 'package-lock.json'), join(f.primary, 'package-lock.json'), join(f.checkout, 'node_modules/.package-lock.json')]) {
      await writeFile(path, JSON.stringify(f.lock));
    }
    expect(await f.verifier()('node_modules/example/index.js')).toBe(false);
  });

  it('propagates the retirement resource budget rather than disguising exhaustion as missing evidence', async () => {
    const f = await fixture();
    const limit = Object.assign(new Error('retirement-archive-work-limit-exceeded'), { archiveLimit: { scope: 'verification' } });
    const verify = createNpmRetirementVerifier(f.checkout, f.primary, { check() { throw limit; }, add() {} });
    await expect(verify('node_modules/example/index.js')).rejects.toBe(limit);
  });

  it.skipIf(process.platform === 'win32')('refuses a primary counterpart reached through an escaping symlink', async () => {
    const f = await fixture();
    await rm(f.cached);
    await symlink(join(f.checkout, 'node_modules/example'), join(f.primary, 'node_modules/example'));
    expect(await f.verifier()('node_modules/example/index.js')).toBe(false);
  });

  it.each([
    { name: 'link member', members: [{ name: 'package/index.js', type: '2' }], localContent: '' },
    { name: 'duplicate member', members: [{ name: 'package/index.js', content: 'first' }, { name: 'package/index.js', content: 'expected' }], localContent: 'expected' },
    { name: 'extended header', members: [{ name: 'package/index.js', type: 'x', content: 'expected' }], localContent: 'expected' },
  ])('refuses unsafe or ambiguous pinned cache: $name', async ({ members, localContent }) => {
    const f = await fixture(members, localContent);
    expect(await f.verifier()('node_modules/example/index.js')).toBe(false);
  });
});
