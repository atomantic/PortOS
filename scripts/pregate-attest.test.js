/**
 * The attestation posted after a push must never vouch for more than pregate
 * proved: a failed or unstable receipt, a tree other than the one validated,
 * a commit the remote does not have, a plan computed against a narrowed base,
 * or a stage that was skipped is each a refusal — exercised here through
 * `runAttest` with an injected exec, so the only thing left to a live run is
 * `gh`'s own authentication.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs, planAttestation, resolveRepository, runAttest, statusRequest, USAGE } from './pregate-attest.js';
import {
  ATTESTABLE_STAGES, attestedStagesFromReceipt, encodeAttestation, encodeRevocation, nodeMajor, parseAttestation,
  parseRemoteRepository, PREGATE_STATUS_CONTEXT, selectAttestation, STATUS_DESCRIPTION_MAX_LENGTH,
} from './lib/pregateAttestation.js';
import { buildPregateReport } from './lib/pregateReport.js';

const TREE = 'a'.repeat(40);
const OTHER_TREE = 'b'.repeat(40);
const SHA = 'c'.repeat(40);
const BASE = 'e'.repeat(40);
const OS = 'darwin';
const NODE = 26;
const encode = (stages, tree = TREE) => encodeAttestation({ tree, stages, os: OS, node: NODE });

const stage = (suite, status = 'passed', name = suite) => ({ name, suite, command: `node scripts/${suite}.js`, status, durationMs: 1, exitCode: status === 'passed' ? 0 : 1 });
const plan = { full: false, reason: 'scoped', server: { mode: 'files', files: [], sources: [] }, client: { mode: 'skip', files: [], sources: [] }, lint: { mode: 'full', files: [] }, browser: { files: [] }, db: false, build: false, smoke: false, windows: false, promptHistory: false, linuxContainment: false, supercolliderLive: false, suiteReasons: {} };

/** A receipt as pregate writes it, with the given stage outcomes. */
const receipt = ({ stages, tree = TREE, treeAfterRun = tree, downgraded = false, skipped = [], base = { ref: 'origin/main', sha: BASE } }) => buildPregateReport({
  plan, options: { base: base.ref, full: true }, base, head: { sha: SHA }, tree, treeAfterRun, stages, skipped,
  runtime: { node: 'v26.10.0', platform: OS }, startedAt: 's', finishedAt: 'f', downgraded,
});

describe('attestation encoding', () => {
  it('round-trips every stage plus platform and Node major within the status description limit', () => {
    for (const os of ['darwin', 'linux', 'win32']) {
      const description = encodeAttestation({ tree: TREE, stages: [...ATTESTABLE_STAGES].reverse(), os, node: 999 });
      expect(description.length).toBeLessThanOrEqual(STATUS_DESCRIPTION_MAX_LENGTH);
      expect(parseAttestation(description)).toEqual({ tree: TREE, os, node: 999, stages: [...ATTESTABLE_STAGES] });
    }
    expect(encode(['db', 'lint'])).toBe(`tree=${TREE} os=darwin node=26 stages=lint,db`);
    expect(parseAttestation(encode(['db', 'lint']))).toEqual({ tree: TREE, os: OS, node: NODE, stages: ['lint', 'db'] });
    expect(nodeMajor('v26.10.0')).toBe(26);
    expect(nodeMajor('garbage')).toBeNull();
  });

  it('rejects what it did not write: unknown stages, a short tree, duplicates, extra or missing fields', () => {
    expect(() => encode(['windows'])).toThrow(/unknown attestation stage/);
    expect(() => encode(['lint'], TREE.slice(1))).toThrow(/40-hex/);
    expect(() => encode([])).toThrow(/at least one stage/);
    expect(() => encodeAttestation({ tree: TREE, stages: ['lint'], os: 'Mac OS', node: NODE })).toThrow(/platform/);
    expect(() => encodeAttestation({ tree: TREE, stages: ['lint'], os: OS, node: NaN })).toThrow(/Node major/);
    expect(parseAttestation(`tree=${TREE} os=darwin node=26 stages=lint,windows`)).toBeNull();
    expect(parseAttestation(`tree=${TREE} os=darwin node=26 stages=lint,lint`)).toBeNull();
    expect(parseAttestation(`tree=${TREE} os=darwin node=26 stages=lint extra=1`)).toBeNull();
    expect(parseAttestation(`tree=${TREE} stages=lint`)).toBeNull();
    expect(parseAttestation(`tree=${TREE.toUpperCase()} os=darwin node=26 stages=lint`)).toBeNull();
    expect(parseAttestation(`tree=${TREE} os=darwin node=26 stages=`)).toBeNull();
    expect(parseAttestation(undefined)).toBeNull();
  });

  it('attests only suites whose every stage passed, and never a downgraded server/client run', () => {
    const stages = [stage('scan'), stage('lint'), stage('server'), stage('build', 'passed', 'client build'), stage('build', 'failed', 'bundle pin'), stage('db', 'not-run')];
    expect(attestedStagesFromReceipt(receipt({ stages }))).toEqual(['scan', 'lint', 'server']);
    expect(attestedStagesFromReceipt(receipt({ stages, downgraded: true }))).toEqual(['scan', 'lint']);
    expect(attestedStagesFromReceipt({})).toEqual([]);
  });

  it('encodes a revocation as a bounded failure description', () => {
    expect(encodeRevocation('tests were flaky')).toBe('revoked: tests were flaky');
    expect(encodeRevocation('')).toBe('revoked: pregate result withdrawn');
    expect(encodeRevocation('x'.repeat(200)).length).toBe(STATUS_DESCRIPTION_MAX_LENGTH);
    expect(encodeRevocation('a\nb')).toBe('revoked: a b');
  });
});

