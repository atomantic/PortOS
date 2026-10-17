import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishBrowserFidelity } from './browser-fidelity.js';
import { BROWSER_FIDELITY_TESTS, BROWSER_FIDELITY_FILES } from './lib/browserTestProfiles.js';

const head = 'a'.repeat(40), base = 'b'.repeat(40), merge = 'c'.repeat(40), tree = 'd'.repeat(40);
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture({ outcome = 'passed', changed = false, dirty = false, wrongTree = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'browser-fidelity-contract-')); roots.push(root);
  const posts = [];
  const seen = {};
  let finished = false;
  const request = vi.fn(async (path, body) => {
    if (body) { posts.push(body); return { state: body.state, context: body.context, creator: { login: 'fixture' } }; }
    if (path === 'user') return { login: 'fixture' };
    if (path.endsWith('/pulls/12')) return { state: 'open', head: { sha: head, repo: { full_name: 'fixture/PortOS' } },
      base: { sha: base, repo: { full_name: 'fixture/PortOS' } }, merge_commit_sha: merge };
    if (path.endsWith(`/git/commits/${head}`)) return { sha: head, tree: { sha: tree }, parents: [{ sha: base }] };
    throw Error('Unexpected synthetic API request');
  });
  const git = vi.fn(args => args[0] === 'status' ? (dirty ? ' M changed.js' : '')
    : args.at(-1) === 'HEAD' ? (finished && changed ? 'e'.repeat(40) : head) : wrongTree ? 'f'.repeat(40) : tree);
  const run = vi.fn(async (_scope, _script, args, { env, signal }) => {
    expect(signal.aborted).toBe(false);
    expect(args).toContain('--testNamePattern=\\[fidelity\\]');
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PORTOS_BROWSER_TEST_PROFILE).toBe('fidelity');
    expect(env.PORTOS_REQUIRE_BROWSER_SUITES).toBe('1');
    roots.push(dirname(env.PORTOS_CI_DIAGNOSTICS_DIR));
    seen.diagnostics = env.PORTOS_CI_DIAGNOSTICS_DIR;
    expect(env.PORTOS_CI_BROWSER_OWNER).toBeUndefined();
    expect(env.CHROME_PATH).toBe('/synthetic/chrome');
    const dir = join(env.PORTOS_CI_DIAGNOSTICS_DIR, 'portos-vitest-contract');
    mkdirSync(dir);
    const report = { success: true, numFailedTests: 0, numFailedTestSuites: 0, numPassedTests: 4,
      testResults: Object.entries(BROWSER_FIDELITY_TESTS).map(([name, titles]) => ({ name,
        assertionResults: titles.map(title => ({ title, fullName: `suite ${title}`, status: 'passed' })) })) };
    if (outcome === 'skipped') report.testResults[0].assertionResults[0].status = 'pending';
    if (outcome === 'failed') { report.success = false; report.numFailedTests = 1; }
    if (outcome === 'missing') report.testResults.pop();
    for (const [name, data] of Object.entries({
      'invocation.json': { completed: outcome !== 'incomplete', status: 0, signal: null },
      'run.json': { reason: 'passed', errorCount: 0, errors: [], completedCount: 2, activeModules: [], teardownTimeout: outcome === 'teardown' },
      'failures.json': report,
    })) writeFileSync(join(dir, name), JSON.stringify(data));
    finished = true;
    if (outcome === 'aborted') return new Promise(resolve => signal.addEventListener('abort',
      () => resolve({ status: 143, interrupted: 'SIGTERM' }), { once: true }));
    return { status: outcome === 'launcher' ? 1 : 0 };
  });
  return { root, posts, run, seen, options: { pr: 12, repository: 'fixture/PortOS', receiptPath: join(root, 'receipt.json'),
    request, git, run, toolchain: async () => ({ chromePath: '/synthetic/chrome',
      receipt: { chrome: 'Chrome synthetic', ffmpeg: 'FFmpeg synthetic', renderBackend: { kind: 'unknown' } } }), env: { PATH: process.env.PATH, PORTOS_CI_BROWSER_OWNER: 'unit', GITHUB_TOKEN: 'synthetic credential', OPENAI_API_KEY: 'synthetic key' } } };
}

