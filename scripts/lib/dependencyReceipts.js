/** Pre-install dependency receipts shared by setup, startup repair and update. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dependencyWorkspaces } from './workspaceDependencies.js';

function readInput(dir, name) {
  try {
    return readFileSync(join(dir, name));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function dependencyHash(dir) {
  const manifest = readInput(dir, 'package.json');
  if (manifest === null) return null;
  // Preserve the v2 digest so older startup scripts still recognize receipts.
  const hash = createHash('sha256').update(manifest).update('\0');
  hash.update(readInput(dir, 'package-lock.json') ?? '<no-lockfile>');
  return `v2:${hash.digest('hex')}`;
}

export function npmConfigHash(dir) {
  const config = readInput(dir, '.npmrc');
  return config === null ? null : createHash('sha256').update(config).digest('hex');
}

const receiptPath = root => join(root, 'data', 'deps-hashes.json');
const isMap = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function readDependencyHashes(root) {
  try {
    const hashes = JSON.parse(readFileSync(receiptPath(root), 'utf8'));
    if (isMap(hashes)) return { ...hashes, npmrc: isMap(hashes.npmrc) ? hashes.npmrc : {} };
  } catch { /* Missing or unreadable receipts provide no install evidence. */ }
  return { npmrc: {} };
}

export function saveDependencyHashes(root, hashes) {
  const file = receiptPath(root);
  const temporary = `${file}.${process.pid}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(temporary, JSON.stringify(hashes, null, 2));
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function writeDependencyHashes(root) {
  // Project npm configuration is separate evidence, added without changing
  // the legacy root/client/server fields. Null records an absent .npmrc.
  const hashes = { npmrc: {} };
  for (const { dir, label } of dependencyWorkspaces(root)) {
    const hash = dependencyHash(dir);
    if (hash !== null) hashes[label] = hash;
    hashes.npmrc[label] = npmConfigHash(dir);
  }
  saveDependencyHashes(root, hashes);
  return hashes;
}