describe('selectAttestation', () => {
  const status = (overrides) => ({ context: PREGATE_STATUS_CONTEXT, state: 'success', creator: { login: 'owner' }, description: encode(['lint']), created_at: '2026-10-18T10:00:00Z', ...overrides });

  it('takes the newest pregate status by the owner whose tree is the head tree', () => {
    const older = status({ description: encode(['lint', 'server']), created_at: '2026-10-18T09:00:00Z' });
    const newer = status({ created_at: '2026-10-18T11:00:00Z' });
    const result = selectAttestation([older, newer, status({ context: 'ci/other', created_at: '2026-10-18T12:00:00Z' })], { owner: 'owner', headTree: TREE });
    expect(result.attestation).toMatchObject({ tree: TREE, stages: ['lint'], creator: 'owner', os: OS, node: NODE });
    expect(result.reason).toContain('attested by owner');
    expect(result.reason).toContain('darwin/node 26');
  });

  it('lets the newest status of ANY state decide: a later failure, pending or error revokes an earlier success', () => {
    const success = status({ created_at: '2026-10-18T09:00:00Z' });
    for (const state of ['failure', 'pending', 'error']) {
      const later = status({ state, description: 'revoked: flaky run', created_at: '2026-10-18T10:00:00Z' });
      const result = selectAttestation([success, later], { owner: 'owner', headTree: TREE });
      expect(result.attestation).toBeNull();
      expect(result.reason).toBe(`newest pregate status is ${state}, not success (revoked: flaky run)`);
    }
    // And a newer success by someone else blocks the owner's older one.
    const foreign = status({ creator: { login: 'someone' }, created_at: '2026-10-18T12:00:00Z' });
    expect(selectAttestation([success, foreign], { owner: 'owner', headTree: TREE }).reason).toMatch(/created by "someone"/);
  });

  it('refuses the wrong creator, a mismatched tree, an unreadable description and no status at all', () => {
    expect(selectAttestation([status({ creator: { login: 'someone' } })], { owner: 'owner', headTree: TREE }).reason).toMatch(/created by "someone"/);
    expect(selectAttestation([status()], { owner: 'owner', headTree: OTHER_TREE }).reason).toMatch(/is not the head tree/);
    expect(selectAttestation([status({ description: 'pregate passed' })], { owner: 'owner', headTree: TREE }).reason).toMatch(/unreadable description/);
    expect(selectAttestation([status({ context: 'ci/other' })], { owner: 'owner', headTree: TREE }).reason).toMatch(/^no "pregate" status/);
    expect(selectAttestation('not an array', { owner: 'owner', headTree: TREE }).reason).toMatch(/unreadable/);
  });
});

