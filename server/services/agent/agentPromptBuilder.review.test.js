import { makeTask, installPromptBuilderHooks } from './agentPromptBuilder.test.fixture.js';
import { MANDATORY_DISPATCH_HINT_GUIDANCE } from '../../lib/dispatchLabels.js';
import { MANAGED_WORKTREE_CLEANUP_CONTRACT } from '../../lib/mergeGateContract.js';
import { buildMergeAdmissionSection } from '../promptSections/completion.js';
import { buildCliReviewerOutcomeInstructions, REVIEW_VERDICT_RUN_ID_TOKEN } from '../promptSections/reviewerOutcome.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PATHS } from '../../lib/fileUtils.js';
import { buildLightContextPrompt, buildAgentPrompt } from './agentPromptBuilder.js';
import { buildReviewLoopFollowUpSection } from '../promptSections/reviewLifecycle.js';
import { getCodeReviewDefaults } from '../codeReview.js';
import { loadSlashdoFile, loadSlashdoLib, loadSlashdoBundle, writeResolvedSlashdoBody } from '../../lib/slashdoLoader.js';
import { SLASHDO_INLINE_BUDGET_CHARS } from '../../lib/slashdoInvocation.js';
import { sanitizeTaskMetadata } from '../../lib/cos/cosTaskMetadata.js';

installPromptBuilderHooks();

