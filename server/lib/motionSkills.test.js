import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installMotionSkillPack } from './motionSkills.js';

const octal = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`;

function header({ name, size = 0, type = '0', link = '' }) {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0);
  block.write(octal(0o644, 8), 100);
  block.write(octal(size, 12), 124);
  block.write(octal(0, 12), 136);
  block.write('        ', 148);
  block.write(type, 156);
  block.write(link, 157);
  block.write('ustar\0' + '00', 257);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(octal(sum, 7) + ' ', 148);
  return block;
}

function tarball(entries, { pax = false } = {}) {
  const parts = [];
  if (pax) {
    const record = ' comment=example\n';
    const text = `${String(record.length + String(record.length + 2).length)}${record}`;
    parts.push(header({ name: 'pax_global_header', size: Buffer.byteLength(text), type: 'g' }), Buffer.from(text), Buffer.alloc((512 - (Buffer.byteLength(text) % 512)) % 512));
  }
  for (const { name, body = '', type = '0', link } of entries) {
    const data = Buffer.from(body);
    parts.push(header({ name, size: data.length, type, link }), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

const ROOT = 'example-0123456789abcdef0123456789abcdef01234567';
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
const packFor = (archive, overrides = {}) => ({
  id: 'example', label: 'Example', source: 'example-org/example-skills',
  revision: '0123456789abcdef0123456789abcdef01234567', sha256: sha(archive),
  skillsPath: 'skills', skills: ['alpha', 'beta'], ...overrides,
});
const fetchOf = archive => async () => new Response(archive, { status: 200 });
const goodEntries = [
  { name: `${ROOT}/skills/alpha/`, type: '5' },
  { name: `${ROOT}/skills/alpha/SKILL.md`, body: '# alpha\n' },
  { name: `${ROOT}/skills/alpha/ref/guide.md`, body: 'guide' },
  { name: `${ROOT}/skills/beta/SKILL.md`, body: '# beta\n' },
  { name: `${ROOT}/skills/other/SKILL.md`, body: '# not requested\n' },
  { name: `${ROOT}/packages/link`, type: '2', link: '../../skills' },
];

describe('installMotionSkillPack (#17725)', () => {
  let home;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'motion-skills-test-')); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  const homeHasNoSkills = async () => {
    for (const dir of ['.agents', '.claude']) {
      const present = await readdir(join(home, dir, 'skills')).catch(() => []);
      expect(present).toEqual([]);
    }
  };

  it('installs every requested skill into both agent directories and ignores the rest of the repo', async () => {
    const archive = tarball(goodEntries, { pax: true });
    const result = await installMotionSkillPack(packFor(archive), { home, fetchImpl: fetchOf(archive) });
    expect(result.skills).toEqual(['alpha', 'beta']);
    for (const dir of ['.agents', '.claude']) {
      expect(await readFile(join(home, dir, 'skills', 'alpha', 'SKILL.md'), 'utf8')).toBe('# alpha\n');
      expect(await readFile(join(home, dir, 'skills', 'alpha', 'ref', 'guide.md'), 'utf8')).toBe('guide');
      expect(await readFile(join(home, dir, 'skills', 'beta', 'SKILL.md'), 'utf8')).toBe('# beta\n');
      expect(await stat(join(home, dir, 'skills', 'other')).catch(() => null)).toBeNull();
    }
  });

  it('replaces a previously installed copy', async () => {
    const archive = tarball(goodEntries);
    await installMotionSkillPack(packFor(archive), { home, fetchImpl: fetchOf(archive) });
    const next = tarball(goodEntries.map(entry => entry.name.endsWith('alpha/SKILL.md') ? { ...entry, body: '# alpha v2\n' } : entry));
    await installMotionSkillPack(packFor(next), { home, fetchImpl: fetchOf(next) });
    expect(await readFile(join(home, '.agents', 'skills', 'alpha', 'SKILL.md'), 'utf8')).toBe('# alpha v2\n');
  });

  it('refuses an archive whose SHA-256 differs from the pin before extracting anything', async () => {
    const archive = tarball(goodEntries);
    await expect(installMotionSkillPack(packFor(archive, { sha256: 'a'.repeat(64) }), { home, fetchImpl: fetchOf(archive) }))
      .rejects.toThrow('SHA-256 mismatch');
    await homeHasNoSkills();
  });

  it('refuses a failed download', async () => {
    const archive = tarball(goodEntries);
    await expect(installMotionSkillPack(packFor(archive), { home, fetchImpl: async () => new Response('nope', { status: 404 }) }))
      .rejects.toThrow('HTTP 404');
  });

  it.each([
    ['parent traversal', { name: `${ROOT}/skills/alpha/../../../evil.md`, body: 'x' }, 'unsafe archive path'],
    ['absolute path', { name: '/etc/evil.md', body: 'x' }, 'unsafe archive path'],
    ['symlink', { name: `${ROOT}/skills/alpha/escape`, type: '2', link: '/etc' }, 'symlink entry'],
    ['hardlink', { name: `${ROOT}/skills/alpha/hard`, type: '1', link: `${ROOT}/skills/beta/SKILL.md` }, 'hardlink entry'],
    ['special file', { name: `${ROOT}/skills/alpha/fifo`, type: '6' }, 'special entry'],
  ])('refuses %s entries and installs nothing', async (_label, bad, message) => {
    const archive = tarball([...goodEntries, bad]);
    await expect(installMotionSkillPack(packFor(archive), { home, fetchImpl: fetchOf(archive) })).rejects.toThrow(message);
    await homeHasNoSkills();
  });

  it('refuses a requested skill with a missing or empty SKILL.md', async () => {
    for (const entries of [
      goodEntries.filter(entry => !entry.name.includes('/beta/')),
      goodEntries.map(entry => entry.name.endsWith('beta/SKILL.md') ? { ...entry, body: '' } : entry),
    ]) {
      const archive = tarball(entries);
      await expect(installMotionSkillPack(packFor(archive), { home, fetchImpl: fetchOf(archive) })).rejects.toThrow('no non-empty SKILL.md');
      await homeHasNoSkills();
    }
  });
});
