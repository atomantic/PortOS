import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ gh: vi.fn(), git: vi.fn(), options: vi.fn() }));
vi.mock('./github.js', () => ({ execGh: mock.gh }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: mock.options }));
vi.mock('../lib/execGit.js', () => ({ execGit: mock.git }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: async () => ({ host: 'github.com', fullName: 'example/repo' }) }));
import { readRetirementForgeEvidence } from './heldCheckoutReview.js';

describe('retirement forge verification', () => {
  const prUrl = 'https://github.com/example/repo/pull/42';
  let pr;
  let detail;
  let files;
  let commits;
  beforeEach(() => {
    vi.clearAllMocks();
    pr = { url: prUrl, state: 'MERGED', headRefName: 'claim/42', headRefOid: 'a'.repeat(40),
      mergeCommit: { oid: 'b'.repeat(40) }, isCrossRepository: false, baseRefName: 'main' };
    detail = { merged: true, head: { sha: 'a'.repeat(40) }, base: { ref: 'main' }, changed_files: 1, commits: 1 };
    files = [[{ filename: 'feature.txt', status: 'modified' }]];
    commits = [[{ sha: 'a'.repeat(40), parents: [{ sha: 'd'.repeat(40) }] }]];
    mock.options.mockResolvedValue({ cwd: '/synthetic/repo', env: {} });
    mock.git.mockResolvedValue({ stdout: '', exitCode: 0 });
    mock.gh.mockImplementation(async args => JSON.stringify(args[0] === 'pr' ? pr
      : args.at(-1).includes('/files?') ? files : args.at(-1).includes('/commits?') ? commits
        : args.at(-1).includes('/pulls/') ? detail
        : args.at(-1).includes('/git/ref/') ? { object: { sha: 'c'.repeat(40) } } : { default_branch: 'main' }));
  });

  it('binds the actual repository/default/PR refs and uses the managed app account', async () => {
    expect(await readRetirementForgeEvidence('/synthetic/repo', 'claim/42', prUrl, { forgeAccount: 'configured-owner' }))
      .toEqual({ repository: 'github.com/example/repo', prUrl, prHead: 'a'.repeat(40), mergeCommit: 'b'.repeat(40),
        changedPaths: ['feature.txt'], firstCommit: 'a'.repeat(40), changeBase: 'd'.repeat(40),
        defaultBranch: 'main', defaultHead: 'c'.repeat(40), remoteHead: null });
    expect(mock.options).toHaveBeenCalledWith('/synthetic/repo', { forgeAccount: 'configured-owner' });
  });

  it.each([
    { state: 'OPEN' }, { state: 'CLOSED' }, { headRefName: 'another-claim' },
    { isCrossRepository: true }, { baseRefName: 'release' }, { mergeCommit: null },
  ])('refuses a nonmatching merged PR: %j', async change => {
    Object.assign(pr, change);
    await expect(readRetirementForgeEvidence('/synthetic/repo', 'claim/42', prUrl)).rejects.toThrow('retirement-pr-not-matching-merged');
  });

  it('accepts a local repair alias only with exact merged head proof', async () => {
    const evidence = await readRetirementForgeEvidence('/synthetic/repo', 'repair/42', prUrl, { exactAliasHead: pr.headRefOid });
    expect(evidence).toMatchObject({ exactAliasHead: pr.headRefOid, publishedBranch: 'claim/42', publishedRemoteHead: null });
    await expect(readRetirementForgeEvidence('/synthetic/repo', 'repair/42', prUrl, { exactAliasHead: 'e'.repeat(40) }))
      .rejects.toThrow('retirement-pr-not-matching-merged');
    mock.git.mockImplementation(async args => ({ exitCode: 0, stdout: args.at(-1) === 'refs/heads/claim/42'
      ? `${'f'.repeat(40)}\trefs/heads/claim/42\n` : '' }));
    await expect(readRetirementForgeEvidence('/synthetic/repo', 'repair/42', prUrl, { exactAliasHead: pr.headRefOid }))
      .rejects.toThrow('retirement-remote-head-changed');
  });

  it('includes renamed previous paths and complete paginated file scope literally', async () => {
    detail.changed_files = 2;
    files = [[{ filename: ':(exclude)*', previous_filename: 'old.txt', status: 'renamed' }], [{ filename: 'new.txt', status: 'added' }]];
    const result = await readRetirementForgeEvidence('/synthetic/repo', 'claim/42', prUrl);
    expect(result.changedPaths).toEqual([':(exclude)*', 'new.txt', 'old.txt']);
    expect(mock.gh).toHaveBeenCalledWith(expect.arrayContaining(['--paginate', '--slurp']), undefined, expect.any(Object));
  });

  it.each(['file-count', 'commit-count', 'duplicate', 'missing-previous', 'ambiguous-base', 'wrong-tip', 'cap', 'bad-path', 'unpaginated'])('refuses incomplete or ambiguous original scope: %s', async change => {
    if (change === 'file-count') detail.changed_files = 2;
    if (change === 'commit-count') detail.commits = 2;
    if (change === 'duplicate') { detail.changed_files = 2; files[0].push(files[0][0]); }
    if (change === 'missing-previous') files[0][0].status = 'renamed';
    if (change === 'ambiguous-base') commits[0][0].parents.push({ sha: 'e'.repeat(40) });
    if (change === 'wrong-tip') commits[0][0].sha = 'e'.repeat(40);
    if (change === 'cap') detail.commits = 251;
    if (change === 'bad-path') files[0][0].filename = '../escape';
    if (change === 'unpaginated') files = files[0];
    await expect(readRetirementForgeEvidence('/synthetic/repo', 'claim/42', prUrl)).rejects.toThrow('retirement-original-scope-unavailable');
  });

  it('refuses a different repository before sending a forge request', async () => {
    await expect(readRetirementForgeEvidence('/synthetic/repo', 'claim/42', 'https://github.com/other/repo/pull/42'))
      .rejects.toThrow('retirement-pr-repository-mismatch');
    expect(mock.gh).not.toHaveBeenCalled();
  });

  it('distinguishes failed remote lookup and advanced remote head from absence', async () => {
    mock.git.mockRejectedValueOnce(new Error('synthetic unavailable'));
    await expect(readRetirementForgeEvidence('/synthetic/repo', 'claim/42', prUrl)).rejects.toThrow('retirement-remote-ref-unreadable');
    mock.git.mockResolvedValueOnce({ stdout: `${'d'.repeat(40)}\trefs/heads/claim/42\n`, exitCode: 0 });
    await expect(readRetirementForgeEvidence('/synthetic/repo', 'claim/42', prUrl)).rejects.toThrow('retirement-remote-head-changed');
  });
});