describe('local fidelity publication through the existing runner and status boundary', () => {
  it('publishes pending then success only after complete exact-head results, retaining a local receipt', async () => {
    const f = fixture();
    const result = await publishBrowserFidelity(f.options);
    expect(f.posts.map(post => post.state)).toEqual(['pending', 'success']);
    const receipt = JSON.parse(readFileSync(result.receiptPath, 'utf8'));
    expect(receipt.target).toMatchObject({ head, base, tree, merge });
    expect(receipt.profile.files).toEqual(BROWSER_FIDELITY_FILES);
    expect(receipt.profile.executed).toBe(4);
    expect(f.posts[1].context.length).toBeLessThanOrEqual(100);
    expect(f.posts[1].description).toMatch(/^receipt sha256=[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toMatch(/synthetic credential|synthetic key/);
  });

  it('removes diagnostics and the private root after an admitted run, keeping an external receipt', async () => {
    const f = fixture();
    const result = await publishBrowserFidelity(f.options);
    expect(existsSync(result.receiptPath)).toBe(true);
    expect(existsSync(f.seen.diagnostics)).toBe(false);
    expect(existsSync(dirname(f.seen.diagnostics))).toBe(false);
  });

  it('retains diagnostics for a rejected run, then a later run reclaims the dead-owner root', async () => {
    const failed = fixture({ outcome: 'failed' });
    await expect(publishBrowserFidelity(failed.options)).rejects.toThrow('not admitted');
    expect(existsSync(failed.seen.diagnostics)).toBe(true);
    expect(existsSync(join(dirname(failed.seen.diagnostics), '.owner.pid'))).toBe(true);
    // Simulate the owning process having exited.
    writeFileSync(join(dirname(failed.seen.diagnostics), '.owner.pid'), '2147483646 0\n');
    await publishBrowserFidelity(fixture().options);
    expect(existsSync(dirname(failed.seen.diagnostics))).toBe(false);
  });

  it('binds default git identity to the script checkout when invoked from another directory', () => {
    const foreign = mkdtempSync(join(tmpdir(), 'fidelity-foreign-cwd-')); roots.push(foreign);
    const entry = new URL('./browser-fidelity.js', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { publishBrowserFidelity } from ${JSON.stringify(entry)};
      const repository = 'fixture/PortOS';
      const request = async path => path.includes('/pulls/')
        ? { state: 'open', head: {sha: '${head}', repo: {full_name: repository}}, base: {sha: '${base}', repo: {full_name: repository}}, merge_commit_sha: '${merge}' }
        : { sha: '${head}', tree: {sha: '${tree}'}, parents: [{sha: '${base}'}, {sha: '${head}'}] };
      try { await publishBrowserFidelity({ pr: 12, repository, request, run: () => { throw Error('must not execute'); } }); }
      catch (error) { console.log(error.message); }
    `], { cwd: foreign, encoding: 'utf8', timeout: 10000 });
    expect(result.error).toBeUndefined();
    expect(result.stdout).toMatch(/clean checkout|match the current PR head/);
    expect(result.stdout).not.toContain('Git checkout identity unavailable');
  });

  it.each(['skipped', 'failed', 'missing', 'incomplete', 'teardown', 'launcher'])('never publishes success for %s evidence', async outcome => {
    const f = fixture({ outcome });
    await expect(publishBrowserFidelity(f.options)).rejects.toThrow('not admitted');
    expect(f.posts.map(post => post.state)).toEqual(['pending', 'failure']);
  });

  it('refuses with a redacted underlying reason when a pre-admission operation throws', async () => {
    const f = fixture();
    f.options.toolchain = async () => { throw Error('spawn /Users/alice/bin/chrome failed GITHUB_TOKEN=sup3rs3cretvalue'); };
    const error = await publishBrowserFidelity(f.options).catch(caught => caught);
    expect(error.message).toContain('not admitted');
    expect(error.reason).toContain('spawn <path> failed');
    expect(error.reason).not.toMatch(/alice|sup3rs3cretvalue/);
    expect(f.posts.map(post => post.state)).toEqual(['pending', 'failure']);
    expect(f.run).not.toHaveBeenCalled();
  });

  it('keeps the existing refusal wording and surfaces the runner failure reason', async () => {
    const f = fixture({ outcome: 'failed' });
    const error = await publishBrowserFidelity(f.options).catch(caught => caught);
    expect(error.message).toBe('Browser fidelity was not admitted; local diagnostics were retained.');
    expect(error.reason).toBe('Fidelity structured result did not pass.');
    expect(f.posts.map(post => post.state)).toEqual(['pending', 'failure']);
  });

  it('fails pending publication after its bounded runner cancellation settles', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ outcome: 'aborted' });
      const pending = publishBrowserFidelity({ ...f.options, deadlineMs: 100 });
      const rejected = expect(pending).rejects.toThrow('not admitted');
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(f.posts.map(post => post.state)).toEqual(['pending', 'failure']);
    } finally { vi.useRealTimers(); }
  });

  it('invalidates pending evidence when the checkout changes during execution', async () => {
    const f = fixture({ changed: true });
    await expect(publishBrowserFidelity(f.options)).rejects.toThrow('not admitted');
    expect(f.posts.map(post => post.state)).toEqual(['pending', 'failure']);
  });

  it.each([{ dirty: true }, { wrongTree: true }])('refuses an unreviewable checkout before any status or execution: %j', async options => {
    const f = fixture(options);
    await expect(publishBrowserFidelity(f.options)).rejects.toThrow();
    expect(f.posts).toEqual([]);
    expect(f.run).not.toHaveBeenCalled();
  });
});
