/**
 * The attestation posted after a push must never vouch for more than pregate
 * proved: a failed or unstable receipt, a tree other than the one validated,
 * a commit the remote does not have, or a stage that was skipped is each a
 * refusal — exercised here through `runAttest` with an injected exec, so the
 * only thing left to a live run is `gh`'s own authentication.
 */
import { describe, expect, it } from 'vitest';
import { parseArgs, planAttestation, runAttest, statusRequest, USAGE } from './pregate-attest.js';
import {
  ATTESTABLE_STAGES, attestedStagesFromReceipt, encodeAttestation, parseAttestation, parseRemoteRepository,
  PREGATE_STATUS_CONTEXT, selectAttestation, STATUS_DESCRIPTION_MAX_LENGTH,
} from './lib/pregateAttestation.js';
import { buildPregateReport } from './lib/pregateReport.js';

const TREE = 'a'.repeat(40);
const OTHER_TREE = 'b'.repeat(40);
const SHA = 'c'.repeat(40);

const stage = (suite, status = 'passed', name = suite) => ({ name, suite, command: `node scripts/${suite}.js`, status, durationMs: 1, exitCode: status === 'passed' ? 0 : 1 });
const plan = { full: false, reason: 'scoped', server: { mode: 'files', files: [], sources: [] }, client: { mode: 'skip', files: [], sources: [] }, lint: { mode: 'full', files: [] }, browser: { files: [] }, db: false, build: false, smoke: false, windows: false, promptHistory: false, linuxContainment: false, suiteReasons: {} };

/** A receipt as pregate writes it, with the given stage outcomes. */
const receipt = ({ stages, tree = TREE, treeAfterRun = tree, downgraded = false, skipped = [] }) => buildPregateReport({
  plan, options: {}, base: { ref: 'origin/main', sha: 'base' }, head: { sha: SHA }, tree, treeAfterRun, stages, skipped,
  runtime: {}, startedAt: 's', finishedAt: 'f', downgraded,
});

describe('attestation encoding', () => {
  it('round-trips every stage and stays within the status description limit', () => {
    const description = encodeAttestation({ tree: TREE, stages: [...ATTESTABLE_STAGES].reverse() });
    expect(description.length).toBeLessThanOrEqual(STATUS_DESCRIPTION_MAX_LENGTH);
    expect(description).toBe(`tree=${TREE} stages=${ATTESTABLE_STAGES.join(',')}`);
    expect(parseAttestation(description)).toEqual({ tree: TREE, stages: [...ATTESTABLE_STAGES] });
    expect(parseAttestation(encodeAttestation({ tree: TREE, stages: ['db', 'lint'] }))).toEqual({ tree: TREE, stages: ['lint', 'db'] });
  });

  it('rejects what it did not write: unknown stages, a short tree, duplicates, extra fields', () => {
    expect(() => encodeAttestation({ tree: TREE, stages: ['windows'] })).toThrow(/unknown attestation stage/);
    expect(() => encodeAttestation({ tree: TREE.slice(1), stages: ['lint'] })).toThrow(/40-hex/);
    expect(() => encodeAttestation({ tree: TREE, stages: [] })).toThrow(/at least one stage/);
    expect(parseAttestation(`tree=${TREE} stages=lint,windows`)).toBeNull();
    expect(parseAttestation(`tree=${TREE} stages=lint,lint`)).toBeNull();
    expect(parseAttestation(`tree=${TREE} stages=lint extra=1`)).toBeNull();
    expect(parseAttestation(`tree=${TREE.slice(2)} stages=lint`)).toBeNull();
    expect(parseAttestation(undefined)).toBeNull();
  });

  it('attests only suites whose every stage passed, and never a downgraded server/client run', () => {
    const stages = [stage('scan'), stage('lint'), stage('server'), stage('build', 'passed', 'client build'), stage('build', 'failed', 'bundle pin'), stage('db', 'not-run')];
    expect(attestedStagesFromReceipt(receipt({ stages }))).toEqual(['scan', 'lint', 'server']);
    expect(attestedStagesFromReceipt(receipt({ stages, downgraded: true }))).toEqual(['scan', 'lint']);
    expect(attestedStagesFromReceipt({})).toEqual([]);
  });
});

