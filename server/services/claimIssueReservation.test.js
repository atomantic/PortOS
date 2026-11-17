/**
 * Claim reservations read from each tracker's real JSON shape (#16625): merged
 * retirement holds a merged-by-ancestry `/do:next` branch while its issue is
 * reserved, so a closed issue must read as released on GitHub and GitLab alike,
 * and anything unreadable must stay unknown. Each case resolves the tracker
 * from a real repository's `origin` URL, GitLab subgroups included.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';

const forge = vi.hoisted(() => ({ gh: null, glab: null, calls: [] }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async (cwd, opts) => ({ cwd, env: { GH_TOKEN: 'synthetic' }, opts }) }));
vi.mock('./github.js', () => ({ execGh: async (args, _timeout, exec) => { forge.calls.push(['gh', args, exec]); return forge.gh; } }));
vi.mock('./gitlab.js', () => ({ execGlab: async (args, cwd) => { forge.calls.push(['glab', args, cwd]); return forge.glab; } }));

const { readRepoClaimIssueReservation } = await import('./claimIssueReservation.js');

let scratch;
const repos = {};
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'portos-claim-reservation-'));
  const origins = {
    github: 'git@github.com:example/app.git',
    gitlab: 'git@gitlab.com:example/app.git',
    subgroup: 'git@gitlab.com:example/platform/app.git',
    other: 'https://git.example.com/example/app.git',
  };
  for (const [name, url] of Object.entries(origins)) {
    repos[name] = join(scratch, name);
    await mkdir(repos[name]);
    await execGit(['init', '-q'], repos[name]);
    await execGit(['remote', 'add', 'origin', url], repos[name]);
  }
});
afterAll(() => rm(scratch, { recursive: true, force: true }));
beforeEach(() => Object.assign(forge, { gh: null, glab: null, calls: [] }));

describe('readRepoClaimIssueReservation', () => {
  it.each([
    ['closed', { state: 'CLOSED', labels: [], assignees: [{ login: 'someone' }] }, false],
    ['open and unclaimed', { state: 'OPEN', labels: [{ name: 'bug' }], assignees: [] }, false],
    ['open and assigned', { state: 'OPEN', labels: [], assignees: [{ login: 'someone' }] }, true],
    ['open and labelled in progress', { state: 'OPEN', labels: [{ name: 'in-progress' }], assignees: [] }, true],
    ['malformed', { state: 'OPEN' }, null],
  ])('reads a GitHub issue that is %s', async (_name, view, expected) => {
    forge.gh = JSON.stringify(view);
    expect(await readRepoClaimIssueReservation(repos.github, 7, { forgeAccount: 'pinned' })).toBe(expected);
    expect(forge.calls).toEqual([['gh', ['issue', 'view', '7', '--repo', 'github.com/example/app', '--json', 'state,labels,assignees'], expect.objectContaining({ cwd: repos.github })]]);
  });

  it.each([
    ['closed', { iid: 7, state: 'closed', labels: ['in-progress'], assignees: [{ username: 'someone' }] }, false],
    ['open and unclaimed', { iid: 7, state: 'opened', labels: ['bug'], assignees: [] }, false],
    ['open and assigned', { iid: 7, state: 'opened', labels: [], assignees: [{ username: 'someone' }] }, true],
    ['open and labelled in progress', { iid: 7, state: 'opened', labels: ['in-progress'], assignees: [] }, true],
    ['another issue', { iid: 8, state: 'closed', labels: [], assignees: [] }, null],
    ['in an unknown state', { iid: 7, state: 'locked', labels: [], assignees: [] }, null],
  ])('reads a GitLab issue that is %s through glab in the repository', async (_name, view, expected) => {
    forge.glab = JSON.stringify(view);
    expect(await readRepoClaimIssueReservation(repos.gitlab, 7)).toBe(expected);
    expect(forge.calls).toEqual([['glab', ['issue', 'view', '7', '--output', 'json'], repos.gitlab]]);
  });

  // The two-segment origin parse names no host for a subgroup project, which
  // left its reservation unreadable and the merged branch held for good.
  it('reads a GitLab subgroup project\'s issue through glab', async () => {
    forge.glab = JSON.stringify({ iid: 7, state: 'closed', labels: [], assignees: [] });
    expect(await readRepoClaimIssueReservation(repos.subgroup, 7)).toBe(false);
    expect(forge.calls).toEqual([['glab', ['issue', 'view', '7', '--output', 'json'], repos.subgroup]]);
  });

  it('reads unknown when the CLI fails or the origin names no tracker', async () => {
    expect(await readRepoClaimIssueReservation(repos.gitlab, 7)).toBeNull();
    expect(await readRepoClaimIssueReservation(repos.github, 7)).toBeNull();
    forge.calls = [];
    expect(await readRepoClaimIssueReservation(repos.other, 7)).toBeNull();
    expect(forge.calls).toEqual([]);
  });
});
