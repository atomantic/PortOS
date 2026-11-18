import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it, vi } from 'vitest';

import { CI_WORKFLOW_FILE, pickGatedBaseSha, resolveBaseSha, resolveGatedBaseSha } from './ci-base-sha.js';
import { readCiJobs } from './lib/ciWorkflowJobs.js';
import { workflowJobs } from './lib/workflowJobs.js';

const WORKFLOW = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'ci.yml'),
  'utf8',
);

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

/** A merge-ref checkout: both parents resolve. */
const mergeRefRevParse = (rev) => ({ 'HEAD^1': BASE, 'HEAD^2': HEAD }[rev] ?? null);

describe('resolveBaseSha', () => {
  it('reads the base branch off the pull-request merge ref', () => {
    expect(resolveBaseSha({ eventName: 'pull_request', revParse: mergeRefRevParse })).toBe(BASE);
  });

  it('emits no base for a run that is not a pull request', () => {
    // Nightly, dispatch, and the release workflow_call all force the complete
    // suite, so there is nothing to diff against.
    expect(resolveBaseSha({ eventName: 'schedule', revParse: mergeRefRevParse })).toBeNull();
    expect(resolveBaseSha({ eventName: 'workflow_dispatch', revParse: mergeRefRevParse })).toBeNull();
    expect(resolveBaseSha({ eventName: undefined, revParse: mergeRefRevParse })).toBeNull();
  });

  it('refuses to treat a plain head-commit checkout as a merge ref', () => {
    // Without a second parent, HEAD^1 is the PR's own previous commit — using
    // it as the diff base would scope CI to the last commit of the branch.
    const headOnly = (rev) => (rev === 'HEAD^1' ? BASE : null);

    expect(resolveBaseSha({ eventName: 'pull_request', revParse: headOnly })).toBeNull();
  });

  it('emits nothing when git cannot resolve the parent at all', () => {
    expect(resolveBaseSha({ eventName: 'pull_request', revParse: () => null })).toBeNull();
  });
});

describe('resolveGatedBaseSha', () => {
  const GREEN = 'c'.repeat(40);
  const OLDER = 'd'.repeat(40);
  const run = (fields) => ({ event: 'push', conclusion: 'success', head_branch: 'main', head_sha: GREEN, ...fields });
  const ENV = { CI_GATED_BASE_LOOKUP: 'true', GITHUB_TOKEN: 'test-token', GITHUB_REPOSITORY: 'example/repo', GITHUB_API_URL: 'https://api.example.com' };
  const quiet = () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    return () => { warn.mockRestore(); log.mockRestore(); };
  };
  const respond = (body, { ok = true, status = 200 } = {}) => vi.fn(async () => ({ ok, status, json: async () => body }));

  it('takes the newest successful push or schedule run on main', () => {
    expect(pickGatedBaseSha({ workflow_runs: [run({}), run({ head_sha: OLDER })] })).toBe(GREEN);
    expect(pickGatedBaseSha({ workflow_runs: [run({ event: 'schedule' })] })).toBe(GREEN);
    // A pull request from a fork's `main`, a dispatch of any tree, a red run
    // and a malformed entry are never a green main tree.
    expect(pickGatedBaseSha({ workflow_runs: [
      run({ event: 'pull_request' }), run({ event: 'workflow_dispatch' }), run({ conclusion: 'failure' }),
      run({ head_branch: 'release' }), run({ head_sha: 'not-a-sha' }), null, run({ head_sha: OLDER }),
    ] })).toBe(OLDER);
    for (const listing of [{ workflow_runs: [] }, {}, null, { workflow_runs: 'x' }]) expect(pickGatedBaseSha(listing)).toBeNull();
  });

  it('lists green ci.yml runs on main, fetches the head at depth 1 and returns it', async () => {
    const restore = quiet();
    try {
      const fetchImpl = respond({ workflow_runs: [run({})] });
      const git = vi.fn(() => true);
      expect(await resolveGatedBaseSha({ env: ENV, fetchImpl, git })).toBe(GREEN);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe(`https://api.example.com/repos/example/repo/actions/workflows/${CI_WORKFLOW_FILE}/runs?branch=main&status=success&per_page=20`);
      expect(init.headers.Authorization).toBe('Bearer test-token');
      expect(git.mock.calls).toEqual([[['fetch', '--no-tags', '--depth=1', 'origin', GREEN]], [['cat-file', '-e', `${GREEN}^{commit}`]]]);
    } finally {
      restore();
    }
  });

  it('fails open to every native job on any lookup or fetch failure', async () => {
    const restore = quiet();
    try {
      const git = vi.fn(() => true);
      const failures = [
        { fetchImpl: vi.fn(async () => { throw new Error('network down'); }), git },
        { fetchImpl: respond({}, { ok: false, status: 403 }), git },
        { fetchImpl: vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } })), git },
        { fetchImpl: respond({ workflow_runs: [] }), git },
        { fetchImpl: respond({ workflow_runs: [run({})] }), git: vi.fn(() => false) },
        { fetchImpl: respond({ workflow_runs: [run({})] }), git: vi.fn((args) => args[0] === 'fetch') },
      ];
      for (const [index, deps] of failures.entries()) {
        expect(await resolveGatedBaseSha({ env: ENV, ...deps }), `failure ${index}`).toBeNull();
      }
      const fetchImpl = respond({ workflow_runs: [run({})] });
      expect(await resolveGatedBaseSha({ env: { ...ENV, GITHUB_TOKEN: '' }, fetchImpl, git })).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('never calls the API unless the run opted in', async () => {
    const fetchImpl = respond({ workflow_runs: [run({})] });
    const git = vi.fn(() => true);
    for (const flag of [undefined, '', 'false']) {
      expect(await resolveGatedBaseSha({ env: { ...ENV, CI_GATED_BASE_LOOKUP: flag }, fetchImpl, git })).toBeNull();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(git).not.toHaveBeenCalled();
  });

  it('opts in only the impact job of a push to main, never a schedule, dispatch, pull request or release call', () => {
    const jobs = readCiJobs();
    const lookup = '${{ github.event_name == \'push\' && github.ref == \'refs/heads/main\' && inputs.full != true }}';
    expect(jobs.impact).toContain(`CI_GATED_BASE_LOOKUP: ${lookup}`);
    expect(jobs.impact).toMatch(/permissions:\n {6}contents: read\n {6}actions: read\n/);
    for (const [id, body] of Object.entries(jobs)) {
      if (id !== 'impact') expect(body, id).not.toContain('CI_GATED_BASE_LOOKUP');
    }
    // The planner reads the exported sha, and a forced-full run stays forced.
    expect(jobs.impact).toContain("CI_FORCE_FULL: ${{ github.event_name != 'pull_request' || inputs.full == true }}");
    expect(WORKFLOW).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]\n/m);
  });
});

