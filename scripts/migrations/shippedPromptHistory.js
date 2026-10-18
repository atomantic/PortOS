import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { pathToFileURL } from 'url';

const hash = (body) =>
  createHash('md5')
    .update(body.replace(/\r\n/g, '\n').replace(/\r/g, '\n'))
    .digest('hex');

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

const historicalHashes = (repoRoot, files) => {
  const wanted = new Set(
    files.map((file) => `data.reference/prompts/stages/${file}`),
  );
  const lines = runGit(
    [
      'log',
      '--format=%H',
      '--name-only',
      '--',
      'data.reference/prompts/stages',
    ],
    repoRoot,
  ).split('\n');
  const objects = [];
  let commit = null;
  for (const line of lines) {
    if (/^[0-9a-f]{40}$/.test(line)) {
      commit = line;
    } else if (line && commit && wanted.has(line)) {
      objects.push({ commit, path: line });
    }
  }

  if (!objects.length) return {};
  const input = `${objects.map(({ commit: revision, path }) => `${revision}:${path}`).join('\n')}\n`;
  const blobs = execFileSync('git', ['cat-file', '--batch'], {
    cwd: repoRoot,
    input,
    encoding: null,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const histories = Object.fromEntries(files.map((file) => [file, []]));
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
    histories[object.path.split('/').at(-1)].push({
      commit: object.commit,
      hash: hash(body),
    });
  }
  return histories;
};

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

const migrationHashes = async (migrationsDir) => {
  const accepted = {};
  const files = (await readdir(migrationsDir))
    .filter((file) => /^\d.*\.js$/.test(file) && !file.endsWith('.test.js'))
    .sort();
  for (const file of files) {
    const sourcePath = join(migrationsDir, file);
    const source = await readFile(sourcePath, 'utf8');
    if (
      !source.includes('ACCEPTED_OLD_MD5') &&
      !source.includes('NEW_SHIPPED_MD5')
    )
      continue;
    const migration = await import(pathToFileURL(sourcePath).href);
    for (const [name, hashes] of Object.entries(
      migration.ACCEPTED_OLD_MD5 || {},
    )) {
      accepted[name] ||= [];
      accepted[name].push(...hashes);
    }
  }
  return { accepted };
};

export const inspectShippedPromptHistory = async ({
  repoRoot,
  migrationsDir,
  stageDir,
}) => {
  if (isShallowRepository(repoRoot))
    return { skipped: 'requires full git history', stranded: [] };

  const files = (await readdir(stageDir))
    .filter((file) => file.endsWith('.md'))
    .sort();
  const histories = historicalHashes(repoRoot, files);
  const { accepted } = await migrationHashes(migrationsDir);
  const current = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        hash(await readFile(join(stageDir, file), 'utf8')),
      ]),
    ),
  );
  return {
    skipped: null,
    stranded: findUnacceptedPromptHistory({ histories, accepted, current }),
  };
};