describe('selectAttestation', () => {
  const status = (overrides) => ({ context: PREGATE_STATUS_CONTEXT, state: 'success', creator: { login: 'owner' }, description: encodeAttestation({ tree: TREE, stages: ['lint'] }), created_at: '2026-10-18T10:00:00Z', ...overrides });

  it('takes the newest successful pregate status by the owner whose tree is the head tree', () => {
    const older = status({ description: encodeAttestation({ tree: TREE, stages: ['lint', 'server'] }), created_at: '2026-10-18T09:00:00Z' });
    const newer = status({ created_at: '2026-10-18T11:00:00Z' });
    const result = selectAttestation([older, newer, status({ context: 'ci/other' })], { owner: 'owner', headTree: TREE });
    expect(result.attestation).toMatchObject({ tree: TREE, stages: ['lint'], creator: 'owner' });
    expect(result.reason).toContain('attested by owner');
  });

  it('refuses the wrong creator, a mismatched tree, an unreadable description and a failed state', () => {
    expect(selectAttestation([status({ creator: { login: 'someone' } })], { owner: 'owner', headTree: TREE }).reason).toMatch(/created by "someone"/);
    expect(selectAttestation([status()], { owner: 'owner', headTree: OTHER_TREE }).reason).toMatch(/is not the head tree/);
    expect(selectAttestation([status({ description: 'pregate passed' })], { owner: 'owner', headTree: TREE }).reason).toMatch(/unreadable description/);
    expect(selectAttestation([status({ state: 'failure' })], { owner: 'owner', headTree: TREE }).reason).toMatch(/no successful/);
    expect(selectAttestation('not an array', { owner: 'owner', headTree: TREE }).reason).toMatch(/unreadable/);
    // A newer status by someone else outranks and so blocks an older owner one:
    // the newest word on the commit wins, and it is not the owner's.
    const owned = status({ created_at: '2026-10-18T09:00:00Z' });
    const foreign = status({ creator: { login: 'someone' }, created_at: '2026-10-18T12:00:00Z' });
    expect(selectAttestation([owned, foreign], { owner: 'owner', headTree: TREE }).attestation).toBeNull();
  });
});

describe('parseRemoteRepository', () => {
  it('reads owner/repo from the SSH and HTTPS remote shapes and rejects extra segments', () => {
    expect(parseRemoteRepository('git@github.com:acme/widget.git')).toEqual({ host: 'github.com', owner: 'acme', repo: 'widget' });
    expect(parseRemoteRepository('git@ssh.github.com:443/acme/widget.git')).toEqual({ host: 'ssh.github.com', owner: 'acme', repo: 'widget' });
    expect(parseRemoteRepository('https://github.com/acme/widget')).toEqual({ host: 'github.com', owner: 'acme', repo: 'widget' });
    expect(parseRemoteRepository('ssh://git@github.com:443/acme/widget.git')).toEqual({ host: 'github.com', owner: 'acme', repo: 'widget' });
    expect(parseRemoteRepository('git@github.com:acme/widget/extra')).toBeNull();
    expect(parseRemoteRepository('')).toBeNull();
  });
});

