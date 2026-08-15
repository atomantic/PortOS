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
  // Version numbers are pinned once, by the `agy` test below — a content test
  // that also asserts the version has to be edited by every unrelated bump.
  it.each([
    ['claim-issue'],
    ['claim-issue-gitlab'],
  ])('%s decides an ambiguous issue instead of parking it, preserving the outgoing default', (key) => {
    const current = DEFAULT_TASK_PROMPTS[key];
    expect(current).toContain('Ambiguity is NOT a release trigger');
    expect(current).not.toContain('so it\'s excluded from future autonomous claims');

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
    ['plan-task', 'WORKTREE="data/cos/worktrees'],
    ['claim-issue', 'WORKTREE="data/cos/worktrees'],
    ['claim-issue-gitlab', 'WORKTREE="data/cos/worktrees'],
    ['claim-issue-jira', 'WORKTREE="{repoPath}/data/cos/worktrees'],
  ])('%s creates its worktree under {worktreesRoot}, preserving the repo-relative default', (key, oldPathMarker) => {
    const current = DEFAULT_TASK_PROMPTS[key];
    // Current default points the worktree at PortOS's shared worktrees dir…
    expect(current).toContain('{worktreesRoot}');
    // …and no longer at a path inside the target repo.
    expect(current).not.toContain(oldPathMarker);

    // The pre-{worktreesRoot} default created the worktree inside the app repo;
    // it is preserved verbatim so installs holding it are recognized and
    // upgraded. Located by CONTENT, not array position: later revisions append
    // their own outgoing bodies after it (see the `agy` bump below).
    const preShared = PREVIOUS_DEFAULT_PROMPTS[key].find(
      (p) => p.includes(oldPathMarker) && !p.includes('{worktreesRoot}'),
    );
    expect(preShared).toBeDefined();
    expect(preShared).not.toBe(current);
  });

  // The `antigravity` reviewer slug is a stored, federated identity — its shipped
  // executable is `agy`, and no `antigravity` command exists on any PATH. A claim
  // agent handed the bare slug probed `command -v antigravity`, found nothing,
  // declared the reviewer unavailable, and merged its PR on a self-review. Every
  // claim/plan prompt that enumerates the CLI reviewers must name the binary.
  it.each([
    ['plan-task', 14],
    ['claim-issue', 12],
    ['claim-issue-gitlab', 11],
    ['claim-issue-jira', 9],
  ])('%s v%d names the antigravity reviewer\'s `agy` binary, preserving the pre-`agy` default', (key, version) => {
    const current = DEFAULT_TASK_PROMPTS[key];
    expect(PROMPT_VERSIONS[key]).toBe(version);
    // EVERY mention of the slug carries the binary — a bare `antigravity`
    // anywhere in the body is the regression.
    expect(current).not.toMatch(/`antigravity`(?! \(CLI binary: `agy`\))/);
    expect(current).toContain('`antigravity` (CLI binary: `agy`)');
    // …and a reviewer whose binary is missing must not be replaced by the
    // agent's own self-review, which is what actually merged the bad PR.
    expect(current).toContain('is UNSATISFIED, not clean');
    expect(current).toContain('Do NOT substitute your own self-review');

    // The pre-`agy` default named only the slug; preserved verbatim so installs
    // holding it are recognized and auto-upgraded. Located by CONTENT, not array
    // position — later revisions append their own outgoing bodies after it.
    const preAgy = PREVIOUS_DEFAULT_PROMPTS[key].find(
      (p) => p.includes('`antigravity`') && !p.includes('CLI binary: `agy`'),
    );
    expect(preAgy).toBeDefined();
    expect(preAgy).not.toContain('is UNSATISFIED, not clean');
    expect(preAgy).not.toBe(current);
  });

  // A branch created from a remote default-branch ref normally inherits that
  // ref as its upstream. The claim flows later derive their push destination
  // from the branch config, so that inherited upstream could send claim work
  // directly to the default branch instead of its PR branch. Keep these four
  // commands untracked until their explicit `git push -u` phase establishes
  // the correct upstream. dependency-updates intentionally differs: it starts
  // from the bot PR head, where tracking the existing PR branch is correct.
  it.each([
    'plan-task',
    'claim-issue',
    'claim-issue-gitlab',
    'claim-issue-jira',
  ])('%s creates a no-track claim worktree and preserves the outgoing default', (key) => {
    const current = DEFAULT_TASK_PROMPTS[key];
    const worktreeCommands = current.match(/^git(?: -C \{repoPath\})? worktree add\b.*$/gm) || [];

    expect(worktreeCommands).toHaveLength(1);
    expect(worktreeCommands.every((command) => command.includes('--no-track'))).toBe(true);

    const outgoing = PREVIOUS_DEFAULT_PROMPTS[key].at(-1);
    expect(outgoing).toMatch(/\bworktree add -b\b/);
    expect(outgoing).not.toContain('--no-track');
    expect(outgoing).not.toBe(current);
  });

  it('keeps dependency-update worktrees tracking their PR head', () => {
    const current = DEFAULT_TASK_PROMPTS['dependency-updates'];

    expect(current).toContain('worktree add -b dep-{appName}-pr-<n>');
    expect(current).not.toContain('--no-track');
  });

  // Changelog instructions defer to the convention the repo documents rather
  // than prescribing an append to `.changelog/NEXT.md`. PortOS (and any repo
  // that adopts the same shape) collects per-branch fragments so parallel
  // agents don't conflict on one shared file; a prompt that hardcodes the
  // append sends every agent down the legacy path. These prompts run against
  // MANAGED apps too, so they must NOT hardcode `npm run changelog:add` — that
  // script does not exist in most repos.
  // Versions are NOT re-pinned here: the snapshot test above already pins every
  // PROMPT_VERSIONS value, so a content test that also asserts one just has to be
  // edited by every unrelated bump.
  it.each([
    'documentation',
    'plan-task',
    'claim-issue',
    'claim-issue-gitlab',
    'claim-issue-jira',
  ])('%s defers to the repo\'s documented changelog convention, preserving the outgoing default', (key) => {
    const current = DEFAULT_TASK_PROMPTS[key];
    expect(current).toContain('per-branch fragment');
    // Repo-agnostic: no PortOS-only helper script in a prompt that runs
    // against managed apps.
    expect(current).not.toContain('changelog:add');
    // The append is now the documented-convention FALLBACK, never the instruction.
    expect(current).not.toMatch(/append (?:a one-line entry )?to `\.changelog\/NEXT\.md`/);

    // Located by CONTENT rather than a fixed array position: later revisions
    // (the claim flows' converging Phase 3, below) append their own outgoing
    // bodies after it. `findLast`, NOT `find` — several older revisions also
    // predate the fragment convention, and matching the OLDEST of them would
    // keep passing if the actual pre-fragment body were dropped or edited.
    const preFragment = PREVIOUS_DEFAULT_PROMPTS[key].findLast(
      (p) => !p.includes('per-branch fragment') && p.includes('.changelog/NEXT.md'),
    );
    expect(preFragment).toBeDefined();
    expect(preFragment).not.toBe(current);
  });

  // Phase 3 ("Verify still valid") releases an issue for reasons the work
  // detector cannot see — `isActionableIssue` (perpetualWork.js) reads only
  // labels/assignees/epic/in-flight, never the body or comments. So a Phase-3
  // exit that leaves the issue OPEN and unlabeled reads as actionable forever
  // and the perpetual drain re-spawns a no-op agent on it every tick. Every
  // release path must therefore land a converging outcome: closed, or
  // `needs-input` (both skipped by Phase 1 step 4). Issue #4106.
  // Assertions are scoped to the Phase 3 SECTION, not the whole body: `gh issue
  // close` / `glab issue close` already appear in Phase 7's post-merge
  // reconcile, so a whole-body `toContain` would pass even with Phase 3 left
  // exactly as broken as it was.
  const phaseSection = (body, n) => {
    const start = body.indexOf(`## Phase ${n} —`);
    const end = body.indexOf(`## Phase ${n + 1} —`, start);
    expect(start, `Phase ${n} heading`).toBeGreaterThan(-1);
    expect(end, `Phase ${n + 1} heading`).toBeGreaterThan(start);
    return body.slice(start, end);
  };

  it.each([
    ['claim-issue', 'gh issue close', 'gh issue edit "${NUM}" --add-label needs-input'],
    ['claim-issue-gitlab', 'glab issue close', 'glab issue update "${NUM}" --label needs-input'],
  ])('%s converges every Phase-3 release, preserving the pre-convergence default', (key, closeCommand, parkCommand) => {
    const current = DEFAULT_TASK_PROMPTS[key];
    const phase3 = phaseSection(current, 3);
    // The already-fixed/superseded branch CLOSES rather than releasing open…
    expect(phase3).toContain('**Already fixed, superseded, or closed-then-reopened-for-tracking**');
    expect(phase3).toContain(closeCommand);
    // …and the stale-reference branch tags the label the detector skips.
    expect(phase3).toContain('**Stale reference**');
    expect(phase3).toContain(parkCommand);
    expect(phase3).toContain('CONVERGING outcome');
    // Closing is destructive, so the close branch is gated on nameable
    // evidence — an agent that merely suspects the work landed must implement.
    expect(phase3).toContain('**Evidence gate:');
    // The old blanket "release the claim and re-pick" instruction is what left
    // the issue open and unlabeled — it must be gone, not merely qualified.
    expect(phase3).not.toContain('If ANY of these are true, release the claim and re-pick');

    // Later prompt revisions append their own outgoing defaults, so identify
    // the pre-convergence body by its Phase-3 behavior rather than array slot.
    const preConvergence = PREVIOUS_DEFAULT_PROMPTS[key].findLast(
      (body) => phaseSection(body, 3).includes('If ANY of these are true, release the claim and re-pick'),
    );
    expect(preConvergence).toBeDefined();
    const preConvergencePhase3 = phaseSection(preConvergence, 3);
    expect(preConvergencePhase3).not.toContain(closeCommand);
    expect(preConvergence).not.toBe(current);
  });

  // JIRA has no labels, so its converging vocabulary is status: an already-fixed
  // ticket goes to Done/Closed, and a stale-reference ticket parks on a held
  // status behind a Review Hub todo. Transitioning back to a not-started status
  // is the JIRA shape of the same bug — Phase 1's not-started-only filter
  // re-picks it immediately.
  it('claim-issue-jira converges every Phase-3 release, preserving the pre-convergence default', () => {
    const current = DEFAULT_TASK_PROMPTS['claim-issue-jira'];
    const phase3 = phaseSection(current, 3);
    expect(phase3).toContain('CONVERGING status');
    expect(phase3).toContain('**Already fixed, superseded, or duplicated by another ticket**');
    expect(phase3).toContain('Done/Closed');
    expect(phase3).toContain('**Evidence gate:');
    expect(phase3).toContain('**Stale reference**');
    // The stale-reference park uses JIRA's held status + a Review Hub todo —
    // never a not-started status, which Phase 1 re-picks on the very next pass.
    expect(phase3).toContain('NOT back to a not-started status');
    expect(phase3).not.toContain('If ANY of these are true, release the claim and re-pick');

    // Newer prompt revisions append another outgoing default, so retain this
    // historical assertion by its Phase-3 behavior rather than its array slot.
    const preConvergence = PREVIOUS_DEFAULT_PROMPTS['claim-issue-jira'].findLast(
      (body) => phaseSection(body, 3).includes('transition the ticket back to its not-started status'),
    );
    expect(preConvergence).toBeDefined();
    expect(preConvergence).not.toBe(current);
  });

  // release-check READS the changelog rather than writing it, so its fix is the
  // mirror image: an unreleased set that lives in uncollected fragments must not
  // read as "not enough work accumulated for a release".
  it('release-check counts uncollected changelog fragments, preserving the outgoing default', () => {
    const current = DEFAULT_TASK_PROMPTS['release-check'];
    expect(current).toContain('per-branch fragments');
    expect(current).toContain('assembled');
    // release-check is a generic {appName} prompt — it runs against managed apps,
    // which have no `npm run changelog:preview`. It must send the agent to the
    // repo's own documented command, never name a PortOS script to run.
    expect(current).not.toContain('changelog:preview');
    expect(current).toContain('Do NOT guess a command name');

    const previous = PREVIOUS_DEFAULT_PROMPTS['release-check'];
    const outgoing = previous[previous.length - 1];
    expect(outgoing).not.toContain('per-branch fragments');
    expect(outgoing).not.toBe(current);
  });

  // refresh-local-llm-catalog is the one PortOS-ONLY prompt in this set (it
  // edits PortOS's own bundled catalog), so it may — and should — name the
  // fragment helper directly instead of describing the convention.
  it('refresh-local-llm-catalog uses the changelog:add fragment helper, preserving the outgoing default', () => {
    const current = DEFAULT_TASK_PROMPTS['refresh-local-llm-catalog'];
    expect(current).toContain('npm run changelog:add -- changed');
    // Line-wrap-insensitive — the prompt body is hard-wrapped.
    expect(current).toMatch(/Do NOT\s+append to `\.changelog\/NEXT\.md` by hand/);

    const previous = PREVIOUS_DEFAULT_PROMPTS['refresh-local-llm-catalog'];
    const outgoing = previous[previous.length - 1];
    expect(outgoing).not.toContain('changelog:add');
    expect(outgoing).toContain('Add a one-line entry to `{repoPath}/.changelog/NEXT.md`');
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