describe('repository resolution', () => {
  it('reads owner/repo from the SSH and HTTPS remote shapes, folds ssh.github.com, and flags an alias host', () => {
    expect(parseRemoteRepository('git@github.com:acme/widget.git')).toEqual({ host: 'github.com', owner: 'acme', repo: 'widget', hostIsResolvable: true });
    expect(parseRemoteRepository('git@ssh.github.com:443/acme/widget.git')).toMatchObject({ host: 'github.com', owner: 'acme', repo: 'widget' });
    expect(parseRemoteRepository('ssh://git@ssh.github.com:443/acme/widget.git')).toMatchObject({ host: 'github.com' });
    expect(parseRemoteRepository('https://github.com/acme/widget')).toMatchObject({ host: 'github.com', owner: 'acme', repo: 'widget' });
    expect(parseRemoteRepository('git@ghe.example.com:org/repo.git')).toMatchObject({ host: 'ghe.example.com', owner: 'org', repo: 'repo', hostIsResolvable: true });
    expect(parseRemoteRepository('git@github-acme:acme/widget.git')).toMatchObject({ host: 'github-acme', hostIsResolvable: false });
    expect(parseRemoteRepository('git@github.com:acme/widget/extra')).toBeNull();
    expect(parseRemoteRepository('')).toBeNull();
  });

  it('asks gh repo view for the real host behind an ssh alias, and only then', () => {
    let asked = 0;
    const ghRepoView = () => { asked += 1; return { nameWithOwner: 'acme/widget', url: 'https://github.com/acme/widget' }; };
    expect(resolveRepository('git@github.com:acme/widget.git', { ghRepoView })).toMatchObject({ host: 'github.com', owner: 'acme', repo: 'widget' });
    expect(asked).toBe(0);
    expect(resolveRepository('git@github-acme:acme/widget.git', { ghRepoView })).toEqual({ host: 'github.com', owner: 'acme', repo: 'widget', hostIsResolvable: true });
    expect(asked).toBe(1);
    expect(resolveRepository('git@github-acme:acme/widget.git', { ghRepoView: () => null })).toBeNull();
    expect(resolveRepository('not a url', { ghRepoView: () => ({ nameWithOwner: 'o/r', url: 'https://ghe.example.com/o/r' }) })).toMatchObject({ host: 'ghe.example.com', owner: 'o', repo: 'r' });
  });

  it('targets a non-github.com host explicitly and github.com implicitly', () => {
    expect(statusRequest({ owner: 'o', repo: 'r', host: 'github.com' }, { sha: SHA, description: 'd' }).args).not.toContain('--hostname');
    expect(statusRequest({ owner: 'o', repo: 'r', host: 'ghe.example.com' }, { sha: SHA, description: 'd' }).args).toEqual(expect.arrayContaining(['--hostname', 'ghe.example.com']));
    expect(statusRequest({ owner: 'o', repo: 'r', host: 'github.com' }, { sha: SHA, description: 'revoked: x', state: 'failure' }).args).toContain('state=failure');
  });
});