describe('planAttestation', () => {
  const commit = { sha: SHA, treeOf: () => TREE, isPushed: () => true, remote: 'origin' };
  const green = receipt({ stages: [stage('scan'), stage('lint'), stage('server'), stage('smoke')] });

  it('attests exactly the passed stages of a green, stable receipt on a pushed commit with that tree', () => {
    expect(planAttestation(green, commit)).toEqual({
      sha: SHA, tree: TREE, stages: ['scan', 'lint', 'server', 'smoke'], description: `tree=${TREE} stages=scan,lint,server,smoke`,
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
  ];
  const green = receipt({ stages: [stage('scan'), stage('lint'), stage('db', 'passed', 'provision'), stage('db', 'passed', 'suite')] });
  const io = () => { const out = []; const err = []; return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) }; };

  it('posts the status through gh on the upstream remote with the receipt-derived description', () => {
    const calls = [];
    const { out, err, log, error } = io();
    const exec = fakeExec([...gitTable(), [/^gh api --method POST /, '{}']], calls);
    const code = runAttest({ argv: [], exec, log, error, readReceipt: () => green });
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(calls.at(-1)).toBe(`gh api --method POST repos/acme/widget/statuses/${SHA} -f state=success -f context=pregate -f description=tree=${TREE} stages=scan,lint,db`);
    expect(out.at(-1)).toContain(`Attested ${SHA} tree=${TREE} stages=scan,lint,db`);
  });

  it('posts nothing on --dry-run and prints the payload it would send', () => {
    const calls = [];
    const { out, log, error } = io();
    const code = runAttest({ argv: ['--dry-run', '--target-url', 'https://example.com/run/1'], exec: fakeExec(gitTable(), calls), log, error, readReceipt: () => green });
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
      const code = runAttest({ argv: [], exec: fakeExec(table, calls), log, error, readReceipt: () => report });
      expect(code).toBe(1);
      expect(err[0]).toMatch(/^⛔ Not attested: /);
      expect(err[0]).toMatch(message);
      expect(calls.some((call) => call.startsWith('gh '))).toBe(false);
    }
  });

  it('attests --sha instead of HEAD and refuses a branch with no upstream remote', () => {
    const other = 'd'.repeat(40);
    const calls = [];
    const { log, error } = io();
    const code = runAttest({ argv: ['--sha', other], exec: fakeExec([...gitTable(), [/^gh api/, '{}']], calls), log, error, readReceipt: () => green });
    expect(code).toBe(0);
    expect(calls.some((call) => call === 'git rev-parse HEAD')).toBe(false);
    expect(calls.at(-1)).toContain(`statuses/${other}`);

    const { err: noUpstreamErr, log: log2, error: error2 } = io();
    const detached = fakeExec([[/^git rev-parse HEAD$/, SHA], [/^git config --get/, { status: 1, stdout: '', stderr: '' }], ...gitTable()]);
    expect(runAttest({ argv: [], exec: detached, log: log2, error: error2, readReceipt: () => green })).toBe(1);
    expect(noUpstreamErr[0]).toMatch(/no upstream remote; push it with `git push -u <remote> feature`/);
  });

  it('reports a gh failure as a refusal, naming the repository', () => {
    const { err, log, error } = io();
    const exec = fakeExec([...gitTable(), [/^gh api/, { status: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible' }]]);
    expect(runAttest({ argv: [], exec, log, error, readReceipt: () => green })).toBe(1);
    expect(err[0]).toMatch(/gh could not create the status on acme\/widget: HTTP 403/);
  });

  it('parses its flags and rejects the rest with usage', () => {
    expect(parseArgs(['--sha', SHA, '--dry-run'])).toEqual({ sha: SHA, dryRun: true, targetUrl: null, help: false });
    expect(() => parseArgs(['--sha', 'abc'])).toThrow(/40-character/);
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown option/);
    const { err, log, error } = io();
    expect(runAttest({ argv: ['--nope'], exec: fakeExec([]), log, error })).toBe(2);
    expect(err[0]).toContain(USAGE);
  });

  it('targets a non-github.com host explicitly and github.com implicitly', () => {
    expect(statusRequest({ owner: 'o', repo: 'r', host: 'github.com' }, { sha: SHA, description: 'd' }).args).not.toContain('--hostname');
    expect(statusRequest({ owner: 'o', repo: 'r', host: 'ghe.example.com' }, { sha: SHA, description: 'd' }).args).toEqual(expect.arrayContaining(['--hostname', 'ghe.example.com']));
  });
});
