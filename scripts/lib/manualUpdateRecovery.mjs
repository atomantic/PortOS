import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { assertNotRealDataWrite } from '../../server/lib/testDataIsolation.js';

const validId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const workspaces = new Set(['.', 'client', 'server', 'autofixer']);
const head = root => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10000 }).trim();
const requestPath = (directory, id) => {
  if (!validId(id)) throw new Error('Invalid manual update attempt');
  return join(directory, `update-manual-${id}.json`);
};

/** Give an already-running older UI an explicit confirmation without a new API. */
export async function offerManualUpdateRecovery({ root, directory, id, env = process.env }) {
  const path = requestPath(directory, id);
  const dist = join(root, 'client', 'dist');
  if (!(await stat(join(dist, 'index.html'))).isFile()) return null;
  const page = await readFile(new URL('../manual-update-recovery.html', import.meta.url), 'utf8');
  const request = { id, sourceRoot: await realpath(root), sourceHead: head(root),
    forceCleanWorkspaces: [...new Set((env.PORTOS_FORCE_CLEAN_WORKSPACES || '').split(',').filter(value => workspaces.has(value)))],
    acknowledgePersistentMindImageBackup: env.PORTOS_UPDATE_IMAGE_BACKUP_ACKNOWLEDGED === '1' };
  assertNotRealDataWrite(path);
  await writeFile(path, JSON.stringify(request) + '\n', { flag: 'wx', mode: 0o600 });
  // This asset is deliberately generic: dist files are served before auth.
  // Machine paths and the original acknowledgments stay in the private request.
  await writeFile(join(dist, 'manual-update.html'), page);
  return `/manual-update.html?attempt=${id}`;
}

/** Called only by the fixed command behind the authenticated confirmation page. */
export async function continueManualUpdateRecovery({ id, root, directory, launch, emit = () => {} }) {
  const request = JSON.parse(await readFile(requestPath(directory, id), 'utf8'));
  if (request.id !== id || typeof request.sourceRoot !== 'string' || !/^[a-f0-9]{40}$/.test(request.sourceHead)
    || !Array.isArray(request.forceCleanWorkspaces) || request.forceCleanWorkspaces.some(value => !workspaces.has(value))
    || typeof request.acknowledgePersistentMindImageBackup !== 'boolean') throw new Error('Invalid manual update request');
  if (await realpath(root) !== request.sourceRoot) throw new Error('This confirmation belongs to a different PortOS checkout. Return to the original instance.');
  const result = JSON.parse(await readFile(join(directory, 'update-result.json'), 'utf8'));
  const refusal = JSON.parse(await readFile(join(directory, `update-refusal-${id}.json`), 'utf8'));
  if (result.id !== id || result.success !== false || refusal.id !== id || refusal.code !== 'UPDATE_INTERRUPTION_REQUIRED')
    throw new Error('A newer update attempt replaced this confirmation. Return to PortOS and try again.');
  if (head(root) !== request.sourceHead) throw new Error('The checkout changed. Return to PortOS and request the update again.');
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const run = launch ?? (await import('../../server/services/updateExecutor.js')).launchUpdate;
  const update = await run(`v${version}`, emit, { acknowledgeInterruption: true, expectedRefusalId: id,
    forceCleanWorkspaces: request.forceCleanWorkspaces,
    acknowledgePersistentMindImageBackup: request.acknowledgePersistentMindImageBackup });
  if (!update.started) throw new Error(update.result?.errorMessage || 'The update launcher refused this request.');
  return update;
}
