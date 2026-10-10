#!/usr/bin/env node

// Guards the release tag against drifting off the tree CI verified.
//
// `softprops/action-gh-release` creates a missing tag at the repository's
// default branch unless it is told otherwise, and ignores its target entirely
// when the tag already exists. release.yml therefore pins `target_commitish` to
// the triggering SHA for the missing-tag case, and runs this script for the
// other one: when `v<version>` already exists, it is peeled (annotated tags
// included) to its commit and that commit's TREE must equal the tree being
// released. A same-tree commit with a different SHA (a main merge parent) is
// fine; anything else — different tree, unexpected object type, or any lookup
// that cannot be answered — fails the release. This script only reads: it
// never creates, moves, or deletes a tag.
//
// Run again after publication with REQUIRE_TAG=true to prove the tag now exists
// on the verified tree (closes the window where something else created it
// between the first check and the release).

import { spawnSync } from 'child_process';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { writeStepOutput } from './lib/githubOutput.js';

const MAX_TAG_DEPTH = 5;

/**
 * Resolve an existing tag to its commit's tree and compare with `headTree`.
 *
 * @param {object} args
 * @param {string} args.tag full tag name, e.g. `v1.2.3`
 * @param {string|null} args.headTree tree SHA of the checked-out release commit
 * @param {(path: string) => {status: number, body: any}|null} args.api GET against
 *   `repos/<repo>/...`; null = the request could not be answered
 * @returns {{ok: boolean, exists: boolean, reason: string}}
 */
export function checkReleaseTag({ tag, headTree, api }) {
  const fail = (reason) => ({ ok: false, exists: true, reason });
  if (!headTree) return fail('the release commit tree could not be resolved');

  const ref = api(`git/ref/tags/${encodeURIComponent(tag)}`);
  if (!ref) return fail(`the lookup of tag ${tag} could not be answered`);
  if (ref.status === 404) return { ok: true, exists: false, reason: `tag ${tag} does not exist yet` };
  if (ref.status !== 200 || ref.body?.ref !== `refs/tags/${tag}`) {
    return fail(`the lookup of tag ${tag} returned an unusable answer (HTTP ${ref.status})`);
  }

  let object = ref.body.object;
  for (let depth = 0; depth < MAX_TAG_DEPTH; depth += 1) {
    if (!object?.sha || typeof object.type !== 'string') return fail(`tag ${tag} points at an unreadable object`);
    if (object.type === 'tag') {
      const tagObject = api(`git/tags/${object.sha}`);
      if (tagObject?.status !== 200) return fail(`annotated tag ${tag} could not be read`);
      object = tagObject.body?.object;
      continue;
    }
    if (object.type !== 'commit') return fail(`tag ${tag} points at a ${object.type}, not a commit`);
    const commit = api(`git/commits/${object.sha}`);
    const tagTree = commit?.status === 200 ? commit.body?.tree?.sha : null;
    if (!tagTree) return fail(`the commit behind tag ${tag} could not be read`);
    if (tagTree !== headTree) {
      return fail(`tag ${tag} points at tree ${tagTree.slice(0, 8)}, not the verified release tree ${headTree.slice(0, 8)}`);
    }
    return { ok: true, exists: true, reason: `tag ${tag} points at the verified release tree` };
  }
  return fail(`tag ${tag} is nested more than ${MAX_TAG_DEPTH} tag objects deep`);
}

// `gh api` exits non-zero on any HTTP error and names the status on stderr; a
// 404 is an answer ("no such tag"), everything else unparseable is not.
function ghApi(repo, path) {
  const result = spawnSync('gh', ['api', `repos/${repo}/${path}`], { encoding: 'utf8' });
  if (result.error) return null;
  if (result.status === 0) {
    try {
      return { status: 200, body: JSON.parse(result.stdout) };
    } catch {
      return null;
    }
  }
  return /HTTP 404/.test(result.stderr || '') ? { status: 404, body: null } : null;
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  const tag = process.env.RELEASE_TAG;
  const requireTag = process.env.REQUIRE_TAG === 'true';

  const treeResult = sha ? spawnSync('git', ['rev-parse', `${sha}^{tree}`], { encoding: 'utf8' }) : null;
  const headTree = treeResult?.status === 0 ? treeResult.stdout.trim() : null;

  const result = !repo || !tag
    ? { ok: false, exists: true, reason: 'missing repository or release tag name' }
    : checkReleaseTag({ tag, headTree, api: (path) => ghApi(repo, path) });
  const ok = result.ok && (result.exists || !requireTag);
  const reason = result.ok && !result.exists && requireTag
    ? `tag ${tag} was not found after publication`
    : result.reason;

  writeStepOutput('tag_exists', result.exists);
  if (!ok) {
    console.error(`❌ ${reason}`);
    console.log(`::error::release ${tag || ''} blocked: ${reason}`);
    process.exit(1);
  }
  console.log(`✅ ${reason}`);
}

if (isDirectlyInvoked(import.meta.url)) main();
