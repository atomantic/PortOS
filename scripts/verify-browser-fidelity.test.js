import { describe, expect, it, vi } from 'vitest';
import { verifyBrowserFidelity } from './verify-browser-fidelity.js';
import { browserFidelityContext, browserFidelityProfileDigest } from './lib/browserFidelity.js';
import { BROWSER_FIDELITY_FILES } from './lib/browserTestProfiles.js';

const target = { repository: 'fixture/PortOS', pr: 12, head: 'a'.repeat(40), base: 'b'.repeat(40),
  merge: 'c'.repeat(40), tree: 'd'.repeat(40), profile: browserFidelityProfileDigest() };
const status = (overrides = {}) => ({ id: 1, context: browserFidelityContext(target), state: 'success',
  description: `receipt sha256=${'e'.repeat(64)}`, creator: { login: 'fixture' }, ...overrides });

function fixture({ statuses = [status()], expected = {}, mergeTree = target.tree, forkHead = false } = {}) {
  const env = { GITHUB_REPOSITORY: target.repository, GITHUB_TOKEN: 'synthetic token', CI_PULL_REQUEST: '12',
    CI_BROWSER_FILES: JSON.stringify(BROWSER_FIDELITY_FILES), CI_EXPECTED_HEAD: target.head,
    CI_EXPECTED_BASE: target.base, CI_EXPECTED_MERGE: target.merge, ...expected };
  const fetchImpl = vi.fn(async url => {
    let body;
    if (url.endsWith('/pulls/12')) body = { state: 'open', head: { sha: target.head, repo: { full_name: forkHead ? 'contributor/PortOS' : target.repository } },
      base: { sha: target.base, repo: { full_name: target.repository } }, merge_commit_sha: target.merge };
    else if (url.includes('/git/commits/')) body = { sha: target.head, tree: { sha: mergeTree },
      parents: [{ sha: target.base }, { sha: target.head }] };
    else if (url.includes('/statuses?')) body = statuses;
    else throw Error('Unexpected synthetic API URL');
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { env, fetchImpl };
}

describe('required browser fidelity admission', () => {
  it('accepts the personal repository owner and does not imply a remotely stored receipt', async () => {
    const f = fixture();
    await expect(verifyBrowserFidelity(f)).resolves.toEqual({ required: true,
      context: status().context, receiptDigest: 'e'.repeat(64) });
    expect(f.fetchImpl.mock.calls.at(-1)[0]).toContain(`/commits/${target.head}/statuses`);
  });

  it('accepts a fork-origin PR only through the base repository owner status', async () => {
    await expect(verifyBrowserFidelity(fixture({ forkHead: true }))).resolves.toMatchObject({ required: true });
    await expect(verifyBrowserFidelity(fixture({ forkHead: true,
      statuses: [status({ creator: { login: 'contributor' } })] }))).rejects.toThrow('receipt');
  });

  it('rejects a stale PR head', async () => {
    await expect(verifyBrowserFidelity(fixture({ expected: { CI_EXPECTED_HEAD: 'f'.repeat(40) } }))).rejects.toThrow('stale');
  });

  it('retains head-only fidelity when only the observed base and merge advance', async () => {
    const f = fixture({ expected: { CI_EXPECTED_BASE: 'f'.repeat(40), CI_EXPECTED_MERGE: 'f'.repeat(40) } });
    await expect(verifyBrowserFidelity(f)).resolves.toMatchObject({ required: true });
    expect(browserFidelityContext({ ...target, base: 'f'.repeat(40), merge: 'f'.repeat(40) })).toBe(status().context);
  });

  it.each([
    [],
    [status({ context: browserFidelityContext({ ...target, profile: '0'.repeat(64) }) })],
    [status({ creator: { login: 'untrusted' } })],
    [status(), status({ id: 2, state: 'pending' })],
    [status(), status({ id: 2, state: 'failure' })],
  ].map(statuses => ({ statuses })))('fails closed on missing, wrong-profile, untrusted or superseded evidence: %j', async ({ statuses }) => {
    await expect(verifyBrowserFidelity(fixture({ statuses }))).rejects.toThrow('receipt');
  });

  it('rejects a receipt for a different head tree', async () => {
    await expect(verifyBrowserFidelity(fixture({ mergeTree: 'f'.repeat(40) }))).rejects.toThrow('receipt');
  });

  it('requires selection input, but does not request receipts for smoke-only suites', async () => {
    const f = fixture();
    delete f.env.CI_BROWSER_FILES;
    await expect(verifyBrowserFidelity(f)).rejects.toThrow();
    f.env.CI_BROWSER_FILES = '["server/lib/filmLook.browser.test.js"]';
    await expect(verifyBrowserFidelity(f)).resolves.toEqual({ required: false });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
});
