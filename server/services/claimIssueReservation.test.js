/**
 * Claim reservations read from each tracker's real JSON shape (#16625): merged
 * retirement holds a merged-by-ancestry `/do:next` branch while its issue is
 * reserved, so a closed issue must read as released on GitHub and GitLab alike,
 * and anything unreadable must stay unknown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const forge = vi.hoisted(() => ({ origin: null, gh: null, glab: null, calls: [] }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: async () => forge.origin }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async (cwd, opts) => ({ cwd, env: { GH_TOKEN: 'synthetic' }, opts }) }));
vi.mock('./github.js', () => ({ execGh: async (args, _timeout, exec) => { forge.calls.push(['gh', args, exec]); return forge.gh; } }));
vi.mock('./gitlab.js', () => ({ execGlab: async (args, cwd) => { forge.calls.push(['glab', args, cwd]); return forge.glab; } }));

const { readRepoClaimIssueReservation } = await import('./claimIssueReservation.js');

const GITHUB = { hasOrigin: true, host: 'github.com', owner: 'example', repo: 'app', fullName: 'example/app' };
const GITLAB = { hasOrigin: true, host: 'gitlab.com', owner: 'example', repo: 'app', fullName: 'example/app' };

beforeEach(() => Object.assign(forge, { origin: null, gh: null, glab: null, calls: [] }));

describe('readRepoClaimIssueReservation', () => {
  it.each([
    ['closed', { state: 'CLOSED', labels: [], assignees: [{ login: 'someone' }] }, false],
    ['open and unclaimed', { state: 'OPEN', labels: [{ name: 'bug' }], assignees: [] }, false],
    ['open and assigned', { state: 'OPEN', labels: [], assignees: [{ login: 'someone' }] }, true],
    ['open and labelled in progress', { state: 'OPEN', labels: [{ name: 'in-progress' }], assignees: [] }, true],
    ['malformed', { state: 'OPEN' }, null],
  ])('reads a GitHub issue that is %s', async (_name, view, expected) => {
    forge.origin = GITHUB;
    forge.gh = JSON.stringify(view);
    expect(await readRepoClaimIssueReservation('/work/app', 7, { forgeAccount: 'pinned' })).toBe(expected);
    expect(forge.calls).toEqual([['gh', ['issue', 'view', '7', '--repo', 'github.com/example/app', '--json', 'state,labels,assignees'], expect.objectContaining({ cwd: '/work/app' })]]);
  });

  it.each([
    ['closed', { iid: 7, state: 'closed', labels: ['in-progress'], assignees: [{ username: 'someone' }] }, false],
    ['open and unclaimed', { iid: 7, state: 'opened', labels: ['bug'], assignees: [] }, false],
    ['open and assigned', { iid: 7, state: 'opened', labels: [], assignees: [{ username: 'someone' }] }, true],
    ['open and labelled in progress', { iid: 7, state: 'opened', labels: ['in-progress'], assignees: [] }, true],
    ['another issue', { iid: 8, state: 'closed', labels: [], assignees: [] }, null],
    ['in an unknown state', { iid: 7, state: 'locked', labels: [], assignees: [] }, null],
  ])('reads a GitLab issue that is %s through glab in the repository', async (_name, view, expected) => {
    forge.origin = GITLAB;
    forge.glab = JSON.stringify(view);
    expect(await readRepoClaimIssueReservation('/work/app', 7)).toBe(expected);
    expect(forge.calls).toEqual([['glab', ['issue', 'view', '7', '--output', 'json'], '/work/app']]);
  });

  it('reads unknown when the CLI fails or the origin names no tracker', async () => {
    forge.origin = GITLAB;
    expect(await readRepoClaimIssueReservation('/work/app', 7)).toBeNull();
    forge.origin = GITHUB;
    expect(await readRepoClaimIssueReservation('/work/app', 7)).toBeNull();
    forge.origin = { hasOrigin: true, host: 'git.example.com', owner: 'example', repo: 'app', fullName: 'example/app' };
    forge.calls = [];
    expect(await readRepoClaimIssueReservation('/work/app', 7)).toBeNull();
    expect(forge.calls).toEqual([]);
  });
});
