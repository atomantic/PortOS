import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

import { resolveBaseSha } from './ci-base-sha.js';
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

describe('ci.yml checkout depth', () => {
  const jobs = workflowJobs(WORKFLOW);

  it('never asks for full history', () => {
    // fetch-depth: 0 clones every commit in the repo on a job that only ever
    // diffs the merge ref against its own first parent.
    expect(WORKFLOW).not.toMatch(/fetch-depth:\s*0\b/);
    // Negative control: the assertion above can fail.
    expect('        with:\n          fetch-depth: 0\n').toMatch(/fetch-depth:\s*0\b/);
  });

  it('resolves the diff base in every job that consumes it', () => {
    const consumers = Object.entries(jobs)
      .filter(([, body]) => /run-ci-tests\.js|ci-test-plan\.js/.test(body));

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
});

describe('ci.yml required checks', () => {
  const jobs = workflowJobs(WORKFLOW);

  it('publishes the gate the branch ruleset actually requires', () => {
    expect(jobs.gate).toMatch(/name: CI Gate/);
    expect(jobs['full-gate']).toMatch(/name: Full CI Gate/);
  });

  it('no longer carries the retired legacy check-name jobs', () => {
    // `lint` was a whole runner that echoed the client job's result, and the
    // server job wore `test (24.x)`; the ruleset requires neither.
    expect(jobs.lint).toBeUndefined();
    expect(WORKFLOW).not.toMatch(/name: test \(24\.x\)/);
    expect(jobs.gate).not.toMatch(/needs\.lint\b/);
  });
});

describe('ci.yml server node_modules cache', () => {
  const jobs = workflowJobs(WORKFLOW);

  /** Every job that installs the server workspace — the three this cache serves. */
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
      .toEqual(['database', 'server', 'windows-server']);

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
        /- name: Install server dependencies\n {8}if: (?<cond>.*)\n {8}run: npm ci --prefix server/,
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
        /- name: Check the restored node_modules was rebuilt\n {8}id: server-modules-usable\n {8}if: (?<cond>.*)\n {8}continue-on-error: true\n {8}run: node scripts\/trusted-rebuild-stamp\.js check server/,
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
    // every Node 24.x release for no ABI benefit. The tradeoff is that the
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

  it('resolves the autofixer lockfile on the job that runs the server suite', () => {
    // autofixer/ carries its own package.json, its own tracked lockfile, and
    // its own .npmrc, and `npm run setup` / scripts/ensure-deps.js install it
    // on every user's machine. When no CI job ran `npm ci` against it, a
    // lockfile that stopped resolving shipped green and failed at setup time
    // instead — the static parity checks in dependency-overrides.test.js only
    // parse the JSON. The server job is the one that already globs
    // autofixer/*.test.js, so it is where the tree belongs.
    // Named, so the loop below is never vacuously green on a deleted step.
    expect(jobs.server).toMatch(/- name: Install autofixer dependencies\n {8}run: npm ci --prefix autofixer/);
  });

  it('never lets a cache hit skip the resolution it exists to prove', () => {
    // The server tree is cached and its `npm ci` is skipped on a hit, which is
    // fine because that job's job is to run tests. This step's whole purpose is
    // the install, so caching it (or gating it on a cache outcome) would put
    // the hole straight back. The job-level `server_mode != 'skip'` is what
    // keeps a docs-only plan from paying for it.
    for (const [id, body] of installers) {
      const step = body.match(
        /- name: Install autofixer dependencies\n(?<between>(?: {8}.*\n)*?) {8}run: npm ci --prefix autofixer/,
      );
      expect(step, id).not.toBeNull();
      expect(step.groups.between, id).not.toMatch(/^ {8}if:/m);
      expect(body, id).not.toMatch(/path: autofixer\/node_modules/);
    }
  });
});
