/**
 * Catalog of optional motion-design agent skill packs (`MOTION_SKILL_PACKS`) and
 * `detectMotionSkills()` to find which are installed, shared by setup and the launch-video form.
 *
 * Optional motion-design agent skill packs (HyperFrames, Remotion, Claude Animation) —
 * `MOTION_SKILL_PACKS` catalog shared by `npm run setup:motion` and the launch-video form,
 * `detectMotionSkills()` finds installed skills under `~/.agents/skills` / `~/.claude/skills`.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

/**
 * Optional third-party agent skills that teach motion-design technique.
 * `npm run setup:motion -- --skills` installs them user-wide from a pinned,
 * SHA-256-verified GitHub archive (`installMotionSkillPack`); a launch-video run
 * can then ask its agent to consult them. They are technique references only:
 * every render still goes through the PortOS seek(t) composition contract and
 * its launch-video gates.
 *
 * `revision` is an immutable commit and `sha256` the digest of
 * `https://codeload.github.com/<source>/tar.gz/<revision>`; `skillsPath` is where
 * the skill folders live inside that archive. To bump a pack, change all three
 * together after reviewing the new revision's SKILL.md folders.
 */
export const MOTION_SKILL_PACKS = Object.freeze([
  Object.freeze({
    id: 'hyperframes',
    label: 'HyperFrames',
    source: 'heygen-com/hyperframes',
    // Upstream later moved these folders; this is the last commit that still ships all four.
    revision: '207c8a4daf6480d697f203784f1fd422727569e3',
    sha256: '25064f317b8518ab50316c92c4dadbbb566d950db78b9d3c21675454e87c8b2f',
    skillsPath: 'skills',
    skills: Object.freeze(['hyperframes-animation', 'hyperframes-creative', 'motion-graphics', 'product-launch-video']),
    description: 'HTML motion-graphics, product-launch and animation craft guides',
  }),
  Object.freeze({
    id: 'remotion',
    label: 'Remotion',
    source: 'remotion-dev/skills',
    revision: '6f55706d1069e512430582ad86e4e57dc07afe1b',
    sha256: '6f9ebc5915a2c48d06d4a4a7da56b1a29127cf6d3e1d2d9aca1af887ced84ee9',
    skillsPath: 'skills',
    skills: Object.freeze(['remotion-best-practices']),
    description: 'Content, animation and effects best practices',
  }),
  Object.freeze({
    id: 'claude-animation',
    label: 'Claude Animation',
    source: 'buildwithhanif/claude-animation-skill',
    revision: '4ddb8c80fdec96dc9f55d4b9bdee60bde6f0134b',
    sha256: 'fe3e7761ea5136a4180332294eeb2dc7e8c04594b3ab746a030d7a360b2ac924',
    skillsPath: 'plugins/claude-animation/skills',
    skills: Object.freeze(['claude-animation']),
    description: 'Hand-drawn 2D animation rigs, pens and synthesized sound',
  }),
]);

// The canonical copy goes to ~/.agents/skills (read by Codex) and a copy into
// ~/.claude/skills for Claude Code.
const motionSkillDirs = (home = homedir()) => [join(home, '.agents', 'skills'), join(home, '.claude', 'skills')];

/** Each pack with the skill names found on disk; `installed` means all of them. */
export function detectMotionSkills({ home = homedir(), exists = existsSync } = {}) {
  const dirs = motionSkillDirs(home);
  return MOTION_SKILL_PACKS.map(pack => {
    const found = pack.skills.filter(name => dirs.some(dir => exists(join(dir, name, 'SKILL.md'))));
    return { id: pack.id, label: pack.label, description: pack.description, skills: [...pack.skills], found, installed: found.length === pack.skills.length };
  });
}

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_SKILL_FILE_BYTES = 32 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const BLOCK = 512;

const cString = (buf, start, len) => {
  const slice = buf.subarray(start, start + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? len : end).toString('utf8');
};

function parseOctal(buf, start, len) {
  const text = cString(buf, start, len).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error('Corrupt tar header: bad numeric field');
  return parseInt(text, 8);
}

// pax extended-header records: "<len> <key>=<value>\n".
function parsePax(data) {
  const out = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const len = parseInt(data.subarray(at, space).toString('utf8'), 10);
    if (!Number.isFinite(len) || len <= 0 || space === -1) throw new Error('Corrupt tar pax header');
    const record = data.subarray(space + 1, at + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    at += len;
  }
  return out;
}

/**
 * Streams a gunzipped POSIX ustar/pax/GNU tar, yielding `{ name, type, data }`
 * for every entry `wants(name)` accepts (`data` is the file body only for
 * regular files). Entries it doesn't want are skipped without buffering, so a
 * large repo archive costs memory only for the skill files kept.
 */
