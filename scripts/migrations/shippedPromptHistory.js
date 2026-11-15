import { execFileSync } from 'child_process';
import { md5 } from './_lib.js';
import { PROMPT_HASH_SUBDIRS, readReferencePromptHashes, readShippedHashes } from './shippedPromptHashes.js';

const runGit = (args, cwd, encoding = 'utf8') =>
  execFileSync('git', args, {
    cwd,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

export const isShallowRepository = (repoRoot) => {
  try {
    return runGit(['rev-parse', '--is-shallow-repository'], repoRoot).trim() !== 'false';
  } catch {
    return true;
  }
};

// Both trees the shipped prompts have lived in: data.sample/ before the
// data.reference/ rename shipped the same bodies to the same data/ paths.
const HISTORY_ROOTS = ['data.reference/prompts', 'data.sample/prompts'];
const HISTORY_PATH = /^data\.(?:reference|sample)\/prompts\/([^/]+)\/([^/]+\.md)$/;

/** `{ key: [{ commit, body }] }`, newest first, for every body each prompt shipped with. */
export const historicalPromptBodies = (repoRoot, keys) => {
  const wanted = new Set(keys);
  const lines = runGit(
    [
      'log',
      '--format=%H',
      '--name-only',
      '--',
      ...PROMPT_HASH_SUBDIRS.flatMap((subdir) => HISTORY_ROOTS.map((root) => `${root}/${subdir}`)),
    ],
    repoRoot,
  ).split('\n');
  const objects = [];
  let commit = null;
  for (const line of lines) {
    if (/^[0-9a-f]{40}$/.test(line)) {
      commit = line;
      continue;
    }
    const match = commit && line.match(HISTORY_PATH);
    const key = match && `${match[1]}/${match[2]}`;
    if (key && wanted.has(key)) objects.push({ commit, path: line, key });
  }

  const histories = Object.fromEntries(keys.map((key) => [key, []]));
  if (!objects.length) return histories;
  const input = `${objects.map(({ commit: revision, path }) => `${revision}:${path}`).join('\n')}\n`;
  const blobs = execFileSync('git', ['cat-file', '--batch'], {
    cwd: repoRoot,
    input,
    encoding: null,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let offset = 0;
  for (const object of objects) {
    const newline = blobs.indexOf(10, offset);
    if (newline < 0) throw new Error('Malformed `git cat-file --batch` header');
    const header = blobs.subarray(offset, newline).toString('utf8');
    offset = newline + 1;
    if (header.endsWith(' missing')) continue;
    const size = Number(header.split(' ').at(-1));
    if (!Number.isInteger(size) || size < 0)
      throw new Error(`Malformed git object header: ${header}`);
    const body = blobs.subarray(offset, offset + size).toString('utf8');
    offset += size + 1;
    histories[object.key].push({ commit: object.commit, body });
  }
  return histories;
};

const historicalHashes = (repoRoot, keys) => Object.fromEntries(
  Object.entries(historicalPromptBodies(repoRoot, keys))
    .map(([key, versions]) => [key, versions.map(({ commit, body }) => ({ commit, hash: md5(body) }))]),
);

export const findUnacceptedPromptHistory = ({
  histories,
  accepted,
  current,
}) => {
  const stranded = [];
  for (const [file, versions] of Object.entries(histories)) {
    const covered = new Set([current[file], ...(accepted[file] || [])]);
    for (const version of versions) {
      if (!covered.has(version.hash)) {
        stranded.push({ file, hash: version.hash, commit: version.commit });
      }
    }
  }
  return stranded;
};

/** A numbered migration module (not a helper or test) this guard may load. */
export const isNumberedMigrationFile = (file) =>
  /^\d.*\.js$/.test(file) && !file.endsWith('.test.js');

/**
 * Whether a migration's source declares shipped prompt hashes. Only the frozen
 * pre-#16090 migrations may: a template edit now retires its hash into
 * shipped-hashes.json instead (`shippedPromptHashes.guard.test.js`).
 */
export const declaresPromptHashes = (source) =>
  source.includes('ACCEPTED_OLD_MD5') || source.includes('NEW_SHIPPED_MD5');

/**
 * Every body a managed prompt has shipped with in git history must be its
 * current body or a retired hash in shipped-hashes.json; one that is neither
 * strands every install still holding it (#3817, #12222).
 */
export const inspectShippedPromptHistory = async ({ repoRoot }) => {
  if (isShallowRepository(repoRoot))
    return { skipped: 'requires full git history', stranded: [] };

  const current = await readReferencePromptHashes(repoRoot);
  const table = await readShippedHashes(repoRoot);
  const accepted = Object.fromEntries(Object.entries(table).map(([key, entry]) => [key, entry.retired || []]));
  const histories = historicalHashes(repoRoot, Object.keys(current));
  return {
    skipped: null,
    stranded: findUnacceptedPromptHistory({ histories, accepted, current }),
  };
};
