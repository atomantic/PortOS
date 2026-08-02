import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import {
  DEFAULT_TASK_PROMPTS,
  PROMPT_VERSIONS,
  REFERENCE_WATCH_AUDITED_VERSION,
  PREVIOUS_DEFAULT_PROMPTS,
} from './taskPromptDefaults.js';
import { hashPromptBody, buildPromptIntegritySnapshot } from './taskPromptDefaults/integrityHash.js';

// Hash snapshot of every exported prompt body and version. This pins the
// cross-install prompt-upgrade contract (see CLAUDE.md "Distribution model"):
// a refactor of the taskPromptDefaults/ split cannot silently alter a prompt
// byte, and an INTENTIONAL prompt change forces the author through this file —
// where the rule is: bump PROMPT_VERSIONS, append the outgoing default to
// PREVIOUS_DEFAULT_PROMPTS, then regenerate the snapshot:
//
//   node scripts/regen-prompt-integrity-snapshot.js
//
// Prompt bodies embed the install's API origin, so hashing normalizes it to a
// placeholder first — see taskPromptDefaults/integrityHash.js, which both this
// test and that script share so they can't drift apart. Regenerating to silence
// a failure without the version bump + preserved outgoing default blesses
// whatever edited a preserved historical body, which is the failure mode this
// test exists to catch.
const SNAPSHOT = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'taskPromptDefaults', 'integrity.snapshot.json'),
  'utf8',
));

