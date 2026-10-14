import { mkdir, readFile, realpath, stat } from 'fs/promises';
import { join, relative, resolve, isAbsolute } from 'path';
import { promisify } from 'util';
import { execFile } from '../lib/childProcess.js';

const exec = promisify(execFile);
const oid = value => {
  const hash = value.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash)) throw new Error('Invalid snapshot object');
  return hash;
};

// Runs only inside the scanner's owned supervisor/process group. Its IPC-loss
// and Stop cleanup cover Git preparation as well as the eventual provider.
export async function prepareSecurityScanSnapshot({ source, directory, paths, knowledgeBase }) {
  const root = await realpath(source);
  let repository = join(directory, 'repository');
  const empty = join(directory, 'empty');
  await mkdir(empty, { mode: 0o700 });
  // These overrides propagate to local upload-pack too. Never read global Git
  // config, inherit GIT_* routing, run templates/hooks, or fetch over a network.
  const config = {
    'core.hooksPath': empty, 'core.fsmonitor': 'false', 'core.symlinks': 'false',
    'core.autocrlf': 'false', 'gc.auto': '0', 'maintenance.auto': 'false',
    'protocol.allow': 'never', 'protocol.file.allow': 'always',
    'uploadpack.packObjectsHook': '', 'fetch.recurseSubmodules': 'false',
  };
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'TMPDIR', 'TEMP', 'TMP', 'PORTOS_SECURITY_SCAN_OWNER'].includes(key)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: String(Object.keys(config).length) });
  Object.entries(config).forEach(([key, value], i) => { env[`GIT_CONFIG_KEY_${i}`] = key; env[`GIT_CONFIG_VALUE_${i}`] = value; });
  const git = async (cwd, args) => (await exec('git', args, { cwd, env, maxBuffer: 16 * 1024 * 1024 })).stdout;
  const commit = oid(await git(root, ['rev-parse', '--verify', 'HEAD^{commit}']));
  const tree = oid(await git(root, ['rev-parse', '--verify', `${commit}^{tree}`]));
  await git(directory, ['init', '--template=', `--object-format=${commit.length === 64 ? 'sha256' : 'sha1'}`, repository]);
  repository = await realpath(repository);
  await git(repository, ['config', 'core.symlinks', 'false']);
  await git(repository, ['config', 'core.autocrlf', 'false']);
  await git(repository, ['fetch', '--no-tags', '--depth=1', '--no-recurse-submodules', '--no-write-fetch-head', root, commit]);
  if (oid(await git(repository, ['rev-parse', '--verify', `${commit}^{tree}`])) !== tree) throw new Error('Snapshot binding changed');
  await git(repository, ['checkout', '--detach', '--force', commit]);
  // No remote or alternates survive: every object needed by this shallow
  // revision is owned by the snapshot. Later live edits/commits cannot alter it.
  if (await readFile(join(repository, '.git/objects/info/alternates'), 'utf8').catch(() => '')) throw new Error('Shared snapshot objects');
  const entries = (await git(repository, ['ls-tree', '-rz', commit])).split('\0');
  const tracked = entries.filter(Boolean).map(line => line.slice(line.indexOf('\t') + 1));
  const submodules = entries.filter(line => line.startsWith('160000 ')).map(line => line.slice(line.indexOf('\t') + 1));
  const mapPaths = async (values, field) => Promise.all(values.map(async (path, index) => {
    const rel = relative(root, resolve(root, path));
    const invalid = code => Object.assign(new Error('Invalid committed scanner input'), { preflight: { field, index, code } });
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw invalid('outside-workspace');
    if (submodules.some(p => rel === p || rel.startsWith(`${p}/`))) throw invalid('submodule-excluded');
    if (rel && !tracked.some(p => p === rel || p.startsWith(`${rel}/`))) throw invalid('not-in-commit');
    const target = resolve(repository, rel);
    if (!(await stat(target).catch(() => null))) throw invalid('not-in-commit');
    const actual = await realpath(target);
    const mapped = relative(repository, actual);
    if (mapped === '..' || mapped.startsWith('../') || isAbsolute(mapped)) throw invalid('outside-workspace');
    return target;
  }));
  return { repository, paths: await mapPaths(paths, 'paths'), knowledgeBase: await mapPaths(knowledgeBase, 'knowledgeBase'),
    baseline: { kind: 'git-commit', commit, tree, uncommitted: 'excluded', submodules: 'excluded', symlinks: 'link-text' } };
}
