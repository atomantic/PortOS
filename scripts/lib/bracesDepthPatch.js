/** Install-time mitigation for GHSA-vfj7-8cjw-p6xm (#9906).
 * PM2 still requires chokidar 3.6.0 / braces 3.0.3. Keep that API and refuse
 * excessive parser/AST recursion instead. Never edit an unfamiliar release.
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export const BRACES_PATCH_TARGET_VERSION = '3.0.3';
export const BRACES_MAX_DEPTH = 64;
const MARKER = '// portos #9906 depth guard';
const guard = `${MARKER}\n    if (depth > ${BRACES_MAX_DEPTH}) throw Object.assign(new RangeError('Brace nesting exceeds safe depth'), { code: 'EBRACESDEPTH' });`;
const digest = source => createHash('sha256').update(source).digest('hex');

// Verify complete upstream files, not merely an anchor that another release
// could retain while changing the recursion around it.
const FILES = {
  'parse.js': {
    hash: 'e572166565f15fa6ad9865ae49d678218e32aabfd1b3720f6d0d43d39800d310',
    changes: [['      stack.push(block);', `      ${MARKER}\n      if (stack.length > ${BRACES_MAX_DEPTH}) throw Object.assign(new RangeError('Brace nesting exceeds safe depth'), { code: 'EBRACESDEPTH' });\n      stack.push(block);`]],
  },
  'compile.js': {
    hash: 'dc98f22eee3d511785d92a00758d5f0d48efed5f5813bdecc2de430c529b5c9f',
    changes: [
      ['const walk = (node, parent = {}) => {', `const walk = (node, parent = {}, depth = 0) => {\n    ${guard}`],
      ['walk(child, node)', 'walk(child, node, depth + 1)'],
    ],
  },
  'expand.js': {
    hash: '41ccc196ebfa7b7781a634e721eb744e4e7bcb54cba427a7e3d6806a1b9e58f7',
    changes: [
      ['const walk = (node, parent = {}) => {', `const walk = (node, parent = {}, depth = 0) => {\n    ${guard}`],
      ['walk(child, node)', 'walk(child, node, depth + 1)'],
      ["const append = (queue = '', stash = '', enclose = false) => {", `const append = (queue = '', stash = '', enclose = false, depth = 0) => {\n    ${guard}`],
      ['append(value, stash, enclose)', 'append(value, stash, enclose, depth + 1)'],
      ['append(item, ele, enclose)', 'append(item, ele, enclose, depth + 1)'],
    ],
  },
  'stringify.js': {
    hash: '379f22d77bfa1478341ccd49c5e4267464aabcbba03558bab332aac23fc6f23a',
    changes: [
      ['const stringify = (node, parent = {}) => {', `const stringify = (node, parent = {}, depth = 0) => {\n    ${guard}`],
      ['stringify(child)', 'stringify(child, {}, depth + 1)'],
    ],
  },
  'utils.js': {
    hash: 'b5a7596aa67730412b3c029ef09e84e6b67b8e445cffd35d1d295549c89066c7',
    changes: [
      ['const flat = arr => {', `const flat = (arr, depth = 0) => {\n    ${guard}`],
      ['flat(ele)', 'flat(ele, depth + 1)'],
    ],
  },
};

export const bracesPatchFingerprint = () => digest(JSON.stringify({
  version: BRACES_PATCH_TARGET_VERSION, files: FILES,
})).slice(0, 16);

/** Patch the lockfile's hoisted braces install. Throws on unexpected code or
 * I/O failure: unlike the FTP compatibility patch, this is a security guard.
 * Both shipped PM2 lockfiles pin this location and version in the parity test.
 * All files are validated before any write. A partial write is repairable on
 * the next attempt because each file accepts pristine OR exact patched bytes.
 */
export function applyBracesDepthPatch(nodeModulesDir) {
  const dir = join(nodeModulesDir, 'braces');
  if (!existsSync(dir)) return 'absent';
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (manifest.version !== BRACES_PATCH_TARGET_VERSION) {
    throw new Error(`Unrecognized braces release for depth patch: ${manifest.version}`);
  }
  const files = Object.entries(FILES).map(([name, { hash, changes }]) => {
    const path = join(dir, 'lib', name);
    const installed = readFileSync(path, 'utf8');
    const original = changes.reduce((source, [before, after]) => source.replaceAll(after, before), installed);
    if (digest(original) !== hash) throw new Error(`Unrecognized braces ${name} for depth patch`);
    const patched = changes.reduce((source, [before, after]) => source.replaceAll(before, after), original);
    return { path, installed, patched };
  });
  let changed = false;
  for (const { path, installed, patched } of files) {
    if (installed === patched) continue;
    writeFileSync(path, patched);
    changed = true;
  }
  return changed ? 'patched' : 'already-patched';
}
