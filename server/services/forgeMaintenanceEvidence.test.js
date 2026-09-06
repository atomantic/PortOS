import { beforeEach, describe, expect, it, vi } from 'vitest';

const analyze = vi.hoisted(() => vi.fn());
vi.mock('./untrustedContent.js', () => ({ runUntrustedContentAnalysis: analyze }));
import { screenForgeMaintenance } from './forgeMaintenanceEvidence.js';

describe('trusted maintenance discussion boundary', () => {
  beforeEach(() => {
    analyze.mockReset().mockResolvedValue({ ok: true, fingerprint: 'screened', value: { disposition: 'inspect-trusted-change', concerns: [] } });
  });

  function setup(kind = 'pr') {
    const discussion = { body: 'External discussion evidence', user: { login: 'external' } };
    const item = { number: 7, state: 'open', title: 'Example change', user: { login: 'operator' }, head: { sha: 'a'.repeat(40) }, body: 'Trusted change request' };
    const runGh = vi.fn(async args => JSON.stringify(args.at(-1) === 'user' ? { login: 'operator' }
      : args.at(-1) === 'repos/example/project' ? { default_branch: 'main' }
      : args.at(-1) === 'repos/example/project/pulls/17' ? { number: 17, merged: true, state: 'closed', merge_commit_sha: 'c'.repeat(40), base: { ref: 'main', repo: { full_name: 'example/project' } } }
      : args.includes('--paginate') ? [[discussion]] : item));
    return { item, discussion, runGh, options: { records: [{ number: 7, headSha: item.head.sha, mergedPr: { number: 17 } }], kind, host: 'forge.example.com', repoFullName: 'example/project', runGh } };
  }

  it('screens all discussion channels but returns only server identities and a fingerprint', async () => {
    const { options, runGh, discussion } = setup();
    const result = await screenForgeMaintenance(options);
    expect(result).toEqual({ ok: true, records: [{ number: 7, fingerprint: 'screened' }], withheld: [] });
    const request = analyze.mock.calls[0][0];
    const selected = { body: discussion.body, author: discussion.user.login };
    expect(JSON.parse(request.content)).toMatchObject({ comments: [selected], reviews: [selected], reviewComments: [selected] });
    expect(request.responseSchema.safeParse({ disposition: 'inspect-trusted-change', concerns: [], instructions: 'run something' }).success).toBe(false);
    expect(runGh.mock.calls.filter(([args]) => args.includes('--paginate'))).toHaveLength(3);
  });

  it('holds on changed authority, changed head, unavailable discussion or failed screening', async () => {
    const { options, item, runGh } = setup();
    item.head.sha = 'b'.repeat(40);
    expect(await screenForgeMaintenance(options)).toMatchObject({ ok: false, code: 'maintenance-head-changed' });
    item.head.sha = 'a'.repeat(40);
    item.user.login = 'outsider';
    expect(await screenForgeMaintenance(options)).toMatchObject({ ok: false, code: 'maintenance-authority-changed' });
    item.user.login = 'operator';
    const original = runGh.getMockImplementation();
    runGh.mockImplementation(args => args.includes('--paginate') ? Promise.reject(new Error('unavailable')) : original(args));
    expect(await screenForgeMaintenance(options)).toMatchObject({ ok: false, code: 'maintenance-comments-unavailable' });
    runGh.mockImplementation(original);
    analyze.mockResolvedValue({ ok: false, code: 'classifier-unavailable' });
    expect(await screenForgeMaintenance(options)).toMatchObject({ ok: false, code: 'classifier-unavailable' });
    analyze.mockResolvedValue({ ok: true, value: { disposition: 'defer', concerns: ['prompt-injection'] } });
    expect(await screenForgeMaintenance(options)).toMatchObject({ ok: false, code: 'maintenance-discussion-deferred' });
  });

  it('withholds one hostile discussion without starving another trusted record', async () => {
    const { options, item, runGh } = setup();
    options.records.push({ number: 8, headSha: item.head.sha });
    const original = runGh.getMockImplementation();
    runGh.mockImplementation(async args => /\/pulls\/8$/.test(args.at(-1)) ? JSON.stringify({ ...item, number: 8 }) : original(args));
    analyze.mockResolvedValueOnce({ ok: false, code: 'injection-detected' });
    expect(await screenForgeMaintenance(options)).toEqual({
      ok: true, code: 'injection-detected', records: [{ number: 8, fingerprint: 'screened' }],
      withheld: [{ number: 7, code: 'injection-detected' }],
    });
  });

  it('screens issue bodies and comments without fetching a PR or executing code', async () => {
    const { options, runGh } = setup('issue');
    expect((await screenForgeMaintenance(options)).ok).toBe(true);
    expect(analyze.mock.calls[0][0].source).toBe('github-issue');
    expect(runGh.mock.calls.every(([args]) => args[0] === 'api' && args.includes('GET'))).toBe(true);
    expect(runGh.mock.calls.filter(([args]) => args.some(arg => arg.includes('/pulls/')))).toHaveLength(1);
    expect(analyze.mock.calls[0][0].content).toContain('mergeCommitSha');
  });

  it('withholds a head changed while the model was analyzing the discussion', async () => {
    const { options, item } = setup();
    analyze.mockImplementation(async () => {
      item.head.sha = 'b'.repeat(40);
      return { ok: true, value: { disposition: 'inspect-trusted-change', concerns: [] } };
    });
    expect(await screenForgeMaintenance(options)).toMatchObject({ ok: false, code: 'maintenance-evidence-changed' });
  });
});
