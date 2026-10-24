import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from './childProcess.js';
import { normalizePlannerId } from './dispatchLabels.js';
import { isNonBlankStr } from './textUtils.js';

const execFileAsync = promisify(execFile);

async function evidencePath(cwd) {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'portos-local-review-models'], { cwd });
  return stdout.trim();
}

/** New pre-publication phase; no configured roster is evidence of execution. */
export async function resetLocalReviewAttribution(cwd) {
  await writeFile(await evidencePath(cwd), '', { mode: 0o600 });
}

/** Persist only a public model slug after an actual validated code review. */
export async function recordLocalReviewAttribution(cwd, result) {
  if (result?.ok !== true || !['clean', 'findings'].includes(result.verdict)
      || typeof result.findings !== 'string' || !result.findings.trim()) return;
  // Model routing names are public attribution; file paths, URLs and account
  // tokens are not. Keep vendor/model IDs, but never slug a private path.
  const rawModel = result.model;
  if (!isNonBlankStr(rawModel) || /^(?:[\\/]|[a-z]:[\\/]|[a-z][a-z\d+.-]*:\/\/|provider:)/i.test(rawModel.trim())) return;
  const model = normalizePlannerId(rawModel);
  if (!model) return;
  const path = await evidencePath(cwd);
  // Require phase initialization; never silently reuse/create evidence for an
  // unrelated review. Atomic append keeps concurrent model receipts intact.
  await readFile(path, 'utf8');
  await appendFile(path, `${model}\n`);
}

export async function localReviewAttributionLabels(cwd) {
  const path = await evidencePath(cwd);
  const evidence = await readFile(path, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return [...new Set(evidence.split('\n').filter(Boolean).map(model => {
    if (normalizePlannerId(model) !== model) throw new Error('Invalid local review model evidence');
    return `reviewer:${model}`;
  }))];
}