async function* readTar(source, wants) {
  let buf = Buffer.alloc(0);
  const iterator = source[Symbol.asyncIterator]();
  const fill = async need => {
    while (buf.length < need) {
      const { value, done } = await iterator.next();
      if (done) return false;
      buf = buf.length ? Buffer.concat([buf, value]) : value;
    }
    return true;
  };
  const take = async size => {
    if (!await fill(size)) throw new Error('Truncated tar archive');
    const out = buf.subarray(0, size);
    buf = buf.subarray(size);
    return out;
  };
  const skip = async size => {
    let left = size;
    while (left > 0) {
      if (!buf.length && !await fill(1)) throw new Error('Truncated tar archive');
      const n = Math.min(left, buf.length);
      buf = buf.subarray(n);
      left -= n;
    }
  };
  let pax = {};
  let longName = null;
  for (;;) {
    if (!await fill(BLOCK)) return;
    const header = await take(BLOCK);
    if (header.every(byte => byte === 0)) return;
    const size = parseOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;
    if (typeflag === 'x' || typeflag === 'g' || typeflag === 'L') {
      if (size > 1024 * 1024) throw new Error('Corrupt tar header: oversized metadata entry');
      const meta = await take(size);
      await skip(padding);
      if (typeflag === 'x') pax = parsePax(meta);
      else if (typeflag === 'L') longName = cString(meta, 0, meta.length);
      continue;
    }
    const prefix = cString(header, 345, 155);
    const base = cString(header, 0, 100);
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${base}` : base);
    const entrySize = pax.size !== undefined ? Number(pax.size) : size;
    if (!Number.isSafeInteger(entrySize) || entrySize < 0) throw new Error('Corrupt tar header: bad pax size');
    pax = {};
    longName = null;
    const type = typeflag === '0' ? 'file' : typeflag === '5' ? 'directory' : typeflag === '2' ? 'symlink' : typeflag === '1' ? 'hardlink' : 'special';
    const entryPadding = (BLOCK - (entrySize % BLOCK)) % BLOCK;
    if (!wants(name, type)) {
      await skip(type === 'file' || type === 'special' ? entrySize + entryPadding : 0);
      continue;
    }
    let data = null;
    if (type === 'file') {
      if (entrySize > MAX_SKILL_FILE_BYTES) throw new Error(`Refusing oversized skill file ${name}`);
      data = Buffer.from(await take(entrySize));
      await skip(entryPadding);
    }
    yield { name, type, data };
  }
}

async function downloadVerified(pack, fetchImpl, destination) {
  const url = `https://codeload.github.com/${pack.source}/tar.gz/${pack.revision}`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download of ${pack.source}@${pack.revision.slice(0, 7)} failed (HTTP ${response.status})`);
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE_BYTES) return cb(new Error('Skill archive exceeds the size limit'));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(destination));
  const actual = hash.digest('hex');
  if (actual !== pack.sha256) throw new Error(`SHA-256 mismatch for ${pack.source}@${pack.revision.slice(0, 7)}: expected ${pack.sha256}, got ${actual}`);
}

function assertSafeEntryName(name) {
  const segments = name.split(/[\\/]/);
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\\') || segments.includes('..')) {
    throw new Error(`Refusing unsafe archive path: ${name}`);
  }
}

async function extractSkills(pack, archivePath, stageDir) {
  const wanted = new Set(pack.skills);
  const marker = `/${pack.skillsPath}/`;
  // codeload nests everything under "<repo>-<revision>/".
  const locate = name => {
    const at = name.indexOf(marker);
    if (at <= 0 || name.indexOf('/') !== at) return null;
    const [skill, ...rest] = name.slice(at + marker.length).split('/');
    return wanted.has(skill) ? { skill, rel: rest.join('/') } : null;
  };
  const file = createReadStream(archivePath);
  const source = createGunzip();
  file.on('error', error => source.destroy(error));
  file.pipe(source);
  const gunzipFailure = new Promise((_, reject) => source.on('error', reject));
  gunzipFailure.catch(() => {});
  const extract = async () => {
    for await (const entry of readTar(source, name => { assertSafeEntryName(name); return locate(name) !== null; })) {
      const { skill, rel } = locate(entry.name);
      if (entry.type === 'directory') continue;
      if (entry.type !== 'file') throw new Error(`Refusing ${entry.type} entry in skill archive: ${entry.name}`);
      if (!rel) continue;
      const target = join(stageDir, skill, rel);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, entry.data);
    }
  };
  try {
    await Promise.race([extract(), gunzipFailure]);
  } finally {
    // readTar stops at the end-of-archive marker, so release the handles explicitly before the temp dir is removed.
    file.destroy();
    source.destroy();
  }
  for (const skill of pack.skills) {
    const info = await stat(join(stageDir, skill, 'SKILL.md')).catch(() => null);
    if (!info?.isFile() || info.size === 0) throw new Error(`${skill} has no non-empty SKILL.md in ${pack.source}@${pack.revision.slice(0, 7)}`);
  }
}

async function replaceDir(stagedDir, targetDir) {
  const parent = dirname(targetDir);
  await mkdir(parent, { recursive: true });
  const incoming = `${targetDir}.incoming-${process.pid}`;
  await rm(incoming, { recursive: true, force: true });
  await cp(stagedDir, incoming, { recursive: true });
  await rm(targetDir, { recursive: true, force: true });
  await rename(incoming, targetDir);
}

/**
 * Installs one pack's skill folders user-wide from its pinned GitHub archive,
 * using Node built-ins only. The tarball's SHA-256 is verified before anything
 * is extracted; extraction refuses traversal, absolute paths, links and special
 * entries inside the requested skill folders and stages into a temp directory,
 * and each folder is only moved into `~/.agents/skills` and `~/.claude/skills`
 * once every requested skill has a non-empty SKILL.md.
 */
export async function installMotionSkillPack(pack, { home = homedir(), fetchImpl = fetch } = {}) {
  const work = await mkdtemp(join(tmpdir(), 'portos-motion-skills-'));
  try {
    const archivePath = join(work, 'archive.tar.gz');
    const stageDir = join(work, 'stage');
    await mkdir(stageDir);
    await downloadVerified(pack, fetchImpl, archivePath);
    await extractSkills(pack, archivePath, stageDir);
    for (const dir of motionSkillDirs(home)) {
      for (const skill of pack.skills) await replaceDir(join(stageDir, skill), join(dir, skill));
    }
    return { id: pack.id, skills: [...pack.skills] };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