describe('buildLightContextPrompt', () => {
  describe('what it includes', () => {
    it('runs slashdo-free local reviewers before GitHub PR creation, then keeps PR-side review after it', () => {
      // OpenCode TUI doesn't load Claude Code slash commands, so /do:pr / /do:push
      // would be uninvokable — but it runs `git`/`gh` and the reviewer CLIs fine,
      // so it owns the whole lifecycle in one session rather than handing off to a
      // `sys-rl-*` follow-up agent (#3733).
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { simplify: true, openPR: true, reviewLoop: true, reviewers: ['codex', 'copilot'] } }),
        '/r',
        { branchName: 'claim/issue-1', worktreePath: '/tmp/wt', baseBranch: 'main' },
        {
          isTui: true,
          providerId: 'opencode-ollama-tui',
          providerCommand: 'opencode',
          localAgentLoopBody: 'RECIPE: codex --sandbox read-only review --base <base>',
        });
      expect(prompt).toMatch(/## Completion Workflow/);
      // No slashdo commands anywhere in the workflow.
      expect(prompt).not.toMatch(/`\/do:pr`/);
      expect(prompt).not.toMatch(/`\/do:push`/);
      expect(prompt).not.toMatch(/`\/simplify`/);
      // /simplify is a Claude built-in — OpenCode gets the inline equivalent.
      expect(prompt).toMatch(/review your changed code for reuse, quality, and efficiency/i);
      // Commit → local review → push → PR → PR-side review → merge, all in this session.
      expect(prompt).toMatch(/git commit -m/);
      expect(prompt).toMatch(/### Local Review Before Opening the PR\/MR/);
      expect(prompt).toMatch(/RECIPE: codex --sandbox read-only review/);
      expect(prompt).toMatch(/git diff origin\/main\.\.\.HEAD/);
      expect(prompt).toMatch(/BRANCH=claim\/issue-1/);
      expect(prompt).toContain('publish_reviewed_branch -u "$PUSH_REMOTE" "$BRANCH"');
      expect(prompt).toContain('git config --get "branch.${BRANCH}.pushRemote"');
      expect(prompt).toContain('git config --get remote.pushDefault');
      expect(prompt).toContain('git fetch "$PUBLISH_REMOTE" "+refs/heads/${BRANCH}:refs/remotes/${PUBLISH_REMOTE}/${BRANCH}"');
      expect(prompt).toContain('PUBLISH_REMOTE="$PUSH_REMOTE"');
      expect(prompt).toContain('git merge-base --is-ancestor "$REMOTE_BRANCH_SHA" HEAD');
      expect(prompt).toContain('publish_reviewed_branch -u "$PUBLISH_REMOTE" "HEAD:refs/heads/$BRANCH"');
      expect(prompt).toContain('publish_reviewed_branch --force-with-lease="refs/heads/${BRANCH}:${REMOTE_BRANCH_SHA}" -u "$PUBLISH_REMOTE" "HEAD:refs/heads/$BRANCH"');
      expect(prompt).toContain('PUBLISH_ERROR="publish failed; refusing PR/MR"');
      expect(prompt).toContain('publish_reviewed_branch() { git push --no-follow-tags "$@" || { echo "$PUBLISH_ERROR" >&2; exit 1; }; }');
      expect(prompt).toContain('PUSH_OWNER=$(gh repo view "$(git remote get-url --push "$PUSH_REMOTE"');
      expect(prompt).toContain('[ -n "$PUSH_OWNER" ] || { echo "Missing PR head owner; refusing PR" >&2; exit 1; }');
      expect(prompt).toContain('PR_HEAD="$PUSH_OWNER:$BRANCH"');
      expect(prompt).toContain('portos-local-review-baseline');
      expect(prompt).toContain('refusing to overwrite them');
      expect(prompt).toContain('LOCAL_OVERALL_STATUS=review-blocked');
      expect(prompt).toContain('case "$LOCAL_OVERALL_STATUS" in clean|partial|review-blocked)');
      // A review that could not return a verdict is run-summary material, not PR content.
      expect(prompt).not.toContain('REVIEW_BLOCKED_COMMENT');
      expect(prompt).not.toContain('will not be merged until the required review completes');
      expect(prompt).toContain('do NOT post a PR/MR comment saying the review was unavailable or inconclusive');
      expect(prompt).toMatch(/PR_URL=\$\(gh pr create --base main --head "\$PR_HEAD"/);
      expect(prompt).toMatch(/## Review Loop/);
      expect(prompt).toMatch(/gh pr merge "\$PR_URL" --merge --match-head-commit <verified-head>/);
      expect(prompt).toContain('LOCAL_PHASE_START_SHA');
      expect(prompt).toContain('Cross-phase stop-mode gate');
      expect(prompt).toContain('`all` always runs the PR-side reviewers.');
      expect(prompt.indexOf('### Local Review Before Opening the PR/MR')).toBeLessThan(prompt.indexOf('publish_reviewed_branch -u "$PUSH_REMOTE" "$BRANCH"'));
      expect(prompt.indexOf('publish_reviewed_branch -u "$PUSH_REMOTE" "$BRANCH"')).toBeLessThan(prompt.indexOf('## Review Loop'));
      expect(prompt.indexOf('Required local-review merge gate')).toBeLessThan(prompt.indexOf('gh pr merge "$PR_URL" --merge --match-head-commit <verified-head>'));
      // The post-PR section receives only Copilot, never the local codex reviewer.
      expect(prompt.slice(prompt.indexOf('## Review Loop'))).not.toMatch(/CLI Reviewer Procedure/);
      // PortOS no longer promises to do any of it.
      expect(prompt).not.toMatch(/PortOS will push the branch/);
      // Sentinel handshake still drives completion; never tell the agent to run /quit.
      expect(prompt).toMatch(/\.agent-done/);
      expect(prompt).toMatch(/NOT run `\/quit`/);
      expect(prompt).not.toMatch(/^\s*\d+\.\s*`\/quit`/m);
    });

    it.each(['on-clean', 'on-findings'])('carries the %s stop mode across the local and PR-side phases', (reviewStopMode) => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex', 'copilot'], reviewStopMode } }),
        '/r',
        { branchName: 'claim/issue-1', worktreePath: '/tmp/wt', baseBranch: 'main' },
        { isTui: true, providerId: 'opencode-ollama-tui', providerCommand: 'opencode', localAgentLoopBody: 'RECIPE' });

      expect(prompt).toContain(`\`${reviewStopMode}\` skips the PR-side reviewers only when the local phase actually satisfied that stop condition`);
      expect(prompt).toContain('LOCAL_STOP_TRIGGERED=true');
      expect(prompt).toContain('git rev-parse --git-path portos-local-review-state');
      expect(prompt).toContain('. "$LOCAL_REVIEW_STATE_FILE"');
      expect(prompt).toContain('The original order places every local reviewer before every PR-side reviewer.');
      expect(prompt).toContain('skip the PR-side phase and record the configured stop-mode short-circuit as `partial`');
      expect(prompt).toContain('including when that verdict came from the final local reviewer');
    });

    it.each(['on-clean', 'on-findings'])('runs every PR-side reviewer for an interleaved %s order', (reviewStopMode) => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['copilot', 'codex'], reviewStopMode } }),
        '/r',
        { branchName: 'claim/issue-1', worktreePath: '/tmp/wt', baseBranch: 'main' },
        { isTui: true, providerId: 'opencode-ollama-tui', providerCommand: 'opencode', localAgentLoopBody: 'RECIPE' });

      expect(prompt).toContain('Cross-phase stop-mode gate');
      expect(prompt).toContain('Cross-phase stop-mode skip disabled');
      expect(prompt).toContain('Always run every PR-side reviewer');
      expect(prompt).not.toContain('skip the PR-side phase and record the configured stop-mode short-circuit');
      expect(prompt.slice(prompt.indexOf('## Review Loop'))).toContain('copilot');
    });

    it.each(['on-clean', 'on-findings'])('moves the tool-free ingress ahead of an interleaved %s order', (reviewStopMode) => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex', 'copilot', 'ollama'], reviewStopMode } }),
        '/r',
        { branchName: 'claim/issue-1', worktreePath: '/tmp/wt', baseBranch: 'main' },
        { isTui: true, providerId: 'opencode-ollama-tui', providerCommand: 'opencode', localAgentLoopBody: 'RECIPE' });

      expect(prompt).toContain('`ollama`=0, `codex`=1, `copilot`=2');
      expect(prompt).toContain('`LOCAL_STOP_INDEX` to that triggering local reviewer\'s position');
      expect(prompt).toContain('The original order places every local reviewer before every PR-side reviewer');
      expect(prompt).not.toContain('Cross-phase stop-mode skip disabled');
    });

    it('keeps an optional local reviewer non-blocking when its verdict is inconclusive', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex', 'copilot'], optionalReviewers: ['codex'] } }),
        '/r',
        { branchName: 'claim/issue-1', worktreePath: '/tmp/wt', baseBranch: 'main' },
        { isTui: true, providerId: 'opencode-ollama-tui', providerCommand: 'opencode', localAgentLoopBody: 'RECIPE' });

      expect(prompt).toContain('All local reviewers are optional, so missing/inconclusive results');
      expect(prompt).toContain('Set aggregate `LOCAL_OVERALL_STATUS=clean` for clean, configured capped with all accepted findings resolved, or optional inconclusive with no unresolved accepted findings');
      expect(prompt).toContain('missing/malformed/no-verdict result from one of them is non-blocking');
      expect(prompt).toContain('`codex` still run and their findings must still be fixed');
      expect(prompt).not.toContain('a missing, timed-out, malformed, or inconclusive local review is UNSATISFIED');
    });

    it('defers the local CLI recipe push until after the local review gate', () => {
      const localRecipe = [
        '### Maintained local recipe',
        '5. **Push verified changes**:',
        '   git push origin {BRANCH_NAME}',
        '   If the push fails: git pull --rebase --autostash && git push origin {BRANCH_NAME}',
        '6. **Re-loop or stop**:',
      ].join('\n');
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex'] } }),
        '/r',
        { branchName: 'claim/issue-1', worktreePath: '/tmp/wt', baseBranch: 'main' },
        {
          isTui: true,
          providerId: 'opencode-ollama-tui',
          providerCommand: 'opencode',
          localAgentLoopBody: localRecipe,
        });
      const localStart = prompt.indexOf('### Local Review Before Opening the PR/MR');
      const prPush = prompt.indexOf('publish_reviewed_branch -u "$PUSH_REMOTE" "$BRANCH"');
      const localSection = prompt.slice(localStart, prPush);

      expect(localStart).toBeGreaterThanOrEqual(0);
      expect(prPush).toBeGreaterThan(localStart);
      expect(localSection).toContain('Keep verified changes local');
      const recipeStart = localSection.indexOf('### Maintained local recipe');
      const recipeEnd = localSection.indexOf('\n\n4. Push', recipeStart);
      const renderedLocalRecipe = localSection.slice(recipeStart, recipeEnd);
      expect(renderedLocalRecipe).not.toMatch(/^\s*(?:git pull --rebase --autostash && )?git push\b/m);
      expect(renderedLocalRecipe).not.toContain('git push origin');
    });

    it('rewrites public-content CLI review recipes into supported safe procedures', () => {
      const unsafeRecipe = [
        'claude -p "$LOCAL_PROMPT" ${MODEL_FLAG[@]+"${MODEL_FLAG[@]}"} ${EFFORT_FLAG[@]+"${EFFORT_FLAG[@]}"} --dangerously-skip-permissions',
        'codex ${MODEL_FLAG[@]+"${MODEL_FLAG[@]}"} ${EFFORT_FLAG[@]+"${EFFORT_FLAG[@]}"} --sandbox danger-full-access -a never exec "$CODEX_APPLY_PROMPT"',
        'agy --dangerously-skip-permissions --model "$AGY_REVIEW_MODEL" --print-timeout 30m -p "$LOCAL_PROMPT"',
        'grok --permission-mode bypassPermissions ${MODEL_FLAG[@]+"${MODEL_FLAG[@]}"} ${EFFORT_FLAG[@]+"${EFFORT_FLAG[@]}"} -p "$LOCAL_PROMPT"',
        '"$REVIEW_BIN" -p --force --trust --output-format text --sandbox disabled ${MODEL_FLAG[@]+"${MODEL_FLAG[@]}"} "$LOCAL_PROMPT"',
      ].join('\n');
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['claude', 'antigravity', 'grok'], reviewerApplies: true } }),
        '/r',
        { branchName: 'claim/issue-1', worktreePath: '/tmp/wt', baseBranch: 'main' },
        {
          isTui: true,
          providerId: 'opencode-ollama-tui',
          providerCommand: 'opencode',
          localAgentLoopBody: unsafeRecipe,
        },
      );

      expect(prompt).toContain('--permission-mode plan --tools "" --disallowedTools "Bash,WebFetch,WebSearch,Write,Edit,NotebookEdit"');
      expect(prompt).toContain('--strict-mcp-config --mcp-config \'{"mcpServers":{}}\' --no-chrome --no-session-persistence');
      expect(prompt).toContain('< <(git diff "$BASE_BRANCH"...HEAD)');
      expect(prompt).not.toContain(unsafeRecipe.split('\n')[0]);
      expect(prompt).not.toContain(unsafeRecipe.split('\n')[1]);
      expect(prompt).not.toContain(unsafeRecipe.split('\n')[2]);
      expect(prompt).not.toContain(unsafeRecipe.split('\n')[3]);
      expect(prompt).not.toContain(unsafeRecipe.split('\n')[4]);
      expect(prompt).not.toContain('Reviewer unavailable: public-content review requires an enforced read-only mode');
      expect(prompt).toContain('--mode plan --sandbox');
      expect(prompt).toContain('--permission-mode plan --disable-web-search --no-subagents --single');
      expect(prompt).toContain('--sandbox read-only review');
      expect(prompt).toContain('--mode=ask');
      expect(prompt).toContain('Reviewer applies (off)');
      expect(prompt).not.toContain('--reviewer-applies');
    });

    it('rejects a future reviewer recipe when an unrestricted execution path survives sanitization', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex'] } }),
        '/r',
        { branchName: 'claim/issue-1', worktreePath: '/tmp/wt', baseBranch: 'main' },
        {
          isTui: true,
          providerId: 'opencode-ollama-tui',
          providerCommand: 'opencode',
          localAgentLoopBody: 'codex --sandbox workspace-write exec "$PUBLIC_DIFF"',
        },
      );

      expect(prompt).toContain('entire recipe was rejected');
      expect(prompt).not.toContain('workspace-write exec');
    });

    it('keeps reviewer-applies local fixes off the remote branch', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex'], reviewerApplies: true } }),
        '/r',
        { branchName: 'claim/issue-1', worktreePath: '/tmp/wt', baseBranch: 'main' },
        { isTui: true, providerId: 'opencode-ollama-tui', providerCommand: 'opencode', localAgentLoopBody: 'RECIPE' });
      const localStart = prompt.indexOf('### Local Review Before Opening the PR/MR');
      const prPush = prompt.indexOf('publish_reviewed_branch -u "$PUSH_REMOTE" "$BRANCH"');
      const localSection = prompt.slice(localStart, prPush);

      expect(localSection).toContain('keep fixes committed locally');
      expect(localSection).toContain('Do NOT push or open the PR/MR from this loop');
      expect(localSection).not.toContain('then verify, run tests, and push');
    });

    it('quotes the base branch in local review diff commands', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex'] } }),
        '/r',
        { branchName: 'claim/issue-1', worktreePath: '/tmp/wt', baseBranch: 'release; echo bad' },
        { isTui: true, providerId: 'opencode-ollama-tui', providerCommand: 'opencode', localAgentLoopBody: 'RECIPE' });

      expect(prompt).toContain("git diff 'origin/release; echo bad'...HEAD");
      expect(prompt).not.toContain('git diff origin/release; echo bad...HEAD');
    });

    it('runs local review before GitLab MR creation and leaves @ reviewers after it', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['ollama'], usernames: ['alice'] } }),
        '/r',
        { branchName: 'claim/issue-4363', worktreePath: '/tmp/wt', baseBranch: 'main', forgeCli: 'glab' },
        { isTui: true, providerId: 'opencode-ollama-tui', providerCommand: 'opencode' });

      expect(prompt).toMatch(/### Local Review Before Opening the PR\/MR/);
      expect(prompt).toMatch(/git diff origin\/main\.\.\.HEAD/);
      expect(prompt).toMatch(/PR_URL=\$\(glab mr create --source-branch claim\/issue-4363 --target-branch main/);
      expect(prompt).toMatch(/PR_NUMBER=\$\(glab mr view "\$PR_URL" --output json \| jq -r \.iid\)/);
      expect(prompt).toContain('LOCAL_OVERALL_STATUS=review-blocked');
      // Same on GitLab: the unavailable review goes in the summary, not an MR note.
      expect(prompt).not.toContain('REVIEW_BLOCKED_COMMENT');
      expect(prompt).not.toContain('will not be merged until the required review completes');
      expect(prompt).toContain('do NOT post a PR/MR comment saying the review was unavailable or inconclusive');
      expect(prompt).toMatch(/## Review Loop/);
      expect(prompt).toMatch(/request `@alice` as MR reviewer/);
      expect(prompt).toMatch(/glab mr merge \$PR_NUMBER --yes --remove-source-branch/);
      expect(prompt).toMatch(/glab mr view \$PR_NUMBER/);
      expect(prompt.indexOf('### Local Review Before Opening the PR/MR')).toBeLessThan(prompt.indexOf('glab mr create'));
      expect(prompt.indexOf('glab mr create')).toBeLessThan(prompt.indexOf('## Review Loop'));
      expect(prompt).not.toMatch(/gh pr (create|diff|merge|view|checks)/);
    });

    it('keeps routine pre-review rebase conflicts in the originating agent session', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex'] } }),
        '/r',
        { branchName: 'claim/x', worktreePath: '/tmp/wt', baseBranch: 'main' },
        { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' });

      // A routine base conflict stays in this agent's lifecycle. Previously the
      // local-review gate required an immediate abort, so cleanup opened the PR
      // and spawned a second [Review Loop] agent despite this ownership contract.
      expect(prompt).toMatch(/Resolve ordinary rebase conflicts in this same session/);
      expect(prompt).toMatch(/git rebase --continue/);
      expect(prompt).toMatch(/Abort and stop only when a conflict requires a product decision/);
      expect(prompt).not.toMatch(/Fetch\/base-resolution failure or conflicts block publication/);
    });

    // #3733 — the inline review loop is the SAME builder the `sys-rl-*` follow-up
    // agent gets, so the only things that can be wrong are its framing.
    it('the inline review loop never claims a reviewer was pre-requested', () => {
      // The follow-up variant says "the system already requested the initial
      // Copilot review". Inline, nothing did — the agent opened the PR seconds
      // ago, so that wording would have it poll forever for a review no one asked for.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['copilot'] } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt', baseBranch: 'main' },
        { isTui: true, providerId: 'antigravity-tui', providerCommand: 'agy' });
      expect(prompt).toMatch(/## Review Loop/);
      expect(prompt).not.toMatch(/## Review-Loop Follow-up/);
      expect(prompt).not.toMatch(/already requested the initial Copilot/);
      expect(prompt).toMatch(/request\/invoke each configured reviewer yourself/);
      // …and it must not tell an agent that never ran `/do:pr` that a saved
      // `/do:pr` default might have merged the PR for it.
      expect(prompt).not.toMatch(/a saved `\/do:pr` default can merge it/);
    });

    it('the inline review loop hands control back to the sentinel, not to an exit', () => {
      // The follow-up variant ends "Exit — the system will clean up your
      // worktree". A TUI run that exits there never writes `.agent-done` and
      // idles into a false timeout with the PR already merged.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex'] } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt', baseBranch: 'main' },
        { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' });
      expect(prompt).toMatch(/write the completion sentinel — the run is not done until you have/);
      expect(prompt).not.toMatch(/The system will clean up your worktree on exit/);
    });

    it('a CLI local-only review reaches the CI merge gate and exits without a sentinel', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex'] } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt', baseBranch: 'main' },
        { isTui: false, providerId: 'codex', providerCommand: 'codex' });
      expect(prompt).toMatch(/### Local Review Before Opening the PR\/MR/);
      expect(prompt).toMatch(/## Merge Gate/);
      expect(prompt).toMatch(/You are done — exit/);
      expect(prompt).toContain('The completed local phase survives later feedback pushes');
      expect(prompt).not.toContain('repeat the pre-PR local review phase');
      expect(prompt).toContain('the pre-PR local review is the only configured review');
      expect(prompt).toContain('Required local-review merge gate');
      expect(prompt).toContain('review-blocked');
      expect(prompt).not.toContain('No code review was requested for this task');
      expect(prompt).not.toMatch(/write the completion sentinel — the run is not done/);
    });

    it.each([
      { isTui: true, reviewerSource: 'inherited', resumed: false },
      { isTui: true, reviewerSource: 'explicit', resumed: true },
      { isTui: false, reviewerSource: 'inherited', resumed: false },
      { isTui: false, reviewerSource: 'explicit', resumed: true },
    ])('does not claim a local review for merge-only $reviewerSource reviewers (TUI=$isTui, resumed=$resumed)', ({ isTui, reviewerSource, resumed }) => {
      const metadata = { openPR: true, prCompletion: 'merge-on-green', reviewLoop: false,
        ...(reviewerSource === 'explicit' ? { reviewers: ['codex'], usernames: ['alice'] } : {}),
        ...(resumed ? { resumedFromAgentId: 'agent-prior' } : {}) };
      const defaults = reviewerSource === 'inherited' ? { reviewers: ['codex'], usernames: ['alice'] } : undefined;
      const prompt = buildLightContextPrompt(
        makeTask({ metadata }), '/r',
        { branchName: 'b', worktreePath: '/tmp/wt', baseBranch: 'main', existingBranch: resumed },
        { isTui, providerId: isTui ? 'codex-tui' : 'codex', providerCommand: 'codex',
          defaultReviewers: defaults?.reviewers, codeReviewDefaults: defaults });
      const gate = prompt.slice(prompt.indexOf('## Merge Gate'));

      expect(prompt).not.toContain('### Local Review Before Opening the PR/MR');
      expect(gate).toContain('No code review was requested for this task');
      expect(gate).not.toContain('has completed; no PR-side code reviewer');
      expect(gate).not.toContain('Required local-review merge gate');
      expect(gate).toContain('gh pr merge "$PR_URL" --merge --match-head-commit <verified-head>');
    });

    it('inlines the slashdo CLI-reviewer recipe into the inline loop, as the follow-up gets', () => {
      // Without it the agent only sees "invoke that CLI" and reverse-engineers
      // the invocation — the failure that had a codex agent burn a dozen
      // `--help` probes before stumbling into a working review call.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex'] } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt', baseBranch: 'main' },
        {
          isTui: true, providerId: 'codex-tui', providerCommand: 'codex',
          localAgentLoopBody: 'RECIPE: codex --sandbox read-only review --base <base>',
        });
      expect(prompt).toMatch(/### CLI Reviewer Procedure \(codex\)/);
      expect(prompt).toMatch(/RECIPE: codex --sandbox read-only review/);
      expect(prompt).toMatch(/verify isolation flags with the installed CLI/);
    });

    it('points an over-budget CLI-reviewer recipe at its staged file instead of pasting 40KB', () => {
      // The real recipe is ~40KB. A follow-up agent inlines it because the loop
      // is its whole job; an initial run is already carrying the actual task.
      const body = 'RECIPE HEADER\n' + 'x'.repeat(40_000);
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex'] } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt', baseBranch: 'main' },
        {
          isTui: true, providerId: 'codex-tui', providerCommand: 'codex',
          localAgentLoopBody: body,
          localAgentLoopBodyPath: '/data/slashdo-resolved/local-agent-review-loop.md',
        });
      expect(prompt).toMatch(/### CLI Reviewer Procedure \(codex\)/);
      expect(prompt).toMatch(/READ THAT FILE/);
      expect(prompt).toMatch(/\/data\/slashdo-resolved\/local-agent-review-loop\.md/);
      expect(prompt).not.toMatch(/RECIPE HEADER/);
      // This ceiling detects accidentally inlining the staged 40KB recipe.
      // Exclude the exact shared safety contracts and the checkout root prefix
      // embedded in doc pointers, whose independently tested required prose and
      // worktree path length are not recipe content; retain the original ceiling.
      expect(prompt).toContain(MANAGED_WORKTREE_CLEANUP_CONTRACT);
      const mergeGuidance = buildMergeAdmissionSection();
      expect(prompt).toContain(mergeGuidance);
      const withoutFixedGuidance = prompt.replace(MANDATORY_DISPATCH_HINT_GUIDANCE, '')
        .replace(MANAGED_WORKTREE_CLEANUP_CONTRACT, '')
        .replace(mergeGuidance, '')
        .replaceAll(PATHS.root, '');
      expect(withoutFixedGuidance.length).toBeLessThan(33_000);
    });

    it('renders the review-loop follow-up block when reviewLoopFollowUp is set', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { mergeHandoffMinQueuedRuns: 3,
          reviewLoopFollowUp: true,
          reviewLoopReviewers: ['copilot'],
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopPROwner: 'o',
          reviewLoopPRRepo: 'r',
          sourceTaskId: 'task-src-1',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { defaultReviewers: ['copilot'], agentId: 'registered-coordinator' });
      expect(prompt).toMatch(/## Review-Loop Follow-up/);
      expect(prompt).toContain('## Hosting-provider merge authority');
      expect(prompt).toContain('--match-head-commit <sha>');
      expect(prompt).not.toContain('/api/cos/merge-admission');
      expect(prompt).toMatch(/task-src-1/);
      expect(prompt).toMatch(/gh pr merge "https:\/\/github\.com\/o\/r\/pull\/9" --merge --match-head-commit <verified-head>/);
      // Pending CI retains ownership unless a measured durable successor accepts the exact head.
      expect(prompt).not.toMatch(/gh pr merge[^`\n]*--auto --merge/);
      expect(prompt).toContain('mergeHandoffMinQueuedRuns');
      expect(prompt).toContain('explicit persisted PortOS pending-merge receipt');
      // The immediate-merge fallback still verifies MERGED.
      expect(prompt).toMatch(/gh pr view "https:\/\/github\.com\/o\/r\/pull\/9" --json state/);
      expect(prompt).toMatch(/MERGED/);
      expect(prompt).not.toMatch(/## Completion Workflow/);
      // Default reviewer (copilot, lone) — names copilot but emits no `--review-with`
      // (the lone default needs no flag).
      expect(prompt).toMatch(/Reviewers \(in order\)\*\*: `copilot`/);
      expect(prompt).not.toMatch(/--review-with/);
      // Challenge protocol (#2471): the auto-invoke instructions + the challenge
      // endpoint for THIS source task must be present in the review-loop section.
      expect(prompt).toMatch(/Challenge protocol/);
      expect(prompt).toMatch(/api\/cos\/tasks\/task-src-1\/challenge/);
      expect(prompt).toMatch(/challenge\/resolve/);
    });

    it('renders a merge-only follow-up block (no reviewers) when reviewLoopMergeOnly is set', () => {
      // Review Loop off: PortOS opened the PR and spawned this follow-up purely to
      // land it. The block must gate on CI, never invoke or wait for a reviewer.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { mergeHandoffMinQueuedRuns: 3,
          reviewLoopFollowUp: true,
          reviewLoopMergeOnly: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopPROwner: 'o',
          reviewLoopPRRepo: 'r',
          reviewLoopReviewers: [],
          sourceTaskId: 'task-src-2',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' });
      expect(prompt).toMatch(/## Merge Follow-up/);
      expect(prompt).not.toMatch(/## Review-Loop Follow-up/);
      // CI is the gate, and the merge command matches the review-loop contract.
      expect(prompt).toMatch(/gh pr checks "https:\/\/github\.com\/o\/r\/pull\/9" --watch --fail-fast/);
      expect(prompt).toMatch(/gh pr merge "https:\/\/github\.com\/o\/r\/pull\/9" --merge --match-head-commit <verified-head>/);
      expect(prompt).not.toMatch(/gh pr merge[^`\n]*--auto --merge/);
      expect(prompt).toContain('mergeHandoffMinQueuedRuns');
      expect(prompt).toContain('explicit persisted PortOS pending-merge receipt');
      expect(prompt).toMatch(/gh pr view "https:\/\/github\.com\/o\/r\/pull\/9" --json state/);
      expect(prompt).toMatch(/MERGED/);
      // No reviewer defaulting may leak back in (normalizeReviewers would say copilot).
      expect(prompt).not.toMatch(/copilot/i);
      expect(prompt).not.toMatch(/Reviewers \(in order\)/);
      expect(prompt).not.toMatch(/--review-with/);
    });

    it('a merge-only follow-up on a GitLab MR gets glab commands, not gh', () => {
      // PortOS opens MRs via glab too, so a gh-only procedure would fail on the
      // first command after a full agent spawn.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopMergeOnly: true,
          reviewLoopPRUrl: 'https://gitlab.com/g/p/-/merge_requests/5',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 5,
          reviewLoopPRHost: 'gitlab.com',
          sourceTaskId: 'task-src-3',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' });
      expect(prompt).toMatch(/## Merge Follow-up/);
      // Addressed by MR IID — `glab mr merge` does not accept a URL.
      expect(prompt).toMatch(/glab mr merge 5 --yes --remove-source-branch/);
      expect(prompt).toMatch(/glab ci status/);
      expect(prompt).toMatch(/glab mr view 5/);
      expect(prompt).not.toMatch(/gh pr merge/);
      expect(prompt).not.toMatch(/gh pr checks/);
    });

    it('a merge-only follow-up on GitHub Enterprise keeps gh commands', () => {
      // Regression: classifying "host !== github.com" as GitLab handed a GHES PR
      // glab commands that cannot merge it.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopMergeOnly: true,
          reviewLoopPRUrl: 'https://github.example.com/o/r/pull/7',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 7,
          reviewLoopPRHost: 'github.example.com',
          sourceTaskId: 'task-src-4',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' });
      expect(prompt).toMatch(/gh pr merge "https:\/\/github\.example\.com\/o\/r\/pull\/7" --merge --match-head-commit <verified-head>/);
      expect(prompt).not.toMatch(/glab (?:issue|mr) /);
    });

    it('threads a non-default reviewer (claude) into the follow-up block via --review-with', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopPROwner: 'o',
          reviewLoopPRRepo: 'r',
          reviewLoopReviewers: ['claude'],
          sourceTaskId: 'task-src-2',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' });
      expect(prompt).toMatch(/--review-with claude/);
      // The Copilot-specific pre-request wording must be replaced when no
      // Copilot reviewer leads the order (the agent invokes the reviewers itself).
      expect(prompt).toMatch(/invoke each remaining configured reviewer yourself/);
    });

    it('threads an ordered multi-reviewer list + flags into the follow-up block', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['codex', 'antigravity', 'copilot'],
          reviewLoopStopMode: 'on-clean',
          reviewLoopReviewerApplies: true,
          sourceTaskId: 'task-src-3',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' });
      expect(prompt).toMatch(/--review-with codex,antigravity,copilot/);
      expect(prompt).toMatch(/--review-stop-on-clean/);
      expect(prompt).not.toMatch(/--reviewer-applies/);
      expect(prompt).toContain('Reviewer applies (off)');
      // Ordered run instruction.
      expect(prompt).toMatch(/For EACH reviewer in order/);
    });

    // Regression for the release-review finding: #2507 made only the reviewer
    // LIST default-aware on the inline `/do:pr` path (TUI + PR-owning claude-code
    // agents), leaving its four companions (usernames, optionalReviewers,
    // stopMode, reviewerApplies) resolved from task metadata alone. A task that
    // pins no reviewer config inherits the ordered roster, usernames, optional
    // markers, and stop mode. Public PR review deliberately overrides the fifth
    // field (reviewerApplies) to false.
    it('threads Code Review Defaults into inline /do:pr while forcing public review non-applying', () => {
      const codeReviewDefaults = {
        reviewers: ['codex', 'ollama'],
        usernames: ['alice'],
        optionalReviewers: ['ollama'],
        stopMode: 'on-findings',
        reviewerApplies: true,
      };
      const prompt = buildLightContextPrompt(
        // No reviewer config on the task itself — every field comes from defaults.
        makeTask({ metadata: { openPR: true, reviewLoop: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: true, defaultReviewers: codeReviewDefaults.reviewers, codeReviewDefaults });
      expect(prompt).toMatch(/--review-with ollama~opt,codex,@alice --review-stop-on-findings/);
      expect(prompt).not.toMatch(/--reviewer-applies/);
      // `codex` and `@alice` are still blocking, so the skip list stays whole.
      expect(prompt).toContain('skip the gate if the loop ended `timeout`, `error`, `inconclusive`, `review-blocked`, or `guardrail`');
      expect(prompt).not.toContain('Every configured reviewer is optional (`~opt`)');
    });

    it('tells an all-optional run not to invent a blocker from a missing verdict', () => {
      // `~opt` is honored by slashdo's loop, which excludes an optional pass's
      // missing verdict from the aggregate — so the run comes back `clean` and
      // merges on the ordinary gate. The prompt says so rather than relaxing
      // the skip list, because the ONE thing `~opt` never excuses is
      // `push-failed`, and that is precisely what an `inconclusive` aggregate
      // means when every reviewer is optional.
      const codeReviewDefaults = {
        reviewers: ['codex', 'ollama'],
        usernames: ['alice'],
        optionalReviewers: ['codex', 'ollama', '@alice'],
      };
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: true, defaultReviewers: codeReviewDefaults.reviewers, codeReviewDefaults });
      // The skip list is NOT relaxed — a surviving `inconclusive` still blocks.
      expect(prompt).toContain('skip the gate if the loop ended `timeout`, `error`, `inconclusive`, `review-blocked`, or `guardrail`');
      expect(prompt).toContain('Every configured reviewer is optional (`~opt`), so a reviewer that timed out or returned no verdict does NOT make the loop inconclusive');
      expect(prompt).toContain('An `inconclusive` that still appears despite that is a real blocker (fixes committed but not pushed), and stands.');
    });

    it('keeps the full skip list when NO reviewer is configured', () => {
      // An empty list is "nobody reviews", not "every reviewer is optional" —
      // there is no `~opt` decision to honor, so the default gate stands.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: true });
      expect(prompt).toContain('skip the gate if the loop ended `timeout`, `error`, `inconclusive`, `review-blocked`, or `guardrail`');
      expect(prompt).not.toContain('Every configured reviewer is optional (`~opt`)');
    });

    it('threads per-reviewer ~max caps from the Code Review Defaults into the inline /do:pr', () => {
      const codeReviewDefaults = {
        reviewers: ['codex', 'ollama'],
        optionalReviewers: ['ollama'],
        // `~opt` first, then `~max=<n>` — slashdo's canonical order.
        reviewerMaxRounds: { ollama: 1, codex: 2 },
      };
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: true, defaultReviewers: codeReviewDefaults.reviewers, codeReviewDefaults });
      expect(prompt).toMatch(/--review-with ollama~opt~max=1,codex~max=2/);
    });

    it('lets a task-level ~max cap map override the defaults', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['ollama'], reviewerMaxRounds: { ollama: 0 } } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: true, defaultReviewers: ['ollama'], codeReviewDefaults: { reviewers: ['ollama'], reviewerMaxRounds: { ollama: 3 } } });
      // `0` = loop until clean, and it must not be mistaken for "no cap".
      expect(prompt).toMatch(/--review-with ollama~max=0/);
    });

    it('does not leak default usernames/stop-mode/reviewer-applies when no Code Review Defaults are set', () => {
      // Same task, no `codeReviewDefaults` option → the empty install default,
      // which emits none of the reviewer flags.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: true });
      expect(prompt).not.toMatch(/@alice/);
      expect(prompt).not.toMatch(/~opt/);
      expect(prompt).not.toMatch(/--review-stop-on-findings/);
      expect(prompt).not.toMatch(/--reviewer-applies/);
    });

    it('appends GitHub reviewer usernames as @user tokens and instructs requesting them', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['copilot'],
          reviewLoopReviewerUsernames: ['CodeReviewbot'],
          sourceTaskId: 'task-src-u',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' });
      expect(prompt).toMatch(/--review-with copilot,@CodeReviewbot/);
      // The agent is told to request the username as a PR reviewer that gates merge.
      expect(prompt).toMatch(/--add-reviewer/);
      expect(prompt).toMatch(/@CodeReviewbot/);
    });

    it('drives a username-only review loop (no keyed reviewer)', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          // Empty keyed list (e.g. copilot stripped on a non-GitHub forge) + a username.
          reviewLoopReviewers: [],
          reviewLoopReviewerUsernames: ['CodeReviewbot'],
          sourceTaskId: 'task-src-uonly',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' });
      expect(prompt).toMatch(/--review-with @CodeReviewbot/);
      // No copilot fallback re-introduced.
      expect(prompt).not.toMatch(/--review-with copilot/);
    });

    it('threads a reviewer-keyed model map into each CLI invocation', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['codex', 'claude'],
          reviewLoopReviewerModels: { codex: 'gpt-5.6-sol', claude: 'qwen2.5:7b' },
          sourceTaskId: 'task-src-map',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' });
      expect(prompt).toMatch(/codex --model gpt-5\.6-sol/);
      expect(prompt).toMatch(/claude --model qwen2\.5:7b/);
    });

    it('threads a reviewer-keyed effort map onto each CLI invocation, in that CLI-specific flag form', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['codex', 'claude', 'antigravity'],
          reviewLoopReviewerModels: { codex: 'gpt-5.6-sol' },
          reviewLoopReviewerEfforts: { codex: 'high', claude: 'xhigh', antigravity: 'low' },
          sourceTaskId: 'task-src-effort',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' });
      // codex takes a config pair; claude and agy take --effort. The model pin
      // and the effort ride the SAME command line when both are set.
      expect(prompt).toMatch(/codex --model gpt-5\.6-sol -c model_reasoning_effort=high/);
      expect(prompt).toMatch(/claude --effort xhigh/);
      // `antigravity` names no executable — the invocation must say `agy`.
      expect(prompt).toMatch(/agy --effort low/);
      expect(prompt).not.toMatch(/antigravity --effort/);
    });

    it('folds a cursor effort into its --model — the follow-up must never print `cursor-agent --effort`', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['cursor'],
          reviewLoopReviewerModels: { cursor: 'gpt-5' },
          reviewLoopReviewerEfforts: { cursor: 'max' },
          sourceTaskId: 'task-src-cursor-effort',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' });
      // This is a literal command line the agent runs; `cursor-agent --effort max`
      // exits non-zero, so the level has to ride the model variant instead.
      expect(prompt).toMatch(/cursor-agent --model gpt-5\[effort=max\]/);
      expect(prompt).not.toMatch(/cursor-agent[^\n]*--effort/);
    });

    it('names a pinned local-LLM effort as an /api/code-review/local body key', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['ollama'],
          reviewLoopReviewerEfforts: { ollama: 'high' },
          sourceTaskId: 'task-src-local-effort',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' });
      expect(prompt).toContain('"effort": "high"');
      // The effort has no slashdo suffix, so it must NOT leak into the flag string.
      expect(prompt).not.toMatch(/--review-with[^\n]*effort/);
    });

    it('spells out per-reviewer ~max round caps in the follow-up loop instructions', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['codex', 'ollama'],
          // `bogus` isn't in the list, so it must not reach the prose.
          reviewLoopReviewerMaxRounds: { ollama: 1, codex: 0, copilot: 3 },
          sourceTaskId: 'task-src-max',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' });
      // This prompt drives the loop in prose, so the cap has to be stated —
      // the `equiv` flag string alone wouldn't bind the agent.
      expect(prompt).toMatch(/Round caps \(~max\)/);
      expect(prompt).toMatch(/`ollama` → 1 round/);
      // 0 renders as unlimited, not as a zero-round budget.
      expect(prompt).toMatch(/`codex` → loop until clean/);
      expect(prompt).not.toMatch(/`copilot` →/);
      // And the equivalent flag string carries the same suffixes.
      expect(prompt).toMatch(/--review-with ollama~max=1,codex~max=0/);
    });

    it('omits the round-caps note when no cap is configured', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['codex', 'ollama'],
          sourceTaskId: 'task-src-nomax',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' });
      expect(prompt).not.toMatch(/Round caps \(~max\)/);
      expect(prompt).toMatch(/--review-with ollama,codex/);
    });

    it('threads a configured claude model (Ollama-backed reviewer) via the map', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['claude'],
          reviewLoopReviewerModels: { claude: 'qwen2.5:7b' },
          sourceTaskId: 'task-src-cl',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' });
      expect(prompt).toMatch(/claude --model qwen2\.5:7b/);
    });

    it('threads each configured model id verbatim, without env-dependent mapping', () => {
      // Even with Bedrock enabled in the process env, the prompt layer does NOT
      // map a bare Claude tier to a Bedrock id — it has only a providerId, not the
      // merged spawn env, and the reviewer CLI is spawned by the agent, not PortOS.
      // The user configures the exact id their environment needs (free-text field).
      const prev = process.env.CLAUDE_CODE_USE_BEDROCK;
      process.env.CLAUDE_CODE_USE_BEDROCK = '1';
      try {
        const prompt = buildLightContextPrompt(
          makeTask({ metadata: {
            reviewLoopFollowUp: true,
            reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
            reviewLoopPRBranch: 'b',
            reviewLoopPRNumber: 9,
            reviewLoopReviewers: ['claude', 'codex'],
            reviewLoopReviewerModels: { claude: 'us.anthropic.claude-opus-4-8', codex: 'gpt-5.6-sol' },
            sourceTaskId: 'task-src-verbatim',
          }}),
          '/r',
          { branchName: 'b', worktreePath: '/tmp/wt' });
        // Both ids appear exactly as configured — no Bedrock rewrite, no mangling.
        expect(prompt).toMatch(/claude --model us\.anthropic\.claude-opus-4-8/);
        expect(prompt).toMatch(/codex --model gpt-5\.6-sol/);
      } finally {
        if (prev === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
        else process.env.CLAUDE_CODE_USE_BEDROCK = prev;
      }
    });

    it('falls back to the legacy codex-scalar metadata key when the map is absent', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['codex'],
          // Written by an older install: only the codex scalar, no map.
          reviewLoopCodexModel: 'gpt-5.6-sol',
          sourceTaskId: 'task-src-cx',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' });
      expect(prompt).toMatch(/codex --model gpt-5\.6-sol/);
    });

    it('does not leak a stale legacy codex scalar into a claude-only review', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['claude'],
          // Stale model tier from a prior codex config — the legacy fallback maps
          // it to codex, which is NOT among the reviewers, so it must not leak.
          reviewLoopCodexModel: 'gpt-5.6-sol',
          sourceTaskId: 'task-src-noncx',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' });
      expect(prompt).not.toMatch(/--model gpt-5\.6-sol/);
    });

    it('emits the local-LLM bridge instruction when a local-LLM reviewer is configured', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['lmstudio'],
          sourceTaskId: 'task-src-llm',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' });
      // The agent gets a copy-pasteable stdin bridge pipeline — no HTTP route,
      // no instance-password gate — without it the lmstudio/ollama reviewer
      // kinds have no way to actually run a review.
      expect(prompt).toMatch(/Pipe the diff into PortOS's local-review bridge/);
      expect(prompt).not.toMatch(/\/api\/code-review\/local/);
      expect(prompt).toMatch(/gh pr diff 9 \| jq/);
      expect(prompt).toMatch(/run-local-code-review\.mjs/);
      expect(prompt).toMatch(/timeoutMs: 1800000/);
      expect(prompt).toContain('select(.ok == true and (.verdict == "clean" or .verdict == "findings")) | .findings');
      expect(prompt).toMatch(/Never treat an absent or malformed response as clean/);
    });

    it('threads reviewer into the TUI Completion Workflow as `/do:pr --review-with <reviewer>`', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, simplify: true, reviewers: ['antigravity'] } }),
        '/r',
        { branchName: 'feat', worktreePath: '/tmp/wt' },
        { isTui: true });
      expect(prompt).toMatch(/`\/do:pr --review-with antigravity --no-merge`/);
    });

    it('allows merging on `partial` in the completion merge step when a stop-mode is set', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex', 'antigravity'], reviewStopMode: 'on-clean' } }),
        '/r',
        { branchName: 'feat', worktreePath: '/tmp/wt' },
        { isTui: true });
      expect(prompt).toMatch(/--review-stop-on-clean/);
      // `partial` is a successful stop-mode short-circuit → mergeable.
      expect(prompt).toMatch(/`partial`/);
    });

    it('does NOT merge on `partial` under the default stop-mode (all)', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex', 'antigravity'] } }),
        '/r',
        { branchName: 'feat', worktreePath: '/tmp/wt' },
        { isTui: true });
      expect(prompt).toContain('reports `clean` (or `too-large`)');
      expect(prompt).not.toContain('reports `clean`, `partial`');
    });

    it('tells the follow-up to request Copilot at its turn when copilot does NOT lead the list', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopReviewers: ['codex', 'copilot'],
          sourceTaskId: 'task-src-4',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' });
      // Must instruct requesting Copilot at its turn — not claim a pre-request happened.
      expect(prompt).toMatch(/request a Copilot review when you reach its turn/);
      expect(prompt).not.toMatch(/already requested the initial Copilot/);
    });
  });
});