describe('planAttestation', () => {
  const commit = { sha: SHA, treeOf: () => TREE, isPushed: () => true, remote: 'origin', defaultMergeBase: BASE };
  const green = receipt({ stages: [stage('scan'), stage('lint'), stage('server'), stage('smoke')] });

  it('attests exactly the passed stages of a green, stable receipt on a pushed commit with that tree', () => {
    expect(planAttestation(green, commit)).toEqual({
      sha: SHA, tree: TREE, stages: ['scan', 'lint', 'server', 'smoke'], description: `tree=${TREE} os=darwin node=26 stages=scan,lint,server,smoke`, notes: [],
    });
  });

  it('refuses a failed receipt, an unstable tree, a legacy receipt and a missing one', () => {
    const failed = receipt({ stages: [stage('scan'), stage('lint', 'failed')] });
    expect(() => planAttestation(failed, commit)).toThrow(/did not pass/);
    expect(() => planAttestation(receipt({ stages: [stage('scan')], treeAfterRun: OTHER_TREE }), commit)).toThrow(/changed while pregate ran/);
    const legacy = { ...green, plan: { ...green.plan } };
    delete legacy.plan.downgraded;
    expect(() => planAttestation(legacy, commit)).toThrow(/predates attestation/);
    expect(() => planAttestation(null, commit)).toThrow(/no receipt/);
  });

  it('refuses a commit whose tree is not the validated tree, and an unpushed one', () => {
    expect(() => planAttestation(green, { ...commit, treeOf: () => OTHER_TREE })).toThrow(/something changed after pregate; rerun/);
    expect(() => planAttestation(green, { ...commit, treeOf: () => null })).toThrow(/cannot resolve/);
    expect(() => planAttestation(green, { ...commit, isPushed: () => false })).toThrow(/not on origin yet: push it first/);
  });

  it('drops the diff-selected stages when the receipt was planned against a narrowed or unknown base', () => {
    const narrowed = receipt({ stages: [stage('scan'), stage('lint'), stage('server'), stage('client'), stage('smoke'), stage('db')], base: { ref: 'HEAD~1', sha: 'f'.repeat(40) } });
    const result = planAttestation(narrowed, commit);
    expect(result.stages).toEqual(['scan', 'smoke', 'db']);
    expect(result.notes[0]).toMatch(/not attesting lint, server, client: the receipt was planned against base fffffffff \(HEAD~1\), not the default branch's merge base eeeeeeeee/);
    // The probe shape: no base sha recorded at all.
    const probe = { runtime: green.runtime, passed: true, treeStable: true, tree: TREE, options: { base: 'HEAD~1' }, base: { ref: 'HEAD~1' }, plan: { downgraded: false }, stages: [stage('scan'), stage('server')] };
    expect(planAttestation(probe, commit).stages).toEqual(['scan']);
    // An unresolved default merge base fails the same way.
    expect(planAttestation(green, { ...commit, defaultMergeBase: null }).stages).toEqual(['scan', 'smoke']);
    // Nothing left after the drop is a refusal that says why.
    expect(() => planAttestation(receipt({ stages: [stage('server')], base: { ref: 'HEAD~1', sha: 'f'.repeat(40) } }), commit)).toThrow(/attests no stage.*not attesting server/);
  });

  it('describes the receipt\'s runtime, not the attesting process\'s, and refuses a receipt without a valid one', () => {
    const elsewhere = { ...green, runtime: { node: 'v22.3.0', platform: 'linux' } };
    expect(planAttestation(elsewhere, commit).description).toBe(`tree=${TREE} os=linux node=22 stages=scan,lint,server,smoke`);
    for (const runtime of [undefined, {}, { node: 'v26.10.0' }, { platform: OS }, { node: 'garbage', platform: OS }, { node: 'v26.10.0', platform: 'Mac OS' }]) {
      expect(() => planAttestation({ ...green, runtime }, commit), JSON.stringify(runtime)).toThrow(/no valid runtime/);
    }
  });

  it('refuses when nothing attestable passed', () => {
    const guardsOnly = receipt({ stages: [stage('server')], downgraded: true });
    expect(() => planAttestation(guardsOnly, commit)).toThrow(/attests no stage/);
  });
});

describe('runAttest', () => {
  /** A spawnSync double keyed by `command args…`; unknown invocations fail loudly. */
  const fakeExec = (table, calls = []) => (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    calls.push(key);
    for (const [pattern, result] of table) {
      if (pattern.test(key)) return typeof result === 'string' ? { status: 0, stdout: `${result}\n`, stderr: '' } : result;
    }
    return { status: 1, stdout: '', stderr: `unexpected: ${key}` };
  };
  const gitTable = (overrides = []) => [
    ...overrides,
    [/^git rev-parse HEAD$/, SHA],
    [/^git symbolic-ref --short -q HEAD$/, 'feature'],
    [/^git config --get branch\.feature\.remote$/, 'upstream'],
    [/^git remote get-url upstream$/, 'git@github.com:acme/widget.git'],
    [/^git rev-parse --verify --quiet .*\^\{tree\}$/, TREE],
    [/^git branch -r --contains .* --format=/, 'upstream/feature\nfork/feature'],
    [/^git ls-remote --heads upstream$/, `${BASE}\trefs/heads/main`],
    [/^git symbolic-ref --short -q refs\/remotes\/upstream\/HEAD$/, 'upstream/main'],
    [/^git merge-base upstream\/main /, BASE],
  ];
  const green = receipt({ stages: [stage('scan'), stage('lint'), stage('db', 'passed', 'provision'), stage('db', 'passed', 'suite')] });
  const io = () => { const out = []; const err = []; return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) }; };
  const run = (options) => runAttest(options);

  it('posts the status through gh on the upstream remote with the receipt-derived description', () => {
    const calls = [];
    const { out, err, log, error } = io();
    const exec = fakeExec([...gitTable(), [/^gh api --method POST /, '{}']], calls);
    const code = run({ argv: [], exec, log, error, readReceipt: () => green });
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(calls.at(-1)).toBe(`gh api --method POST repos/acme/widget/statuses/${SHA} -f state=success -f context=pregate -f description=tree=${TREE} os=darwin node=26 stages=scan,lint,db`);
    expect(out.at(-1)).toContain(`Attested ${SHA} tree=${TREE} stages=scan,lint,db`);
    expect(calls.some((call) => call.startsWith('gh repo view'))).toBe(false);
  });

  it('posts nothing on --dry-run and prints the payload it would send', () => {
    const calls = [];
    const { out, log, error } = io();
    const code = run({ argv: ['--dry-run', '--target-url', 'https://example.com/run/1'], exec: fakeExec(gitTable(), calls), log, error, readReceipt: () => green });
    expect(code).toBe(0);
    expect(calls.some((call) => call.startsWith('gh '))).toBe(false);
    const payload = JSON.parse(out[0]);
    expect(payload).toMatchObject({ repository: 'acme/widget', sha: SHA, context: 'pregate', state: 'success', target_url: 'https://example.com/run/1' });
    expect(payload.command).toContain('target_url=https://example.com/run/1');
  });

  it('refuses an unpushed commit, a tree mismatch and a failed receipt without calling gh', () => {
    for (const [table, report, message] of [
      [gitTable([[/^git branch -r --contains/, 'fork/feature']]), green, /not on upstream yet/],
      [gitTable([[/^git rev-parse --verify --quiet .*\^\{tree\}$/, OTHER_TREE]]), green, /something changed after pregate/],
      [gitTable(), receipt({ stages: [stage('lint', 'failed')] }), /did not pass/],
      [gitTable(), null, /no receipt/],
    ]) {
      const calls = [];
      const { err, log, error } = io();
      const code = run({ argv: [], exec: fakeExec(table, calls), log, error, readReceipt: () => report });
      expect(code).toBe(1);
      expect(err[0]).toMatch(/^⛔ Not attested: /);
      expect(err[0]).toMatch(message);
      expect(calls.some((call) => call.startsWith('gh '))).toBe(false);
    }
  });

  it('refuses unreadable or malformed remote publication evidence without posting', () => {
    for (const result of [{ status: 1, stderr: 'unreachable' }, `${SHA}\trefs/tags/only`, 'malformed']) {
      const calls = [];
      const output = io();
      const exec = fakeExec(gitTable([
        [/^git branch -r --contains/, ''], [/^git ls-remote --heads upstream$/, result],
      ]), calls);
      expect(run({ exec, ...output, readReceipt: () => green })).toBe(1);
      expect(output.err[0]).toMatch(/cannot verify publication/);
      expect(calls.some((call) => call.startsWith('gh api'))).toBe(false);
    }
  });

  it('attests an explicit-path push with stale tracking refs using real Git, without changing the checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'pregate-published-'));
    const remote = join(root, 'remote.git');
    const cwd = join(root, 'checkout');
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    try {
      git('init', '--bare', remote);
      git('init', '-b', 'main', cwd);
      git('-C', cwd, 'config', 'user.name', 'Fixture');
      git('-C', cwd, 'config', 'user.email', 'fixture@example.invalid');
      git('-C', cwd, 'remote', 'add', 'origin', remote);
      const commit = (text) => {
        writeFileSync(join(cwd, 'file'), text);
        git('-C', cwd, 'add', 'file');
        git('-C', cwd, 'commit', '-m', text);
        return git('-C', cwd, 'rev-parse', 'HEAD');
      };
      const initial = commit('initial');
      git('-C', cwd, 'push', '-u', 'origin', 'main');
      const published = commit('published');
      git('-C', cwd, 'push', remote, 'main');
      // Git for Windows may recognize this path as the configured origin and
      // update its tracking ref. Model stale tracking explicitly on every host;
      // publication must still be proved from the advertised remote, not refs.
      git('-C', cwd, 'update-ref', 'refs/remotes/origin/main', initial);
      expect(git('-C', cwd, 'branch', '-r', '--contains', published)).toBe('');
      const before = git('-C', cwd, 'show-ref');
      const calls = [];
      const exec = (command, args, options) => {
        if (command === 'gh') {
          calls.push(args);
          return { status: 0, stdout: args[0] === 'repo' ? JSON.stringify({ nameWithOwner: 'acme/widget', url: 'https://github.com/acme/widget' }) : '{}' };
        }
        return spawnSync(command, args, options);
      };
      const attest = () => run({ cwd, exec, ...io(), readReceipt: () => receipt({ tree: git('-C', cwd, 'rev-parse', 'HEAD^{tree}'), stages: [stage('scan')] }) });
      expect(attest()).toBe(0);
      expect(calls.filter((args) => args[0] === 'api')).toHaveLength(1);
      expect(git('-C', cwd, 'show-ref')).toBe(before);
      expect(git('-C', cwd, 'status', '--porcelain')).toBe('');
      commit('unpublished');
      expect(attest()).toBe(1);
      git('-C', cwd, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
      expect(attest()).toBe(1);
      expect(calls.filter((args) => args[0] === 'api')).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('narrows the attestation when the receipt base is not the default branch merge base, and says so', () => {
    const { out, log, error } = io();
    const calls = [];
    const exec = fakeExec([[/^git merge-base upstream\/main /, 'f'.repeat(40)], ...gitTable(), [/^gh api --method POST /, '{}']], calls);
    expect(run({ argv: [], exec, log, error, readReceipt: () => green })).toBe(0);
    expect(out.some((line) => /⚠️ not attesting lint: the receipt was planned against base/.test(line))).toBe(true);
    expect(calls.at(-1)).toContain('stages=scan,db');
  });

  it('attests --sha instead of HEAD and refuses a branch with no upstream remote', () => {
    const other = 'd'.repeat(40);
    const calls = [];
    const { log, error } = io();
    const code = run({ argv: ['--sha', other], exec: fakeExec([...gitTable(), [/^gh api/, '{}']], calls), log, error, readReceipt: () => green });
    expect(code).toBe(0);
    expect(calls.some((call) => call === 'git rev-parse HEAD')).toBe(false);
    expect(calls.at(-1)).toContain(`statuses/${other}`);

    const { err: noUpstreamErr, log: log2, error: error2 } = io();
    const detached = fakeExec([[/^git rev-parse HEAD$/, SHA], [/^git config --get/, { status: 1, stdout: '', stderr: '' }], ...gitTable()]);
    expect(run({ argv: [], exec: detached, log: log2, error: error2, readReceipt: () => green })).toBe(1);
    expect(noUpstreamErr[0]).toMatch(/no upstream remote; push it with `git push -u <remote> feature`/);
  });

  it('resolves an ssh-alias remote through gh repo view before posting', () => {
    const calls = [];
    const { log, error } = io();
    const exec = fakeExec([
      [/^git remote get-url upstream$/, 'git@github-acme:acme/widget.git'],
      [/^gh repo view --json nameWithOwner,url$/, JSON.stringify({ nameWithOwner: 'acme/widget', url: 'https://github.com/acme/widget' })],
      ...gitTable(), [/^gh api --method POST /, '{}'],
    ], calls);
    expect(run({ argv: [], exec, log, error, readReceipt: () => green })).toBe(0);
    expect(calls.at(-1)).toMatch(/^gh api --method POST repos\/acme\/widget\/statuses\//);
    expect(calls.at(-1)).not.toContain('--hostname');

    const { err, log: log2, error: error2 } = io();
    const unresolved = fakeExec([[/^git remote get-url upstream$/, 'git@github-acme:acme/widget.git'], [/^gh repo view/, { status: 1, stdout: '', stderr: 'no' }], ...gitTable()]);
    expect(run({ argv: [], exec: unresolved, log: log2, error: error2, readReceipt: () => green })).toBe(1);
    expect(err[0]).toMatch(/gh repo view` could not name the repository/);
  });

  it('revokes with a failure status carrying the reason, without reading a receipt', () => {
    const calls = [];
    const { out, log, error } = io();
    const exec = fakeExec([...gitTable(), [/^gh api --method POST /, '{}']], calls);
    expect(run({ argv: ['--revoke', 'flaky DB run'], exec, log, error, readReceipt: () => { throw new Error('must not read'); } })).toBe(0);
    expect(calls.at(-1)).toBe(`gh api --method POST repos/acme/widget/statuses/${SHA} -f state=failure -f context=pregate -f description=revoked: flaky DB run`);
    expect(out.at(-1)).toMatch(/^⛔ Revoked the pregate attestation/);
    // Dry-run revocation posts nothing; an unpushed commit has nothing to revoke.
    const dry = [];
    expect(run({ argv: ['--revoke', '--dry-run'], exec: fakeExec(gitTable(), dry), ...io(), readReceipt: () => null })).toBe(0);
    expect(dry.some((call) => call.startsWith('gh api'))).toBe(false);
    const { err, log: log3, error: error3 } = io();
    expect(run({ argv: ['--revoke'], exec: fakeExec(gitTable([[/^git branch -r --contains/, 'fork/feature']])), log: log3, error: error3 })).toBe(1);
    expect(err[0]).toMatch(/no status to revoke/);
  });

  it('reports a gh failure as a refusal, naming the repository', () => {
    const { err, log, error } = io();
    const exec = fakeExec([...gitTable(), [/^gh api/, { status: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible' }]]);
    expect(run({ argv: [], exec, log, error, readReceipt: () => green })).toBe(1);
    expect(err[0]).toMatch(/gh could not create the status on acme\/widget: HTTP 403/);
  });

  it('parses its flags and rejects the rest with usage', () => {
    expect(parseArgs(['--sha', SHA, '--dry-run'])).toEqual({ sha: SHA, dryRun: true, targetUrl: null, help: false, revoke: null });
    expect(parseArgs(['--revoke'])).toMatchObject({ revoke: '' });
    expect(parseArgs(['--revoke', 'why', '--dry-run'])).toMatchObject({ revoke: 'why', dryRun: true });
    expect(() => parseArgs(['--sha', 'abc'])).toThrow(/40-character/);
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown option/);
    const { err, log, error } = io();
    expect(run({ argv: ['--nope'], exec: fakeExec([]), log, error })).toBe(2);
    expect(err[0]).toContain(USAGE);
  });
});

describe('focused receipt boundary', () => {
  it('refuses focused or unspecified v3 proof while preserving legacy stage evidence', () => {
    const report = { version: 3, validationMode: 'focused', plan: { downgraded: false }, stages: [{ suite: 'server', status: 'passed' }] };
    expect(attestedStagesFromReceipt(report)).toEqual([]);
    expect(() => planAttestation(report, {})).toThrow(/focused local validation/);
    expect(attestedStagesFromReceipt({ ...report, validationMode: undefined })).toEqual([]);
    expect(attestedStagesFromReceipt({ ...report, version: 2, validationMode: undefined })).toEqual(['server']);
  });
});
