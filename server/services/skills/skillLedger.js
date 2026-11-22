/**
 * Skill mutation ledger: an append-only JSONL audit of every local skill file change with SHA-256 content-addressed blobs, size-capped compaction and single-entry rollback.
 *
 * Storage: `file-primary` under `data/skills/` — `.curator_ledger.jsonl` (one
 * entry per mutation) and `.ledger_blobs/<sha256>` (deduplicated file bytes).
 * Machine-local, backed up with `data/skills/`, never federated. Dot-paths,
 * so skill discovery never walks them.
 *
 * An entry is `{ id, at, actor, action, skill: { id, name, path }, before,
 * after }` where `before`/`after` are manifests `[{ path, sha256, bytes }]`
 * relative to `data/skills/` (an archived skill's paths start `.archive/`), or
 * `null` when the skill did not exist on that side. Rolling back an entry
 * restores exactly the files that entry touched: every `before` file comes
 * back from its blob and every file only in `after` is removed, so unrelated
 * skills are never reverted.
 *
 * Callers own serialization: every function that writes skill files runs
 * under the skill service's single write tail.
 */

import { randomUUID } from 'crypto';
import { lstat, readdir, readFile, realpath, rmdir, stat } from 'fs/promises';
import { dirname, join, posix } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { isPathAtOrInsideDir } from '../../lib/pathContainment.js';
import {
  appendJSONLine, atomicWrite, HOUR, PATHS, readJSONLFile, sha256Text, unlinkGuarded, writeJSONLines,
} from '../../lib/fileUtils.js';

export const LEDGER_FILE = '.curator_ledger.jsonl';
export const LEDGER_BLOB_DIR = '.ledger_blobs';
export const ARCHIVE_DIR = '.archive';
// A blob written for an entry not yet appended must survive a concurrent sweep.
const BLOB_SWEEP_GRACE_MS = HOUR;
const MAX_MANIFEST_FILES = 500;
const SHA256_RE = /^[0-9a-f]{64}$/;

const skillsRoot = () => join(PATHS.data, 'skills');
const ledgerPath = () => join(skillsRoot(), LEDGER_FILE);
const blobPath = (sha) => join(skillsRoot(), LEDGER_BLOB_DIR, sha);

const fail = (code, message, status = 400) => {
  throw new ServerError(message, { status, code });
};

/**
 * A ledger path is relative to `data/skills/`, posix, with no empty/`.`/`..`
 * segment, and never names the ledger's own files or the usage store. Only
 * `.archive/` may start with a dot.
 */
export function parseLedgerPath(relPath) {
  if (typeof relPath !== 'string' || !relPath || relPath.length > 600) return null;
  if (relPath.includes('\0') || relPath.includes('\\') || posix.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) return null;
  const segments = relPath.split('/');
  if (segments.length < 2 || segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  if (segments[0].startsWith('.') && segments[0] !== ARCHIVE_DIR) return null;
  return segments;
}

/**
 * Resolve a ledger path to an absolute target, refusing any symlink between
 * the (canonical) skills root and the target: the deepest existing ancestor's
 * realpath must equal its lexical path.
 */
async function jailLedgerPath(root, relPath) {
  const segments = parseLedgerPath(relPath);
  if (!segments) fail('SKILL_LEDGER_PATH_INVALID', `Ledger path is not a valid skill file path: ${String(relPath).slice(0, 80)}`);
  const target = join(root, ...segments);
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const candidate = join(root, ...segments.slice(0, depth));
    const real = await realpath(candidate).catch(() => null);
    if (real === null) continue;
    if (real !== candidate) fail('SKILL_PATH_ESCAPE', 'Skill file paths may not pass through a symlink', 403);
    break;
  }
  return target;
}

/** Every regular file under a skill directory (symlinks skipped), as root-relative posix paths. */
async function listSkillFiles(root, relDir) {
  const files = [];
  const walk = async (dir, segments) => {
    const entries = (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= MAX_MANIFEST_FILES) fail('SKILL_LEDGER_TOO_MANY_FILES', `A skill holds more than ${MAX_MANIFEST_FILES} files; the ledger cannot snapshot it`, 413);
      const next = [...segments, entry.name];
      if (entry.isDirectory()) await walk(join(dir, entry.name), next);
      else if (entry.isFile()) files.push(next.join('/'));
    }
  };
  await walk(join(root, ...relDir.split('/')), relDir.split('/'));
  return files;
}

