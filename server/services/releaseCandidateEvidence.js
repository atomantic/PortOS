import { execGit } from '../lib/execGit.js';

const SHA = /^[a-f0-9]{40}$/;
const refuse = message => { throw new Error(message); };
const requireSha = value => SHA.test(value || '') ? value : refuse('Invalid candidate commit or tree');

// Read only immutable object names. No fetch, checkout, tag mutation or commands
// taken from release/PR prose occur in the verification path.
export async function readReleaseCandidate(head, cwd) {
  const options = { env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' } };
  const git = async args => (await execGit(args, cwd, options)).stdout.trim();
  const pins = (await git(['log', '-1', '--format=%H', '--grep=^Release-Cut: ', head])).split('\n').filter(Boolean);
  if (pins.length !== 1) refuse('Expected exactly one recorded candidate cutoff');
  const pin = requireSha(pins[0]);
  const message = await git(['show', '-s', '--format=%B', pin]);
  const trailer = key => {
    const values = [...message.matchAll(new RegExp(`^${key}: (.+)$`, 'gm'))];
    if (values.length !== 1) refuse(`Candidate is missing a unique ${key} trailer`);
    return values[0][1];
  };
  const cutoff = requireSha(trailer('Release-Cut'));
  const releaseBase = requireSha(trailer('Release-Base'));
  const previousCommit = requireSha(trailer('Release-Previous-Commit'));
  const previousTag = trailer('Release-Previous-Tag');
  const parents = await git(['show', '-s', '--format=%P', pin]);
  if (parents !== cutoff) refuse('Candidate pin parent differs from its cutoff');
  const tree = async sha => requireSha(await git(['rev-parse', `${sha}^{tree}`]));
  if (await tree(pin) !== await tree(cutoff)) refuse('Candidate pin must be metadata only');
  for (const ancestor of [pin, releaseBase, previousCommit]) {
    const result = await execGit(['merge-base', '--is-ancestor', ancestor, head], cwd, { ...options, ignoreExitCode: true });
    if (result.exitCode !== 0) refuse('Candidate does not retain its recorded release ancestry');
  }
  const manifest = JSON.parse(await git(['show', `${head}:package.json`]));
  return { cutoff, pin, releaseBase, previousCommit, previousTag, version: manifest.version, tree: await tree(head) };
}