describe('taskPromptDefaults integrity snapshot', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('DEFAULT_TASK_PROMPTS bodies match the snapshot hashes exactly', () => {
    const actual = Object.fromEntries(
      Object.entries(DEFAULT_TASK_PROMPTS).map(([k, v]) => [k, hashPromptBody(v)]),
    );
    expect(actual).toEqual(SNAPSHOT.DEFAULT_TASK_PROMPTS);
  });

  // The snapshot pins prompt BYTES, not the machine that generated it. Hashing
  // used to normalize only the runtime PORTOS_API_URL, so the historical bodies
  // that hardcode the legacy `http://localhost:5555` origin only matched on an
  // install whose own API origin happened to equal it. Anywhere else — a custom
  // PORTOS_HOST, or merely a shell with PORT set, as inside a CoS agent — five
  // untouched bodies hashed differently and this suite failed while nothing had
  // drifted (issue #3359).
  it.each([
    // PORTOS_API_URL cleared so the origin is derived from host/port — and so
    // the expectation can't inherit whatever the ambient environment sets,
    // which is the very bug under test.
    [
      { PORTOS_API_URL: undefined, PORTOS_HOST: 'portos.example.test', PORT: '5558' },
      'http://portos.example.test:5558',
    ],
    // An origin that is a PREFIX of the legacy literal (port 80). Normalizing
    // the shorter one first would rewrite `http://localhost:5555` into
    // `{{PORTOS_API_URL}}:5555`, which the legacy pass can no longer match.
    [{ PORTOS_API_URL: 'http://localhost' }, 'http://localhost'],
    [{ PORTOS_API_URL: 'https://portos.example.test:8443' }, 'https://portos.example.test:8443'],
  ])('reproduces the snapshot on an install whose API origin is %j', async (env, expectedOrigin) => {
    vi.resetModules();
    Object.entries(env).forEach(([key, value]) => vi.stubEnv(key, value));

    const [freshDefaults, { PORTOS_API_URL }] = await Promise.all([
      import('./taskPromptDefaults.js'),
      import('../lib/ports.js'),
    ]);
    // Guard the guard: if the stub stopped taking effect this case would pass
    // vacuously by re-running the ambient-environment assertions above.
    expect(PORTOS_API_URL).toBe(expectedOrigin);

    expect(buildPromptIntegritySnapshot(freshDefaults, PORTOS_API_URL)).toEqual(SNAPSHOT);
  });

  it('PROMPT_VERSIONS matches the snapshot', () => {
    expect(PROMPT_VERSIONS).toEqual(SNAPSHOT.PROMPT_VERSIONS);
  });

  it('REFERENCE_WATCH_AUDITED_VERSION matches the snapshot', () => {
    expect(REFERENCE_WATCH_AUDITED_VERSION).toBe(SNAPSHOT.REFERENCE_WATCH_AUDITED_VERSION);
  });

  it('PREVIOUS_DEFAULT_PROMPTS bodies match the snapshot hashes exactly', () => {
    const actual = Object.fromEntries(
      Object.entries(PREVIOUS_DEFAULT_PROMPTS).map(([k, arr]) => [k, arr.map((p) => hashPromptBody(p))]),
    );
    expect(actual).toEqual(SNAPSHOT.PREVIOUS_DEFAULT_PROMPTS);
  });

  // feature-ideas v10: rejected-ideas ledger consultation (issue #2621).
  // Pins the version-bump pairing — the prompt change ships WITH its version
  // bump and the outgoing v9 default preserved for cross-install auto-upgrade.
  it('feature-ideas v10 consults REJECTED.md and closed-unmerged PRs, preserving the v9 default', () => {
    const current = DEFAULT_TASK_PROMPTS['feature-ideas'];
    expect(current).toContain('REJECTED.md');
    expect(current).toContain('is:unmerged');
    expect(PROMPT_VERSIONS['feature-ideas']).toBe(10);

    const previous = PREVIOUS_DEFAULT_PROMPTS['feature-ideas'];
    const v9 = previous[previous.length - 1];
    // The outgoing v9 default lacked the rejected-ideas consultation and is
    // preserved verbatim so installs holding it are recognized and upgraded.
    expect(v9).not.toContain('REJECTED.md');
    expect(v9).toContain('.changelog/');
    expect(v9).not.toBe(current);
  });

  // claim-issue v7 / claim-issue-gitlab v6: Phase 3 no longer parks an *ambiguous*
  // issue to `needs-input` and re-picks — the agent decides (picks the most
  // reasonable reading, records it in an issue comment/note, ships) instead of
  // punting the choice back to a human. `needs-input` is reserved for
  // destructive/irreversible or genuinely human-gated (hardware/credentials)
  // cases. Mirrors CLAUDE.md "Decide, don't defer". Pins the version-bump pairing
  // + preserved outgoing defaults for cross-install auto-upgrade.
  it.each([
    ['claim-issue', 8],
    ['claim-issue-gitlab', 7],
  ])('%s v%d decides an ambiguous issue instead of parking it, preserving the outgoing default', (key, version) => {
    const current = DEFAULT_TASK_PROMPTS[key];
    expect(current).toContain('Ambiguity is NOT a release trigger');
    expect(current).not.toContain('so it\'s excluded from future autonomous claims');
    expect(PROMPT_VERSIONS[key]).toBe(version);

    // The pre-"decide" default parked an ambiguous issue to `needs-input`; it is
    // preserved verbatim so installs holding it are recognized and upgraded.
    // (The immediately-outgoing default — now that the "decide" body has shipped
    // — is the "decide" body itself, so locate the pre-decide body by content
    // rather than by array position.)
    const previous = PREVIOUS_DEFAULT_PROMPTS[key];
    const preDecide = previous.find(
      (p) => p.includes('so it\'s excluded from future autonomous claims')
        && !p.includes('Ambiguity is NOT a release trigger'),
    );
    expect(preDecide).toBeDefined();
    expect(preDecide).not.toBe(current);
  });

  // dependency-updates v3: open Dependabot/Renovate PRs are triaged BEFORE the agent
  // bumps anything itself. v2 went straight to `npm outdated`, so a run against a repo
  // with open bot PRs re-did their work by hand — duplicate bumps, lockfile conflicts
  // against the bot branches, and a pile of stale bot PRs nobody closed.
  it('dependency-updates v3 triages bot PRs before updating, preserving the v2 default', () => {
    const current = DEFAULT_TASK_PROMPTS['dependency-updates'];
    expect(current).toContain('dependabot[bot]');
    expect(current).toContain('renovate[bot]');
    expect(current).toContain('FIX-THEN-MERGE');
    // Phase 2 must not re-bump a package a bot PR already owns — and must confirm that
    // per package rather than trusting Phase 1's listing to have been complete.
    expect(current).toContain('owns the bump');
    expect(current).toContain('confirm per package');
    // The task runs in the app's LIVE checkout (no useWorktree default), so repairing a
    // bot branch has to happen in a throwaway worktree — a bare `gh pr checkout` there
    // hijacks whatever branch the user is on.
    // …namespaced per app, since {worktreesRoot} is shared across every managed app.
    expect(current).toContain('{worktreesRoot}/dep-{appName}-pr-<n>');
    expect(current).toContain('THROWAWAY WORKTREE');
    // Rebasing the bot branch rewrites its commits, so the push needs a lease, not a ban.
    expect(current).toContain('--force-with-lease');
    expect(PROMPT_VERSIONS['dependency-updates']).toBe(3);

    const previous = PREVIOUS_DEFAULT_PROMPTS['dependency-updates'];
    const v2 = previous[previous.length - 1];
    // The outgoing v2 default knew nothing about bot PRs and is preserved verbatim so
    // installs holding it are recognized and upgraded.
    expect(v2).not.toContain('dependabot');
    expect(v2).toContain('Only update one major version bump at a time');
    expect(v2).not.toBe(current);
  });

  // NOTE: PROMPT_VERSIONS keys are SCHEDULE keys, not always prompt keys —
  // code-reviewer-a/b version a pipeline whose stages use the
  // code-reviewer-review / code-reviewer-implement prompt bodies — so there is
  // deliberately no "every versioned key has a prompt body" invariant here.
  it('every PREVIOUS_DEFAULT_PROMPTS key is a versioned prompt', () => {
    for (const key of Object.keys(PREVIOUS_DEFAULT_PROMPTS)) {
      expect(PROMPT_VERSIONS[key], `PROMPT_VERSIONS['${key}']`).toBeTypeOf('number');
    }
  });

  // Claim worktrees are created under PortOS's shared worktrees dir
  // ({worktreesRoot} → data/cos/worktrees, resolved in taskPromptService) rather
  // than inside the managed app repo, so an agent's checkout no longer pollutes
  // the target repo's working tree. Pins the version bump + preserved outgoing
  // repo-relative default for each claim flow, for cross-install auto-upgrade.
  it.each([
    ['plan-task', 11, 'WORKTREE="data/cos/worktrees'],
    ['claim-issue', 8, 'WORKTREE="data/cos/worktrees'],
    ['claim-issue-gitlab', 7, 'WORKTREE="data/cos/worktrees'],
    ['claim-issue-jira', 5, 'WORKTREE="{repoPath}/data/cos/worktrees'],
  ])('%s v%d creates its worktree under {worktreesRoot}, preserving the outgoing default', (key, version, oldPathMarker) => {
    const current = DEFAULT_TASK_PROMPTS[key];
    // Current default points the worktree at PortOS's shared worktrees dir…
    expect(current).toContain('{worktreesRoot}');
    // …and no longer at a path inside the target repo.
    expect(current).not.toContain(oldPathMarker);
    expect(PROMPT_VERSIONS[key]).toBe(version);

    // The outgoing default created the worktree inside the app repo; it is
    // preserved verbatim so installs holding it are recognized and upgraded.
    const previous = PREVIOUS_DEFAULT_PROMPTS[key];
    const outgoing = previous[previous.length - 1];
    expect(outgoing).toContain(oldPathMarker);
    expect(outgoing).not.toContain('{worktreesRoot}');
    expect(outgoing).not.toBe(current);
  });

  // branch-reconcile v2: "PR opened" is a completed STEP, not a completed
  // branch. v1's blanket "never merge unreviewed work" rule read as a veto on
  // the per-branch merge instruction, so a coordinator opened a PR and exited
  // while CI was still running — leaving a green, MERGEABLE PR sitting open.
  it('branch-reconcile keeps merged (not PR-opened) as the end state', () => {
    const current = DEFAULT_TASK_PROMPTS['branch-reconcile'];
    expect(current).toContain('not finished until it IS merged');
    expect(current).not.toContain('never merge unreviewed work');

    // The v1 default carried the blanket ban and no CI-wait rule; it is
    // preserved verbatim so installs holding it are recognized and upgraded.
    const [v1] = PREVIOUS_DEFAULT_PROMPTS['branch-reconcile'];
    expect(v1).toContain('never merge unreviewed work');
    expect(v1).not.toContain('not finished until it IS merged');
    expect(v1).not.toBe(current);
  });

  // branch-reconcile v3: a branch can be finished, correct, and still unwanted —
  // its problem solved a different way on the default branch while it sat. v2 had
  // nowhere to put that: every branch was merge-or-blocked, so the coordinator's
  // only route for a superseded branch was to resolve its conflicts and merge a
  // regression. The tell is the conflict itself, which is why the prompt has to
  // say outright that a resolvable conflict proves nothing.
  it('branch-reconcile v3 makes SUPERSEDED an outcome and denies conflicts as evidence, preserving the v2 default', () => {
    const current = DEFAULT_TASK_PROMPTS['branch-reconcile'];
    expect(current).toContain('SUPERSEDED');
    expect(current).toContain('not evidence the work is still needed');
    expect(current).toContain('Nothing reaches a PR unverified');
    expect(PROMPT_VERSIONS['branch-reconcile']).toBe(3);

    const previous = PREVIOUS_DEFAULT_PROMPTS['branch-reconcile'];
    const v2 = previous[previous.length - 1];
    // v2 already drove branches to merged, but had no supersession concept.
    expect(v2).toContain('not finished until it IS merged');
    expect(v2).not.toContain('SUPERSEDED');
    expect(v2).not.toBe(current);
  });
});