describe('ci.yml checkout depth', () => {
  // The diff-base step lives in a composite action; read the expanded jobs.
  const jobs = readCiJobs();

  it('keeps every CI job on a shallow checkout', () => {
    expect(Object.keys(jobs).length).toBeGreaterThan(0);
    for (const [id, body] of Object.entries(jobs)) {
      expect(body, id).not.toMatch(/fetch-depth:\s*0\b/);
    }
  });

  it('resolves the diff base in every job that consumes it', () => {
    // The `database` job's run-ci-tests.js step is CI_TEST_MODE=files with the
    // planner's exact browser-suite list (#10312): it diffs nothing, so it needs
    // neither the base nor a depth-2 clone.
    const consumers = Object.entries(jobs)
      .filter(([id, body]) => id !== 'database' && /run-ci-tests\.js|ci-test-plan\.js/.test(body));

    expect(consumers.map(([id]) => id).sort())
      .toEqual(['client', 'impact', 'server', 'windows-server']);

    for (const [id, body] of consumers) {
      expect(body, id).toMatch(/node scripts\/ci-base-sha\.js/);
      // Depth 2 is the merge commit plus both parents — the minimum that keeps
      // `<base>...HEAD` resolvable.
      expect(body, id).toMatch(/fetch-depth:\s*2\b/);
      // The event payload's base.sha can disagree with the merge ref's parent,
      // and needs history the shallow clone no longer has.
      expect(body, id).not.toMatch(/CI_BASE_SHA:\s*\$\{\{/);
    }
  });

  it('keeps the impact job at the depth-2 merge-ref checkout the planner diffs against', () => {
    expect(jobs.impact).toMatch(/fetch-depth:\s*2\b/);
    expect(jobs.impact).not.toMatch(/fetch-depth:\s*0\b/);
  });
});

describe('ci.yml required checks', () => {
  const jobs = workflowJobs(WORKFLOW);

  it('publishes the gate the branch ruleset actually requires', () => {
    expect(jobs.gate).toMatch(/name: CI Gate/);
    expect(jobs['full-gate']).toMatch(/name: Full CI Gate/);
  });

  it('requires full primary coverage and the supported Windows native contract set for the full gate', () => {
    // Release reuse needs both full primary suites and the native Windows
    // job; primary-only full plans leave windows_mode at skip.
    // The impact result comes first: fromJSON of a failed or skipped impact
    // job's empty output is an expression error, not a skip.
    expect(jobs['full-gate']).toMatch(/if: always\(\) && needs\.impact\.result == 'success' && /);
    expect(jobs['full-gate']).toMatch(/fromJSON\(needs\.impact\.outputs\.plan\)\.full && /);
    expect(jobs['full-gate']).toMatch(/fromJSON\(needs\.impact\.outputs\.plan\)\.windows_mode == 'files'/);
    // A push whose native jobs were gated on its diff ran a partial native set,
    // and verify-ci-status.js would reuse its marker for an identical tree.
    expect(jobs['full-gate']).toMatch(/!fromJSON\(needs\.impact\.outputs\.plan\)\.native_gated && /);
  });

});

describe('ci.yml server node_modules cache', () => {
  const jobs = readCiJobs();

  /** Every job that installs the server workspace — each one this cache serves. */
  const installers = Object.entries(jobs)
    .filter(([, body]) => body.includes('npm ci --prefix server'));

  /** The `Cache server node_modules` step of one job, up to the next step. */
  function cacheEntry(body) {
    const rest = body.slice(body.indexOf('- name: Cache server node_modules'));
    const end = rest.indexOf('      - name:', 1);
    return end > 0 ? rest.slice(0, end) : rest;
  }

  it('caches the installed tree on every job that installs it', () => {
    expect(installers.map(([id]) => id).sort())
      .toEqual(['browser', 'database', 'macos-native', 'server', 'windows-server']);
    // One definition: each job installs through the setup-server action.
    for (const [id, body] of installers) expect(body, id).toContain('uses: ./.github/actions/setup-server');

    for (const [, body] of installers) expect(cacheEntry(body)).toMatch(/id: server-modules\b/);
  });

  it('installs and rebuilds together, on any tree this job will cache', () => {
    // server/.npmrc pins ignore-scripts=true, so a tree saved before the
    // trusted rebuild is un-built — and the job that saved it still reports
    // success. Whenever a job builds the tree it will cache, it must build a
    // rebuilt one, so a condition on the rebuild NARROWER than the one on the
    // install (the `server` job used to gate on the planner's server_native
    // flag) reintroduces the hole.
    for (const [id, body] of installers) {
      const install = body.match(
        /- name: Install server dependencies\n {8}if: (?<cond>.*)\n {8}shell: bash\n {8}run: npm ci --prefix server/,
      );
      const rebuild = body.match(
        /- name: Rebuild trusted native dependencies\n {8}if: (?<cond>.*)\n/,
      );
      expect(install, id).not.toBeNull();
      expect(rebuild, id).not.toBeNull();
      expect(rebuild.groups.cond, id).toBe(install.groups.cond);
      expect(install.groups.cond, id).toBe("steps.server-modules-usable.outcome != 'success'");
    }
  });

  it('marks the tree in the same step that rebuilds it, under a fail-fast shell', () => {
    // Two steps could drift, and a failed rebuild in step one would still let
    // step two mark the tree as good. One `run:` block cannot — but only if
    // the shell stops on the first non-zero exit, and windows-server defaults
    // to pwsh, where a native command's failure neither throws nor stops the
    // block and only the LAST command's code becomes the step result. Without
    // the pin, a failed Windows rebuild would mark the tree anyway, exit 0, and
    // publish a green, marked, un-rebuilt cache entry.
    for (const [id, body] of installers) {
      const rebuild = body.slice(body.indexOf('- name: Rebuild trusted native dependencies'));
      expect(rebuild, id).toMatch(
        /run: \|\n {10}node scripts\/trusted-rebuilds\.js server\n {10}node scripts\/trusted-rebuild-stamp\.js write server/,
      );
      expect(rebuild.slice(0, rebuild.indexOf('run: |')), id).toMatch(/\n {8}shell: bash\n/);
    }
  });

  it('checks a restored tree without letting a bad entry wedge the repo', () => {
    for (const [id, body] of installers) {
      const check = body.match(
        /- name: Check the restored node_modules was rebuilt\n {8}id: server-modules-usable\n {8}if: (?<cond>.*)\n {8}continue-on-error: true\n {8}shell: bash\n {8}run: node scripts\/trusted-rebuild-stamp\.js check server/,
      );
      // Without continue-on-error the same broken entry fails every run
      // forever: nothing a pull request touches feeds the key, so the next run
      // restores it and dies identically until a human clears the cache.
      expect(check, id).not.toBeNull();
      expect(check.groups.cond, id).toBe("steps.server-modules.outputs.cache-hit == 'true'");
      // And it must come before the steps whose condition reads its outcome.
      expect(body.indexOf('id: server-modules-usable'), id)
        .toBeLessThan(body.indexOf('run: npm ci --prefix server'));
    }
  });

  it('never restores a near-miss dependency tree', () => {
    // `npm ci` is skipped on a hit, so a restore-keys fallback would hand the
    // job a node_modules built from a DIFFERENT lockfile and run the suite
    // against it. Exact key or nothing — unlike the transform cache below,
    // where a near miss is revalidated rather than trusted.
    for (const [id, body] of installers) {
      expect(cacheEntry(body), id).not.toMatch(/restore-keys/);
      expect(body, id).toMatch(/key: vitest-server-[^\n]*\n {10}restore-keys:/);
    }
  });

  it('keys on everything that changes what a correct tree contains', () => {
    const inputs = [
      // Dependency identity. package.json rides along so that skipping `npm ci`
      // does not also skip its manifest-vs-lockfile agreement check.
      'server/package-lock.json', 'server/package.json',
      // Whether install scripts ran at all, and which packages get rebuilt.
      'server/.npmrc', 'scripts/trusted-rebuilds.js',
    ];
    for (const [id, body] of installers) {
      const entry = cacheEntry(body);
      for (const input of inputs) expect(entry, `${id}: ${input}`).toContain(`'${input}'`);
      // Compiled addons do not load across a different OS, arch, or ABI.
      expect(entry, id).toMatch(/runner\.os \}\}-\$\{\{ runner\.arch \}\}-node/);
    }
  });

  it('pins the key to the Node major the jobs actually install', () => {
    // The major, not the resolved patch: NODE_MODULE_VERSION is stable across
    // patch releases, so keying on the patch would discard a ~570 MB entry on
    // every Node 26.x release for no ABI benefit. The tradeoff is that the
    // literal has to be kept honest, which is what this asserts.
    for (const [id, body] of installers) {
      const pinned = body.match(/node-version: (?<major>\d+)\.x/);
      expect(pinned, id).not.toBeNull();
      expect(cacheEntry(body), id).toContain(`-node${pinned.groups.major}-`);
    }
  });

  it('does not pay for a CUDA execution provider no runner can use', () => {
    // onnxruntime-node's postinstall downloads the CUDA EP on linux-x64
    // whenever the .so is absent — several hundred MB, on two jobs, every run.
    // No hosted runner has an NVIDIA GPU, and the CPU binaries ship in the
    // tarball. This is the single largest cost the caching work removes.
    for (const [id, body] of installers) {
      expect(body, id).toMatch(/ONNXRUNTIME_NODE_INSTALL_CUDA: skip/);
    }
  });
});

