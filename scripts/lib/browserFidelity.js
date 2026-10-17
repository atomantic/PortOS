import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BROWSER_FIDELITY_TESTS, BROWSER_FIDELITY_FILES, browserTestProfileArgs } from './browserTestProfiles.js';

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export function browserFidelityActor(repository) {
  if (!REPOSITORY.test(repository)) throw Error('Invalid fidelity repository.');
  return repository.split('/')[0].toLowerCase();
}
const SHA = /^[a-f0-9]{40}$/;
const digest = value => createHash('sha256').update(value).digest('hex');

// The gate has a scripts-only checkout. The exact tested tree binds renderer
// source; this digest binds the canonical selection and its completeness rule.
export function browserFidelityProfileDigest() {
  const source = readFileSync(new URL('./browserTestProfiles.js', import.meta.url), 'utf8').replace(/\r\n?/g, '\n');
  return digest(JSON.stringify({ version: 1, manifest: BROWSER_FIDELITY_TESTS,
    args: browserTestProfileArgs('fidelity'), source }));
}

export function browserFidelityContext(identity) {
  if (!REPOSITORY.test(identity.repository) || !Number.isSafeInteger(identity.pr) || identity.pr < 1
    || !['head', 'tree'].every(key => SHA.test(identity[key]))
    || !/^[a-f0-9]{64}$/.test(identity.profile)) throw Error('Invalid browser fidelity identity.');
  return `browser-fidelity/${digest(JSON.stringify({ repository: identity.repository, pr: identity.pr,
    head: identity.head, tree: identity.tree, profile: identity.profile }))}`;
}

export function needsBrowserFidelity(files) {
  if (!Array.isArray(files) || !files.every(file => typeof file === 'string')) throw Error('Invalid browser suite selection.');
  return files.some(file => BROWSER_FIDELITY_FILES.includes(file));
}

/** request uses repository-relative REST paths and never exposes raw API errors. */
export async function browserFidelityTarget(repository, pr, request, expected = {}) {
  if (!REPOSITORY.test(repository) || !Number.isSafeInteger(pr) || pr < 1) throw Error('Invalid fidelity repository or pull request.');
  const pull = await request(`repos/${repository}/pulls/${pr}`);
  const head = pull?.head?.sha, base = pull?.base?.sha, merge = pull?.merge_commit_sha;
  if (pull?.state !== 'open' || pull?.base?.repo?.full_name !== repository
    || ![head, base].every(value => SHA.test(value))) throw Error('Open same-repository PR identity unavailable.');
  const commit = await request(`repos/${repository}/git/commits/${head}`);
  const tree = commit?.tree?.sha;
  if (commit?.sha !== head || !SHA.test(tree)) throw Error('PR head tree is unavailable.');
  if (expected.head !== undefined && expected.head !== head) throw Error('CI run identity is stale for the current PR head.');
  return { repository, pr, head, base, merge: SHA.test(merge) ? merge : null, tree, profile: browserFidelityProfileDigest() };
}

export const browserReceiptDigest = receipt => digest(JSON.stringify(receipt));