// #2507 — CoS app-improve/self-improvement tasks pin no `reviewers`, so the
// review loop must resolve them from the install's Code Review Defaults
// (settings.codeReview.reviewers) rather than a hardcoded reviewer,
// which stalls on installs without GitHub Copilot review enabled.
describe('buildAgentPrompt — reviewer resolution honors Code Review Defaults (#2507)', () => {
  const reviewLoopTask = () => makeTask({ metadata: { openPR: true, reviewLoop: true, simplify: false } });
  // Claude Code CLI keeps the slashdo /do:pr workflow, so the reviewer list
  // surfaces as `--review-with <csv>` in the completion block.
  const claudeCliOpts = { providerType: 'cli', providerId: 'claude-code', providerCommand: 'claude' };

  it('threads a configured default reviewer list into --review-with when the task pins none', async () => {
    vi.mocked(getCodeReviewDefaults).mockResolvedValueOnce({ reviewers: ['claude', 'codex'] });
    const prompt = await buildAgentPrompt(reviewLoopTask(), {}, '/r', { branchName: 'b', worktreePath: '/tmp/wt' }, claudeCliOpts);
    expect(prompt).toMatch(/`\/do:pr --review-with claude,codex --no-merge`/);
    // The stalling copilot default must not leak in.
    expect(prompt).not.toMatch(/--review-with copilot/);
  });

  it('keeps review opt-in when no default is configured', async () => {
    vi.mocked(getCodeReviewDefaults).mockResolvedValueOnce({ reviewers: [] });
    const prompt = await buildAgentPrompt(reviewLoopTask(), {}, '/r', { branchName: 'b', worktreePath: '/tmp/wt' }, claudeCliOpts);
    // An empty default is suppressed from --review-with, so /do:pr runs without
    // an explicit reviewer flag.
    expect(prompt).toMatch(/`\/do:pr`/);
    expect(prompt).not.toMatch(/--review-with claude/);
  });

  it('a task-pinned reviewer list still wins over the configured default', async () => {
    vi.mocked(getCodeReviewDefaults).mockResolvedValueOnce({ reviewers: ['claude', 'codex'] });
    const task = makeTask({ metadata: { openPR: true, reviewLoop: true, simplify: false, reviewers: ['grok'] } });
    const prompt = await buildAgentPrompt(task, {}, '/r', { branchName: 'b', worktreePath: '/tmp/wt' }, claudeCliOpts);
    expect(prompt).toMatch(/`\/do:pr --review-with grok --no-merge`/);
    expect(prompt).not.toMatch(/--review-with claude/);
  });

  it('keeps review opt-in when the settings read fails', async () => {
    vi.mocked(getCodeReviewDefaults).mockRejectedValueOnce(new Error('settings unavailable'));
    const prompt = await buildAgentPrompt(reviewLoopTask(), {}, '/r', { branchName: 'b', worktreePath: '/tmp/wt' }, claudeCliOpts);
    expect(prompt).toMatch(/`\/do:pr`/);
    expect(prompt).not.toMatch(/--review-with claude/);
  });
});