async function storeBlob(buffer) {
  const sha = sha256Text(buffer);
  const existing = await stat(blobPath(sha)).catch(() => null);
  if (!existing || existing.size !== buffer.length) await atomicWrite(blobPath(sha), buffer);
  return sha;
}

async function snapshotPaths(root, relPaths) {
  const manifest = [];
  for (const relPath of relPaths) {
    const target = await jailLedgerPath(root, relPath);
    const stats = await lstat(target).catch(() => null);
    if (!stats?.isFile()) continue;
    const buffer = await readFile(target);
    manifest.push({ path: relPath, sha256: await storeBlob(buffer), bytes: buffer.length });
  }
  return manifest;
}

/**
 * Snapshot a whole skill directory (relative to `data/skills/`) into blobs.
 * Throws on any read/write failure so a caller can refuse the mutation.
 *
 * @returns {Promise<Array<{ path: string, sha256: string, bytes: number }>|null>} null when the directory has no files
 */
export async function captureSkillDir(relDir) {
  const root = await realpath(skillsRoot()).catch(() => null);
  if (!root) return null;
  const manifest = await snapshotPaths(root, await listSkillFiles(root, relDir));
  return manifest.length ? manifest : null;
}

const manifestKey = (manifest) => (manifest || []).map((file) => `${file.path}\0${file.sha256}`).sort().join('\n');

/** True when an entry changed nothing (identical before/after manifests). */
export const isNoopEntry = (entry) => manifestKey(entry.before) === manifestKey(entry.after);

const referencedBlobs = (entries) => {
  const shas = new Map();
  for (const entry of entries) {
    for (const file of [...(entry.before || []), ...(entry.after || [])]) shas.set(file.sha256, file.bytes || 0);
  }
  return shas;
};

const entryBytes = (entry) => Buffer.byteLength(JSON.stringify(entry)) + 1;

const totalBytes = (entries) => {
  let bytes = 0;
  for (const entry of entries) bytes += entryBytes(entry);
  for (const size of referencedBlobs(entries).values()) bytes += size;
  return bytes;
};

async function sweepBlobs(keep, now) {
  const dir = join(skillsRoot(), LEDGER_BLOB_DIR);
  const names = await readdir(dir).catch(() => []);
  let swept = 0;
  for (const name of names) {
    if (keep.has(name)) continue;
    const stats = await lstat(join(dir, name)).catch(() => null);
    if (!stats?.isFile() || now - stats.mtimeMs < BLOB_SWEEP_GRACE_MS) continue;
    await unlinkGuarded(join(dir, name)).catch(() => {});
    swept += 1;
  }
  return swept;
}

/**
 * Keep the ledger (entry lines plus the blobs they reference) under `maxBytes`:
 * drop no-op entries first, then the oldest entries, always keeping the newest
 * one; then sweep blobs no remaining entry references and older than an hour.
 */
export async function compactLedger({ maxBytes, now = Date.now() } = {}) {
  const entries = await readLedgerEntries();
  let kept = entries;
  if (totalBytes(kept) > maxBytes) {
    const newest = kept[kept.length - 1];
    kept = kept.filter((entry) => entry === newest || !isNoopEntry(entry));
    // Recomputed per drop: a dropped entry frees its blobs only when no
    // remaining entry shares them.
    while (kept.length > 1 && totalBytes(kept) > maxBytes) kept = kept.slice(1);
  }
  if (kept.length !== entries.length) await writeJSONLines(ledgerPath(), kept);
  const swept = await sweepBlobs(new Set(referencedBlobs(kept).keys()), now);
  const dropped = entries.length - kept.length;
  if (dropped || swept) console.log(`📚 Skill ledger compacted: dropped ${dropped} entries, swept ${swept} blobs`);
  return { dropped, swept, entries: kept.length };
}

/** Every well-formed entry, oldest first. Malformed lines are skipped. */
export async function readLedgerEntries() {
  const entries = await readJSONLFile(ledgerPath());
  return entries.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.action === 'string');
}

/**
 * Append one mutation entry and compact when the ledger outgrows `maxBytes`.
 * The blobs its manifests name must already be stored (`captureSkillDir`).
 */
