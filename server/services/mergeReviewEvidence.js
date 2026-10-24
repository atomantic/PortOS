import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execGit } from '../lib/execGit.js';

// The worktree-private status the review phase writes: `REVIEW_STATUS=<verdict>`
// plus `REVIEW_HEAD=<sha>`, the commit its final round reviewed. status null =
// no file (no local reviewers ran); 'unreadable' covers an unreadable or empty file.
export async function readReviewEvidence(workspace) {
  const gitPath = await execGit(['rev-parse', '--git-path', 'portos-review-status'], workspace).catch(() => null);
  const relative = gitPath?.stdout?.trim();
  if (!relative) return { status: 'unreadable', head: null };
  const content = await readFile(resolve(workspace, relative), 'utf-8').catch((err) => (err.code === 'ENOENT' ? null : undefined));
  if (content === null) return { status: null, head: null };
  const values = (pattern) => [...String(content ?? '').matchAll(pattern)].map((m) => m[1].trim());
  const statuses = values(/^REVIEW_STATUS=(.*)$/gm);
  const heads = values(/^REVIEW_HEAD=(.*)$/gm);
  return {
    status: statuses.length === 1 ? statuses[0] : 'unreadable',
    head: heads.length === 1 ? heads[0].toLowerCase() : null,
  };
}