describe('buildReviewLoopFollowUpSection — CLI reviewer procedure inlining', () => {
  // The follow-up agent used to receive only "invoke that CLI to review this
  // branch's diff", so a headless codex agent reverse-engineered the `claude`
  // invocation with a dozen probe calls. It now inlines slashdo's local-agent
  // review-loop recipe (passed in as localAgentLoopBody) whenever a spawnable
  // CLI reviewer is configured — never for a copilot/@github-only loop.
  const LOOP_SENTINEL = 'SLASHDO-LOCAL-AGENT-LOOP-BODY-SENTINEL';
  const baseMeta = {
    reviewLoopFollowUp: true,
    sourceTaskId: 't1',
    reviewLoopPRUrl: 'https://github.com/o/r/pull/1',
    reviewLoopPRBranch: 'feature-b',
  };

  for (const verbose of [false, true]) {
    it(`inlines the CLI Reviewer Procedure for a CLI reviewer (verbose=${verbose})`, () => {
      const out = buildReviewLoopFollowUpSection(
        { ...baseMeta, reviewLoopReviewers: ['claude'] },
        { verbose, localAgentLoopBody: LOOP_SENTINEL }
      );
      expect(out).toContain('CLI Reviewer Procedure');
      expect(out).toContain(LOOP_SENTINEL);
      // The vague invocation step points the agent at the inlined procedure.
      expect(out).toMatch(/verify isolation flags with the installed CLI/i);
    });
  }

  it('records a no-verdict local reviewer result when its JSON response has no findings', () => {
    const out = buildReviewLoopFollowUpSection(
      { ...baseMeta, reviewLoopReviewers: ['ollama'] },
      { verbose: false, localAgentLoopBody: null }
    );
    expect(out).toMatch(/Local reviewer failed:/);
    expect(out).toMatch(/exit 1 # Never treat an absent or malformed response as clean/);
  });

  it('keeps an inline merge gate closed when the pre-PR required review is unavailable', () => {
    const out = buildReviewLoopFollowUpSection(
      { ...baseMeta, reviewLoopReviewers: ['copilot'] },
      {
        verbose: false,
        inlineExitStep: 'write the completion sentinel and stop',
        localPhaseReviewers: ['codex'],
        localPhaseReviewRequired: true,
      }
    );
    expect(out).toContain('Required local-review merge gate');
    expect(out).toContain('LOCAL_OVERALL_STATUS=review-blocked');
    expect(out).toContain('leave it open');
    expect(out.indexOf('Required local-review merge gate')).toBeLessThan(out.indexOf('gh pr merge'));
  });

  it('does NOT inline the procedure for a copilot-only loop', () => {
    const out = buildReviewLoopFollowUpSection(
      { ...baseMeta, reviewLoopReviewers: ['copilot'] },
      { verbose: false, localAgentLoopBody: LOOP_SENTINEL }
    );
    expect(out).not.toContain('CLI Reviewer Procedure');
    expect(out).not.toContain(LOOP_SENTINEL);
  });

  it('degrades gracefully when no loop body is available (CLI reviewer, body null)', () => {
    const out = buildReviewLoopFollowUpSection(
      { ...baseMeta, reviewLoopReviewers: ['codex'] },
      { verbose: false, localAgentLoopBody: null }
    );
    expect(out).not.toContain('CLI Reviewer Procedure');
    // Still emits the base invocation step so the loop is not broken.
    expect(out).toMatch(/codex/);
  });

  it('keeps review scope focused while requiring every accepted finding to be resolved', () => {
    const out = buildReviewLoopFollowUpSection(
      { ...baseMeta, reviewLoopReviewers: ['claude'] },
      { verbose: false, localAgentLoopBody: null }
    );
    expect(out).toContain('directly affected contracts only');
    expect(out).toContain('verified defects and established-convention violations with concrete evidence');
    expect(out).toContain('including nits and warnings');
    expect(out).toContain('Resolve every accepted finding; severity only determines sequencing');
    expect(out).toContain('Do not broaden into an unrelated repository-wide audit');
    expect(out).toContain('A round cap never makes unresolved accepted findings clean');
  });
});

describe('buildReviewLoopFollowUpSection — reviewer slug → CLI binary', () => {
  // `antigravity` is the stored, federated reviewer slug; the executable is
  // `agy`. The prompt used to say "Invoke the `antigravity` CLI" and list a
  // fixed "codex / antigravity / claude / grok" bullet, so a follow-up agent ran
  // `command -v antigravity`, found nothing, announced "the only configured
  // reviewer is antigravity … isn't available", self-reviewed, and merged.
  const baseMeta = {
    reviewLoopFollowUp: true,
    sourceTaskId: 't1',
    reviewLoopPRUrl: 'https://github.com/o/r/pull/1',
    reviewLoopPRBranch: 'feature-b',
  };
  const build = (reviewers, verbose = false) => buildReviewLoopFollowUpSection(
    { ...baseMeta, reviewLoopReviewers: reviewers },
    { verbose, localAgentLoopBody: null },
  );

  for (const verbose of [false, true]) {
    it(`names \`agy\`, not \`antigravity\`, as the command to invoke (verbose=${verbose})`, () => {
      const out = build(['antigravity'], verbose);
      expect(out).toContain('Invoke `agy` (the `antigravity` reviewer) to review');
      expect(out).not.toMatch(/Invoke the `antigravity` CLI/);
    });
  }

  it('heads the multi-reviewer bullet with the configured binaries and maps the slug', () => {
    const out = build(['antigravity', 'codex']);
    expect(out).toContain('**agy / codex**');
    expect(out).toContain('the `antigravity` reviewer runs the `agy` binary (there is no `antigravity` command)');
    // The old hardcoded roster listed reviewers this loop never configured.
    expect(out).not.toContain('codex / antigravity / claude / grok');
  });

  it('omits the slug→binary note when every reviewer names its own binary', () => {
    const out = build(['codex', 'claude']);
    expect(out).toContain('**codex / claude**');
    expect(out).not.toContain('Reviewer slug → command');
  });

  it('titles the inlined CLI procedure with the configured binaries', () => {
    const out = buildReviewLoopFollowUpSection(
      { ...baseMeta, reviewLoopReviewers: ['antigravity'] },
      { verbose: false, localAgentLoopBody: 'BODY' },
    );
    expect(out).toContain('### CLI Reviewer Procedure (agy)');
  });

  // The second half of the failure: a reviewer that cannot run is not a clean
  // review, but the agent substituted its own self-review and merged anyway.
  it('forbids merging on a self-review when a reviewer binary is missing', () => {
    const out = build(['antigravity']);
    expect(out).toContain('command -v agy');
    expect(out).toMatch(/do NOT substitute your own self-review and do NOT merge/);
  });

  it('emits no missing-CLI note for a loop with no spawnable CLI reviewer', () => {
    const out = build(['copilot', 'ollama']);
    expect(out).not.toContain('Missing reviewer CLI');
    expect(out).not.toContain('command -v');
  });
});

// -----------------------------------------------------------------------------
// Slashdo prompt-size controls (#3110)
// -----------------------------------------------------------------------------
// Expanded bodies run 38KB–317KB. Two reductions: prune the reviewer variants a
// run can't reach, then hand a file-tools host a path for whatever is still over
// budget. `api` providers have no file tools and keep inlining. Assertions are on
// SHAPE (pointer present / body present / prune set passed), never on the
// submodule's text.
describe('buildAgentPrompt — slashdo prompt-size controls', () => {
  const OVER = 'B'.repeat(SLASHDO_INLINE_BUDGET_CHARS + 500);
  const UNDER = '# Small Procedure\n\nStep one.';
  const slashdoTask = (metadata = {}) => makeTask({
    description: 'Audit the widget API',
    metadata: { slashdoCommand: 'review', ...metadata },
  });

  beforeEach(() => {
    // mockReset (not just a new return value): several tests here assert the
    // staging helper was NOT called, so a prior test's call must not leak in.
    vi.mocked(loadSlashdoLib).mockReset();
    vi.mocked(loadSlashdoLib).mockResolvedValue(null);
    vi.mocked(writeResolvedSlashdoBody).mockReset();
    vi.mocked(loadSlashdoFile).mockReset();
    vi.mocked(loadSlashdoFile).mockResolvedValue(OVER);
    vi.mocked(writeResolvedSlashdoBody).mockResolvedValue('/install/data/cos/slashdo-resolved/review.md');
    vi.mocked(getCodeReviewDefaults).mockResolvedValue({ reviewers: ['copilot'] });
  });

  it('hands a file-tools host a pointer instead of the body when over budget', async () => {
    const prompt = await buildAgentPrompt(
      slashdoTask(), {}, '/r', null,
      { providerType: 'cli', providerId: 'codex' });
    expect(prompt).toContain('/install/data/cos/slashdo-resolved/review.md');
    expect(prompt).not.toContain(OVER);
    // Still actionable — the invocation survives.
    expect(prompt).toContain('do-review');
  });

  it('stages a small deferred entrypoint so its references resolve outside the managed app', async () => {
    const body = 'Read lib/audit.md when auditing.';
    const files = { 'audit.md': 'Audit procedure' };
    vi.mocked(loadSlashdoBundle).mockResolvedValueOnce({ body, files });
    const prompt = await buildAgentPrompt(
      slashdoTask({ reviewers: ['codex'] }), {}, '/managed-app', null,
      { providerType: 'cli', providerId: 'codex' });
    expect(writeResolvedSlashdoBody).toHaveBeenCalledWith('review', body, { files });
    expect(prompt).toContain('/install/data/cos/slashdo-resolved/review.md');
    expect(prompt).toContain('relative to the file containing that reference');
    expect(prompt).not.toContain(body);
    expect(prompt).toContain('--review-with codex');
  });

  it('rebuilds an eager body if a deferred bundle cannot be staged', async () => {
    vi.mocked(loadSlashdoBundle).mockResolvedValueOnce({
      body: 'Read lib/audit.md', files: { 'audit.md': 'Audit procedure' },
    });
    vi.mocked(loadSlashdoFile).mockResolvedValueOnce('Complete inline audit procedure');
    vi.mocked(writeResolvedSlashdoBody).mockRejectedValueOnce(new Error('EACCES'));
    const prompt = await buildAgentPrompt(
      slashdoTask(), {}, '/managed-app', null,
      { providerType: 'cli', providerId: 'codex' });
    expect(prompt).toContain('Complete inline audit procedure');
    expect(prompt).not.toContain('Read lib/audit.md');
  });

  it('rejects a missing required procedure instead of dispatching an invocation alone', async () => {
    vi.mocked(loadSlashdoBundle).mockRejectedValueOnce(new Error('Missing required slashdo library: audit.md'));
    await expect(buildAgentPrompt(
      slashdoTask(), {}, '/r', null,
      { providerType: 'cli', providerId: 'codex' })).rejects.toThrow('Missing required slashdo library');
  });

  it('inlines the body when it is under budget, and stages no file', async () => {
    vi.mocked(loadSlashdoFile).mockResolvedValue(UNDER);
    const prompt = await buildAgentPrompt(
      slashdoTask(), {}, '/r', null,
      { providerType: 'cli', providerId: 'codex' });
    expect(prompt).toContain('Step one.');
    expect(vi.mocked(writeResolvedSlashdoBody)).not.toHaveBeenCalled();
  });

  it('inlines for an api provider regardless of size — no file tools to read with', async () => {
    const prompt = await buildAgentPrompt(slashdoTask(), {}, '/r', null,
      { providerType: 'api', providerId: 'some-http-provider' });
    expect(prompt).toContain(OVER);
    expect(vi.mocked(writeResolvedSlashdoBody)).not.toHaveBeenCalled();
  });

  it('warns once, naming the command and size, when an api provider is handed an over-budget body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await buildAgentPrompt(slashdoTask(), {}, '/r', null,
      { providerType: 'api', providerId: 'some-http-provider' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('review');
    expect(warn.mock.calls[0][0]).toMatch(/\d+KB/);
    warn.mockRestore();
  });

  it('falls back to inlining when the resolved copy cannot be staged', async () => {
    vi.mocked(writeResolvedSlashdoBody).mockRejectedValue(new Error('EACCES'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prompt = await buildAgentPrompt(
      slashdoTask(), {}, '/r', null,
      { providerType: 'cli', providerId: 'codex' });
    // A failed write must not silently drop the procedure.
    expect(prompt).toContain(OVER);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('stages a push-free local reviewer recipe for the inline workflow', async () => {
    const body = [
      'RECIPE HEADER',
      '5. **Push verified changes**:',
      '   git push origin {BRANCH_NAME}',
      '   If the push fails: git pull --rebase --autostash && git push origin {BRANCH_NAME}',
      '6. **Re-loop or stop**:',
      '   continue',
      'x'.repeat(SLASHDO_INLINE_BUDGET_CHARS + 500),
    ].join('\n');
    vi.mocked(loadSlashdoLib).mockResolvedValue(body);
    vi.mocked(writeResolvedSlashdoBody).mockResolvedValue('/install/data/cos/slashdo-resolved/local-agent-review-loop.md');

    const prompt = await buildAgentPrompt(
      makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex'] } }),
      {}, '/r',
      { branchName: 'claim/issue-1', worktreePath: '/tmp/wt', baseBranch: 'main' },
      { providerType: 'tui', providerId: 'opencode-tui', providerCommand: 'opencode' });
    const [, stagedBody] = vi.mocked(writeResolvedSlashdoBody).mock.calls.at(-1);

    expect(prompt).toContain('/install/data/cos/slashdo-resolved/local-agent-review-loop.md');
    expect(stagedBody).toContain('Keep verified changes local');
    expect(stagedBody).not.toMatch(/^\s*(?:git pull --rebase --autostash && )?git push\b/m);
  });

  it('keeps the sanitized reviewer recipe inline when staging fails', async () => {
    vi.mocked(loadSlashdoLib).mockResolvedValue([
      'RECIPE FALLBACK HEADER',
      '5. **Push verified changes**:',
      '   git push origin {BRANCH_NAME}',
      '6. **Re-loop or stop**:',
      '   continue',
      'x'.repeat(SLASHDO_INLINE_BUDGET_CHARS + 500),
    ].join('\n'));
    vi.mocked(writeResolvedSlashdoBody).mockRejectedValue(new Error('EACCES'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const prompt = await buildAgentPrompt(
      makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex'] } }),
      {}, '/r',
      { branchName: 'claim/issue-1', worktreePath: '/tmp/wt', baseBranch: 'main' },
      { providerType: 'tui', providerId: 'opencode-tui', providerCommand: 'opencode' });

    expect(prompt).toContain('RECIPE FALLBACK HEADER');
    expect(prompt).toContain('Keep verified changes local');
    expect(prompt).not.toContain('git push origin {BRANCH_NAME}');
    expect(prompt).not.toContain('/install/data/cos/slashdo-resolved/');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('inlining instead: EACCES'));
    warn.mockRestore();
  });

  // A pinned reviewer list carries the effort as slashdo's own `~effort=<level>`
  // suffix, so the section states it ONCE — on the pin. The prose instruction is
  // for the unpinned case, where the workflow resolves reviewers itself.
  it('carries a pinned reviewer effort on the --review-with token, not as prose', async () => {
    const prompt = await buildAgentPrompt(
      slashdoTask({ reviewers: ['codex'], reviewerEfforts: { codex: 'high' } }),
      {}, '/r', null,
      { providerType: 'cli', providerId: 'codex' });
    expect(prompt).toContain('codex~effort=high');
    // Restating it would have the agent pass `-c model_reasoning_effort=high` a
    // second time, on top of the one slashdo's loop already passes.
    expect(prompt).not.toContain('Invoke each reviewer CLI at its pinned reasoning effort');
  });

  it('states the effort in prose when the section pins no reviewer list', async () => {
    // Reviewers spanning every loop variant prune nothing, so no `--review-with`
    // is emitted — the pin's only route to the CLI the workflow spawns is prose.
    const prompt = await buildAgentPrompt(
      slashdoTask({
        reviewers: ['copilot', 'codex', 'ollama'],
        usernames: ['octocat'],
        reviewerEfforts: { codex: 'high' },
      }),
      {}, '/r', null,
      { providerType: 'cli', providerId: 'codex' });
    // (the note's own prose mentions the flag — assert on the pin line instead)
    expect(prompt).not.toContain('Run this workflow with');
    expect(prompt).toContain('`codex -c model_reasoning_effort=high`');
  });

  it('names only the reviewers this run actually resolved', async () => {
    // A stale pin for a reviewer that isn't in the list (set on another task, or
    // left behind by the Code Review Defaults) must not tell the agent to pass a
    // flag to a CLI it never invokes.
    const prompt = await buildAgentPrompt(
      slashdoTask({ reviewers: ['codex'], reviewerEfforts: { codex: 'high', claude: 'xhigh' } }),
      {}, '/r', null,
      { providerType: 'cli', providerId: 'codex' });
    expect(prompt).toContain('codex~effort=high');
    expect(prompt).not.toContain('claude~effort=xhigh');
    expect(prompt).not.toContain('--effort xhigh');
  });

  it('adds no effort sentence when no reviewer pins one', async () => {
    const prompt = await buildAgentPrompt(
      slashdoTask({ reviewers: ['codex'] }), {}, '/r', null,
      { providerType: 'cli', providerId: 'codex' });
    expect(prompt).not.toContain('pinned reasoning effort');
  });
  describe('reviewer-variant pruning', () => {
    const skipArg = () => vi.mocked(loadSlashdoFile).mock.calls.at(-1)[1].skipIncludes;

    it('prunes unreachable reviewer loops when the task pins its reviewers', async () => {
      await buildAgentPrompt(
        slashdoTask({ reviewers: ['codex'] }), {}, '/r', null,
        { providerType: 'cli', providerId: 'codex' });
      const skipped = skipArg();
      expect(skipped).toContain('copilot-review-loop');
      expect(skipped).not.toContain('local-agent-review-loop');
    });

    it('pins --review-with alongside a pruned body so the run matches what it got', async () => {
      const prompt = await buildAgentPrompt(
        slashdoTask({ reviewers: ['codex'] }), {}, '/r', null,
        { providerType: 'cli', providerId: 'codex' });
      expect(prompt).toContain('--review-with codex');
    });

    it('prunes from the install Code Review Defaults when the task pins nothing', async () => {
      vi.mocked(getCodeReviewDefaults).mockResolvedValue({ reviewers: ['ollama'] });
      await buildAgentPrompt(
        slashdoTask(), {}, '/r', null,
        { providerType: 'cli', providerId: 'codex' });
      expect(skipArg()).not.toContain('ollama-review-loop');
    });

    it('prunes NOTHING on an unconfigured install', async () => {
      // An empty default cannot authorize pruning or pin a reviewer on an
      // install that has not opted into code review.
      vi.mocked(getCodeReviewDefaults).mockResolvedValue({ reviewers: [] });
      const prompt = await buildAgentPrompt(
        slashdoTask(), {}, '/r', null,
        { providerType: 'cli', providerId: 'codex' });
      expect(skipArg()).toEqual([]);
      expect(prompt).not.toContain('--review-with');
    });

    // Both regressions found by the codex review pass: hand-rolling the reviewer
    // resolution here diverged from the three helpers the rest of the prompt uses,
    // so the body was pruned for a different reviewer than the run resolves.
    it('honors the legacy single `reviewer` string, not just the reviewers array', async () => {
      vi.mocked(getCodeReviewDefaults).mockResolvedValue({ reviewers: ['ollama'] });
      const prompt = await buildAgentPrompt(
        slashdoTask({ reviewer: 'codex' }), {}, '/r', null,
        { providerType: 'cli', providerId: 'codex' });
      // Legacy `reviewer` beats the defaults, so the CLI loop is kept and the
      // local-model loop (the default's) is what gets dropped.
      const skipped = skipArg();
      expect(skipped).not.toContain('local-agent-review-loop');
      expect(skipped).toContain('ollama-review-loop');
      expect(prompt).toContain('--review-with codex');
    });

    it('carries the ~opt marker for an optional reviewer inherited from the defaults', async () => {
      vi.mocked(getCodeReviewDefaults).mockResolvedValue({
        reviewers: ['codex'], optionalReviewers: ['codex'],
      });
      const prompt = await buildAgentPrompt(
        slashdoTask(), {}, '/r', null,
        { providerType: 'cli', providerId: 'codex' });
      // Pinning a non-blocking reviewer as blocking changes the merge gate.
      expect(prompt).toContain('--review-with codex~opt');
    });


    it('treats an explicitly-OPTIONAL lone copilot as configured and keeps its ~opt', async () => {
      // Nothing defaults to `~opt`, so marking copilot optional is a deliberate
      // "review but don't gate the merge" choice. Suppressing the pin here would
      // let the run fall back to slashdo's saved BLOCKING copilot default —
      // silently tightening the merge gate. buildReviewWithArgs makes the same
      // exemption to its lone-default suppression.
      vi.mocked(getCodeReviewDefaults).mockResolvedValue({
        reviewers: ['copilot'], optionalReviewers: ['copilot'],
      });
      const prompt = await buildAgentPrompt(
        slashdoTask(), {}, '/r', null,
        { providerType: 'cli', providerId: 'codex' });
      expect(prompt).toContain('--review-with copilot~opt');
      expect(skipArg()).not.toContain('copilot-review-loop');
    });

    it('prunes NOTHING when the defaults read fails', async () => {
      vi.mocked(getCodeReviewDefaults).mockRejectedValue(new Error('unreadable'));
      await buildAgentPrompt(
        slashdoTask(), {}, '/r', null,
        { providerType: 'cli', providerId: 'codex' });
      expect(skipArg()).toEqual([]);
    });

    it('keeps the @login loop when a username reviewer gates the PR', async () => {
      await buildAgentPrompt(
        slashdoTask({ reviewers: ['codex'], usernames: ['octocat'] }), {}, '/r', null,
        { providerType: 'cli', providerId: 'codex' });
      const skipped = skipArg();
      expect(skipped).not.toContain('github-reviewer-loop');
      // Two review sources ⇒ the multi-reviewer wrapper is reachable.
      expect(skipped).not.toContain('multi-reviewer-loop');
    });
  });

  // slashdo puts an explicit `--review-with` above every saved or inherited
  // default (lib/review-config-defaults.md), and PortOS passes `slashdoArgs`
  // through verbatim — so the flag in the invocation is what the run WILL use.
  // Pruning the body (or pinning a reviewer) from task metadata instead is how a
  // prompt requests one reviewer, omits its loop, and names another. #6261.
  describe('an explicit --review-with in slashdoArgs', () => {
    const skipArg = () => vi.mocked(loadSlashdoFile).mock.calls.at(-1)[1].skipIncludes;

    it('prunes for the explicit flag, not for the task metadata behind it', async () => {
      const prompt = await buildAgentPrompt(
        slashdoTask({ slashdoArgs: '--review-with ollama', reviewers: ['codex'] }),
        {}, '/r', null,
        { providerType: 'cli', providerId: 'codex' });
      const skipped = skipArg();
      // The reviewer the run will actually invoke keeps its loop…
      expect(skipped).not.toContain('ollama-review-loop');
      // …and the metadata reviewer's is what drops out.
      expect(skipped).toContain('local-agent-review-loop');
      // Naming codex here would tell the agent to use a reviewer whose loop was
      // just pruned away.
      expect(prompt).not.toContain('--review-with codex');
    });

    it('preserves an explicit `none` opt-out inherited from Code Review Defaults', async () => {
      vi.mocked(getCodeReviewDefaults).mockResolvedValue({ reviewers: ['codex'] });
      const prompt = await buildAgentPrompt(
        slashdoTask({ slashdoArgs: '--review-with none' }), {}, '/r', null,
        { providerType: 'cli', providerId: 'codex' });
      expect(prompt).toContain('--review-with none');
      // `none` sets REVIEW_AGENTS=[] with no fallback, so no loop is reachable.
      expect(skipArg()).toEqual(expect.arrayContaining([
        'copilot-review-loop', 'github-reviewer-loop', 'local-agent-review-loop',
        'ollama-review-loop', 'multi-reviewer-loop',
      ]));
      expect(prompt).not.toContain('--review-with codex');
    });

    it('states each suffix exactly once — in the invocation, not again as a pin', async () => {
      const args = '--review-with agy[gemini-3.8-flash]~opt~max=1~effort=medium';
      const prompt = await buildAgentPrompt(
        // The metadata names a DIFFERENT loop variant, so a metadata-derived pin
        // would both prune away agy's loop and add a second set of suffixes.
        slashdoTask({ slashdoArgs: args, reviewers: ['ollama'], reviewerEfforts: { ollama: 'high' } }),
        {}, '/r', null,
        { providerType: 'cli', providerId: 'codex' });
      expect(prompt).not.toContain('--review-with ollama');
      expect(skipArg()).not.toContain('local-agent-review-loop');
      expect(prompt.split('~effort=').length - 1).toBe(1);
      expect(prompt.split('~max=').length - 1).toBe(1);
      expect(prompt.split('~opt').length - 1).toBe(1);
    });

    it('reads the equals form the same as the spaced one', async () => {
      const prompt = await buildAgentPrompt(
        slashdoTask({ slashdoArgs: '--review-with=ollama', reviewers: ['codex'] }),
        {}, '/r', null,
        { providerType: 'cli', providerId: 'codex' });
      expect(skipArg()).not.toContain('ollama-review-loop');
      expect(skipArg()).toContain('local-agent-review-loop');
      expect(prompt).not.toContain('--review-with codex');
    });

    it('prunes and pins NOTHING when the explicit value cannot be safely read', async () => {
      vi.mocked(getCodeReviewDefaults).mockResolvedValue({ reviewers: ['codex'] });
      const prompt = await buildAgentPrompt(
        // A slug outside the grammar PortOS mirrors: guessing which loop it needs
        // is how the run loses the one it reaches.
        slashdoTask({ slashdoArgs: '--review-with some-future-reviewer' }),
        {}, '/r', null,
        { providerType: 'cli', providerId: 'codex' });
      expect(skipArg()).toEqual([]);
      expect(prompt).toContain('--review-with some-future-reviewer');
      expect(prompt).not.toContain('--review-with codex');
    });

    it('leaves the metadata contract in charge when the args name no reviewer', async () => {
      const prompt = await buildAgentPrompt(
        slashdoTask({ slashdoArgs: '--issues 42', reviewers: ['codex'] }),
        {}, '/r', null,
        { providerType: 'cli', providerId: 'codex' });
      expect(prompt).toContain('--review-with codex');
      expect(skipArg()).toContain('copilot-review-loop');
    });
  });
});

describe('TUI reviewLoopFollowUp completion instructions', () => {
  it('appends .agent-done sentinel instructions for TUI agents on follow-up tasks', async () => {
    const task = {
      id: 'task-flw-1',
      description: 'Follow-up merge PR',
      metadata: {
        useWorktree: true,
        openPR: false,
        reviewLoopFollowUp: true,
        reviewLoopMergeOnly: true,
        reviewLoopPRUrl: 'https://github.com/org/repo/pull/42',
        reviewLoopPRBranch: 'cos/task-orig/agent-1',
        providerId: 'antigravity-tui',
        providerCommand: 'agy',
      }
    };
    const worktreeInfo = { worktreePath: '/tmp/wt-1', branchName: 'cos/task-orig/agent-1' };
    const prompt = await buildLightContextPrompt(task, '/repo', worktreeInfo, {
      isTui: true,
      providerId: 'antigravity-tui',
      providerCommand: 'agy',
    });
    expect(prompt).toContain('## Completion Handoff');
    expect(prompt).toContain('cat > "/tmp/wt-1/.agent-done"');
    expect(prompt).toContain('## Summary');
  });

  // Agents that never take a worktree (issue-filing / reasoning task types run
  // with `useWorktree: false`) all write into the SAME primary checkout. A shared
  // `.agent-done` there lets two concurrent runs overwrite each other's summary,
  // and lets whichever poll ticks first finalize the other agent's run on a
  // sentinel it never wrote — so the filename carries the agent id.
  it('names the completion sentinel per agent instance so worktree-less runs cannot collide', async () => {
    const worktreelessTask = (id) => ({
      id,
      description: 'File an issue',
      metadata: { useWorktree: false, openPR: false, discardWorktree: true, providerId: 'claude-code-tui', providerCommand: 'claude' }
    });
    const build = (taskId, agentId) => buildLightContextPrompt(
      worktreelessTask(taskId), '/repo', null,
      { isTui: true, providerId: 'claude-code-tui', providerCommand: 'claude', agentId }
    );

    const first = await build('task-a', 'agent-aaa111');
    const second = await build('task-b', 'agent-bbb222');

    expect(first).toContain('/repo/.agent-done-agent-aaa111');
    expect(second).toContain('/repo/.agent-done-agent-bbb222');
    expect(first).not.toContain('/repo/.agent-done-agent-bbb222');
    // No instruction may still point at the shared filename.
    expect(first).not.toMatch(/\.agent-done(?![-\w])/);
  });
});

it.each(['api', 'cli', 'tui'])('gives extended Deep precedence over customized quick limits on %s providers', async providerType => {
  const task = makeTask({ description: 'Stop after one finding', metadata: { auditDepth: 'deep', auditWorkflow: 'extended-v1', app: 'example', prompt: 'Only inspect five candidates', analysisType: 'security' } });
  const prompt = await buildAgentPrompt(task, {}, '/r', null, { providerType, agentId: 'deep-agent' });
  expect(prompt.startsWith('## Deep audit — extended regular audit')).toBe(true);
  expect(prompt).toContain('fix multiple worthwhile issues');
  expect(prompt).toContain('partial coverage is valid');
});

it('preserves the extended marker in split prompts, refuses unknown versions and legacy launches', async () => {
  const metadata = sanitizeTaskMetadata({ auditDepth: 'deep', auditWorkflow: 'extended-v1' });
  expect(metadata).toMatchObject({ auditDepth: 'deep', auditWorkflow: 'extended-v1' });
  const prompt = await buildAgentPrompt(makeTask({ metadata: { ...metadata, app: 'example' } }), {}, '/r', null, { providerType: 'cli', split: true, agentId: 'deep-agent' });
  expect(prompt.systemPrompt.startsWith('## Deep audit — extended regular audit')).toBe(true);
  await expect(buildAgentPrompt(makeTask({ metadata: { auditDepth: 'deep', deepAuditId: 'old' } }), {}, '/r')).rejects.toThrow('read-only');
  expect(() => sanitizeTaskMetadata({ auditDepth: 'deep', auditWorkflow: 'future-v9' })).toThrow('Unsupported');
  expect(() => sanitizeTaskMetadata({ auditDepth: 'deep', auditWorkflow: 'extended-v1', deepAuditId: 'old' })).toThrow('cannot reuse');
});

it.each(['api', 'cli', 'tui'])('requires a per-agent disposition checkpoint and final register on %s audits', async providerType => {
  const task = makeTask({ description: 'Stop after one fix', metadata: { auditDispositionVersion: '1', analysisType: 'security', app: 'example' } });
  const prompt = await buildAgentPrompt(task, {}, '/r', null, { providerType, agentId: 'audit-example' });
  expect(prompt).toContain('.agent-audit-findings-audit-example.json');
  expect(prompt).toContain('AUDIT_FINDINGS_JSON');
  expect(prompt.indexOf('## Required finding disposition register')).toBeLessThan(prompt.indexOf('Stop after one fix'));
});

describe('CLI review-outcome run id (#16572)', () => {
  // The claim block is generated into the task before the run exists, so the
  // verdict report's agentId is a slot the builder fills at spawn time.
  const task = makeTask({ description: `Claim work\n\n${buildCliReviewerOutcomeInstructions(['codex'])}` });

  it.each(['api', 'tui'])('fills the run id on the %s path', async (providerType) => {
    const prompt = await buildAgentPrompt(task, {}, '/repo', null, { providerType, providerCommand: 'claude', agentId: 'agent-example' });
    expect(prompt).toContain('"agentId":"agent-example"');
    expect(prompt).toContain('`changedLines`');
    expect(prompt).not.toContain(REVIEW_VERDICT_RUN_ID_TOKEN);
  });

  it('drops the run-id sentence rather than sending a placeholder when the run has no usable id', async () => {
    const prompt = await buildAgentPrompt(task, {}, '/repo', null, { providerType: 'api', agentId: 'bad id/../x' });
    expect(prompt).toContain('/api/code-review/cli-outcome');
    expect(prompt).not.toContain('"agentId"');
    expect(prompt).not.toContain(REVIEW_VERDICT_RUN_ID_TOKEN);
  });
});