describe('ci.yml autofixer workspace install', () => {
  const jobs = workflowJobs(WORKFLOW);

  /** Every job that resolves the autofixer lockfile. */
  const installers = Object.entries(jobs)
    .filter(([, body]) => body.includes('npm ci --prefix autofixer'));

  it('resolves the autofixer lockfile and checks the server entry point on the job that always runs and each shard', () => {
    // autofixer/ carries its own package.json, its own tracked lockfile, and
    // its own .npmrc, and `npm run setup` / scripts/ensure-deps.js install it
    // on every user's machine. When no CI job ran `npm ci` against it, a
    // lockfile that stopped resolving shipped green and failed at setup time
    // instead — the static parity checks in dependency-overrides.guard.test.js only
    // parse the JSON. The impact job is the one that always runs, so the
    // install and the `node --check` of the entry point live there.
    // Named, so the loop below is never vacuously green on a deleted step.
    expect(jobs.impact).toMatch(/- name: Install autofixer dependencies\n {8}run: node scripts\/ci-impact-diagnostics\.js autofixer-install -- npm ci --prefix autofixer/);
    expect(jobs.impact).toMatch(/- name: Check server entry-point syntax\n {8}run: node scripts\/ci-impact-diagnostics\.js syntax -- node --check server\/index\.js/);
    // Shards are separate checkouts and run ../autofixer tests, which import
    // express from autofixer/node_modules, so they install it too.
    expect(jobs.server).toMatch(/- name: Install autofixer dependencies\n {8}run: npm ci --prefix autofixer/);
    expect(jobs.server).not.toContain('node --check server/index.js');
  });

  it('never lets a cache hit skip the resolution it exists to prove', () => {
    // The server tree is cached and its `npm ci` is skipped on a hit, which is
    // fine because that job's job is to run tests. This step's whole purpose is
    // the install, so caching it (or gating it on a cache outcome) would put
    // the hole straight back. It is cheap enough to pay on every plan.
    for (const [id, body] of installers) {
      const step = body.match(
        /- name: Install autofixer dependencies\n(?<between>(?: {8}.*\n)*?) {8}run: (?:node scripts\/ci-impact-diagnostics\.js autofixer-install -- )?npm ci --prefix autofixer/,
      );
      expect(step, id).not.toBeNull();
      expect(step.groups.between, id).not.toMatch(/^ {8}if:/m);
      expect(body, id).not.toMatch(/path: autofixer\/node_modules/);
    }
  });
});
