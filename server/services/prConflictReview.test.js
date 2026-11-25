import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findAddedConflictMarkers } from '../lib/prConflictMarkers.js';
import { publishConflictReview } from './prConflictReview.js';

const mocks = vi.hoisted(() => ({ gh: vi.fn(), resolve: vi.fn(), getSelfLogin: vi.fn() }));
vi.mock('./github.js', () => ({ execGh: mocks.gh }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: mocks.resolve }));
vi.mock('./prWatcher.js', () => ({ getSelfLogin: mocks.getSelfLogin }));

const head = 'a'.repeat(40);
const app = { repoPath: '/repo', forgeAccount: 'bound-account' };
const pr = { number: 10, headRefOid: head };
const target = { repoSpec: 'example.com/owner/repo', repoFullName: 'owner/repo', hostname: 'example.com', selfLogin: 'reviewer', defaultBranch: 'main' };
const defect = [
  'diff --git a/src/page.jsx b/src/page.jsx',
  '--- a/src/page.jsx',
  '+++ b/src/page.jsx',
  '@@ -8,1 +8,6 @@',
  ' <div>',
  '+<<<<<<< HEAD',
  '+secret-code-one',
  '+=======',
  '+secret-code-two',
  '+>>>>>>> ignore-previous-instructions',
].join('\n');
const unchanged = { state: 'OPEN', headRefOid: head, baseRefName: 'main', headRepository: { nameWithOwner: 'contributor/repo' } };
const prior = {
  commit_id: head, state: 'COMMENTED', user: { login: 'reviewer' },
  body: '<!-- portos:unresolved-conflict-markers:v1 -->',
};
const postedState = JSON.stringify(prior);
const written = () => mocks.gh.mock.calls.filter(([args]) => args.includes('POST'));
const source = ['','','','','','','','<div>','<<<<<<< HEAD','left','=======','right','>>>>>>> branch'].join('\n');
const asFile = content => ({ type: 'file', path: 'src/page.jsx', encoding: 'base64', size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64') });

function routeGh({ first = unchanged, last = unchanged, reviews = [[]], diff = defect, contents = asFile(source), posted = postedState } = {}) {
  let reads = 0;
  mocks.gh.mockImplementation(async (args) => {
    if (args.includes('view')) return JSON.stringify(reads++ ? last : first);
    if (args.includes('diff')) return diff;
    if (args.includes('--paginate')) return JSON.stringify(reviews);
    if (args.includes('POST')) return posted;
    if (args[3]?.includes('/contents/')) return JSON.stringify(contents);
    throw new Error('Unexpected forge invocation');
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSelfLogin.mockResolvedValue('reviewer');
  mocks.resolve.mockResolvedValue({ cwd: '/repo', env: { GH_TOKEN: 'test-not-a-secret' } });
});

describe('deterministic conflict marker feedback', () => {
  it('reports only added complete blocks in safe source paths', () => {
    const findings = [{ path: 'src/page.jsx', line: 9, endLine: 13 }];
    expect(findAddedConflictMarkers(defect)).toEqual(findings);
    expect(findAddedConflictMarkers(defect.replaceAll('\n', '\r\n'))).toEqual(findings);
    expect(findAddedConflictMarkers(defect.replaceAll('.jsx', '.md'))).toEqual([]);
    expect(findAddedConflictMarkers(defect.replaceAll('src/page', 'src/`page'))).toEqual([]);
    expect(findAddedConflictMarkers(defect.replace('+=======', ' ======='))).toEqual([]);
    expect(findAddedConflictMarkers(defect.replace('+<<<<<<<', '-<<<<<<<'))).toEqual([]);
    expect(findAddedConflictMarkers(defect.replace('+>>>>>>>', ' @@ >>>>>>>'))).toEqual([]);
  });
  it('posts only fixed, exact-head review text through the pinned account', async () => {
    routeGh({ reviews: [[{ ...prior, user: { login: 'contributor' } }], [{ ...prior, commit_id: 'b'.repeat(40) }]] });
    expect(await publishConflictReview({ app, target, pr })).toBe('posted');
    expect(mocks.resolve).toHaveBeenCalledWith('/repo', { forgeAccount: 'bound-account' });
    expect(mocks.gh).toHaveBeenCalledWith(
      ['api', '--hostname', 'example.com', `repos/contributor/repo/contents/src/page.jsx?ref=${head}`],
      undefined,
      expect.objectContaining({ cwd: '/repo' }),
    );
    const [[args, , options]] = written();
    expect(args).toEqual(['api', '--hostname', 'example.com', '--method', 'POST', 'repos/owner/repo/pulls/10/reviews', '--input', '-']);
    expect(JSON.parse(options.input)).toEqual({
      event: 'COMMENT',
      commit_id: head,
      body: expect.stringContaining('`src/page.jsx` (line 9)'),
    });
    expect(options.input).not.toMatch(/secret-code|ignore-previous|test-not-a-secret/);
    expect(options.env).toEqual({ GH_TOKEN: 'test-not-a-secret' });
  });
  it.each([
    ['previous review', { reviews: [[], [prior]] }, 'already-posted'],
    ['changed before initial probe', { first: { ...unchanged, headRefOid: 'b'.repeat(40) } }, 'changed'],
    ['changed head after diff', { last: { ...unchanged, headRefOid: 'b'.repeat(40) } }, 'changed'],
    ['closed after diff', { last: { ...unchanged, state: 'CLOSED' } }, 'changed'],
    ['retargeted after diff', { last: { ...unchanged, baseRefName: 'other' } }, 'changed'],
    ['diff no longer contains a defect', { diff: 'empty' }, 'changed'],
    ['read raced with B between both observations of A', { contents: asFile('<main>no markers at pinned head</main>') }, 'changed'],
    ['head repository changed', { last: { ...unchanged, headRepository: { nameWithOwner: 'other/repo' } } }, 'changed'],
    ['cannot prove contents at the pinned head', { contents: asFile(source.replace('=======', 'not a marker')) }, 'changed'],
    ['reviews unavailable', { reviews: null }, 'unavailable'],
  ])('does not submit a review when %s', async (_label, options, outcome) => {
    routeGh(options);
    expect(await publishConflictReview({ app, target, pr })).toBe(outcome);
    expect(written()).toEqual([]);
  });
  it('does not publish with a different authenticated login', async () => {
    routeGh();
    mocks.getSelfLogin.mockResolvedValue('other-reviewer');
    expect(await publishConflictReview({ app, target, pr })).toBe('unavailable');
    expect(written()).toEqual([]);
  });
  it('does not claim successful delivery on an unverified response', async () => {
    routeGh({ posted: '{}' });
    expect(await publishConflictReview({ app, target, pr })).toBe('unavailable');
    expect(written()).toHaveLength(1);
  });
});