export async function appendLedgerEntry({ actor, action, skill, before = null, after = null, ...extra }, { maxBytes, now = new Date() } = {}) {
  const entry = {
    id: randomUUID(),
    at: now.toISOString(),
    actor,
    action,
    skill: { id: skill.id, name: skill.name, path: skill.path },
    before,
    after,
    ...extra,
  };
  await appendJSONLine(ledgerPath(), entry);
  if (maxBytes) await compactLedger({ maxBytes, now: now.getTime() });
  return entry;
}

const summarizeManifest = (manifest) => (manifest ? { files: manifest.length, bytes: manifest.reduce((sum, file) => sum + (file.bytes || 0), 0), paths: manifest.map((file) => file.path) } : null);

/** Newest-first entries for the UI, manifests summarized, optionally for one skill path or id. */
export async function listLedger({ limit = 100, skill } = {}) {
  const entries = await readLedgerEntries();
  const matches = skill ? entries.filter((entry) => entry.skill?.id === skill || entry.skill?.path === skill || entry.skill?.name === skill) : entries;
  return matches.slice(-limit).reverse().map((entry) => ({
    ...entry,
    before: summarizeManifest(entry.before),
    after: summarizeManifest(entry.after),
  }));
}

async function readVerifiedBlob(file) {
  if (!SHA256_RE.test(file.sha256 || '')) fail('SKILL_LEDGER_BLOB_MISSING', `Ledger entry names an invalid blob for ${file.path}`, 409);
  const buffer = await readFile(blobPath(file.sha256)).catch(() => null);
  if (!buffer || sha256Text(buffer) !== file.sha256) {
    fail('SKILL_LEDGER_BLOB_MISSING', `The stored copy of ${file.path} is missing or damaged, so this entry cannot be rolled back`, 409);
  }
  return buffer;
}

async function removeEmptyDirs(root, relPath) {
  let dir = dirname(join(root, ...relPath.split('/')));
  while (dir !== root && isPathAtOrInsideDir(root, dir)) {
    const removed = await rmdir(dir).then(() => true, () => false);
    if (!removed) return;
    dir = dirname(dir);
  }
}

/**
 * Roll back one entry. Before touching a file it verifies every blob it
 * needs, snapshots the current state of every touched path, and appends that
 * snapshot as a `rollback` entry (itself reversible); any failure there aborts
 * with nothing changed.
 *
 * @returns {Promise<{ entry: object, rolledBack: object, restored: string[], removed: string[] }>}
 */
export async function rollbackLedgerEntry(entryId, { actor = 'user', maxBytes, now = new Date() } = {}) {
  const entries = await readLedgerEntries();
  const target = entries.find((entry) => entry.id === entryId);
  if (!target) fail('SKILL_LEDGER_ENTRY_NOT_FOUND', 'Ledger entry not found', 404);
  const root = await realpath(skillsRoot()).catch(() => null);
  if (!root) fail('SKILL_NOT_FOUND', 'The local skills directory does not exist', 404);

  const before = target.before || [];
  const beforePaths = new Set(before.map((file) => file.path));
  const removals = (target.after || []).map((file) => file.path).filter((path) => !beforePaths.has(path));
  const touched = [...new Set([...beforePaths, ...removals])];
  for (const path of touched) await jailLedgerPath(root, path);

  const buffers = new Map();
  for (const file of before) buffers.set(file.path, await readVerifiedBlob(file));

  const current = await snapshotPaths(root, touched);
  const safety = await appendLedgerEntry({
    actor,
    action: 'rollback',
    skill: target.skill,
    before: current.length ? current : null,
    after: before.length ? before : null,
    rollbackOf: target.id,
  }, { maxBytes, now });

  const removed = [];
  for (const path of removals) {
    const absolute = await jailLedgerPath(root, path);
    if (await lstat(absolute).then((stats) => stats.isFile(), () => false)) {
      await unlinkGuarded(absolute);
      removed.push(path);
    }
    await removeEmptyDirs(root, path);
  }
  for (const file of before) {
    await atomicWrite(await jailLedgerPath(root, file.path), buffers.get(file.path));
  }
  console.log(`📚 Skill ledger rollback of ${target.action} ${target.skill?.id || ''}: restored ${before.length}, removed ${removed.length}`);
  return { entry: safety, rolledBack: { id: target.id, action: target.action, skill: target.skill }, restored: before.map((file) => file.path), removed };
}
