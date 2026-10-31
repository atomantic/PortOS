import { afterEach, describe, expect, it } from 'vitest';
import { writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeGitSandbox, destroyGitSandbox } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';
import { DEFAULT_TASK_PROMPTS } from './taskPromptDefaults.js';
import { buildCiMergeGateSteps } from './promptSections/reviewLifecycle.js';
import { driveToMerge } from './branchReconcile.js';
import { MANAGED_WORKTREE_CLEANUP_CONTRACT } from '../lib/mergeGateContract.js';
import { resolveSwarmBlock } from './cosTaskPreStepBlocks.js';

let sandbox;
afterEach(async () => {
  if (sandbox) await destroyGitSandbox(sandbox.scratch);
  sandbox = null;
});

it('pins every managed GitHub merge attempt and defers removal until preservation', () => {
  const rendered = [
    ...['plan-task', 'plan-task-claim', 'claim-issue'].map(key => DEFAULT_TASK_PROMPTS[key]),
    driveToMerge('42'),
    resolveSwarmBlock('claim-issue', 2),
  ];
  for (const text of rendered) {
    const commands = text.match(/gh pr merge[^\n`]+/g);
    expect(commands?.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).not.toContain('--delete-branch');
      expect(command).toContain('--match-head-commit');
    }
    const proofOrder = ['hosting provider reports the exact PR as MERGED', 'Release any coordination lease actually held', 'Recheck live claim/worktree ownership', 'checkouts/review', 'Inspect the returned local identity', 'checkouts/retire', 'matching persisted retirement receipt'];
    const positions = proofOrder.map(marker => text.indexOf(marker, text.indexOf('**Managed-worktree')));
    expect(positions.every(at => at >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(text).toContain('A refusal keeps an unresolved retirement obligation, never a shell fallback');
    expect(text).not.toMatch(/git (?:worktree (?:remove|unlock|prune)|branch -[dD]|push[^\n]*--delete)/);
  }
});

// Exercise the emitted shell with a synthetic gh that models the linked-checkout
// teardown of CLI 2.102.0. No forge or host repository is touched. The renderer
// assertions above remain platform-independent; shell execution needs bash.
describe.skipIf(process.platform === 'win32')('managed merge shell preservation (#12133)', () => {
  it.each([false, true])('retains ignored artifacts and a late unpublished commit=%s through merge fallbacks', async (lateCommit) => {
    sandbox = await makeGitSandbox({ origin: true });
    const { scratch, repo, origin } = sandbox;
    const branch = 'claim/issue-42';
    const checkout = join(scratch, 'claim');
    await execGit(['worktree', 'add', '-b', branch, checkout, 'main'], repo);
    await writeFile(join(checkout, '.gitignore'), 'ignored-results.json\n');
    await execGit(['add', '.gitignore'], checkout);
    await execGit(['commit', '-m', 'reviewed change'], checkout);
    const verifiedHead = (await execGit(['rev-parse', 'HEAD'], checkout)).stdout.trim();
    await execGit(['push', 'origin', branch], checkout);
    const sentinel = join(checkout, 'ignored-results.json');
    await writeFile(sentinel, 'unique test evidence');
    expect((await execGit(['status', '--porcelain'], checkout)).stdout).toBe('');
    if (lateCommit) {
      await writeFile(join(checkout, 'late.txt'), 'unpublished work');
      await execGit(['add', 'late.txt'], checkout);
      await execGit(['commit', '-m', 'late unpublished change'], checkout);
    }
    const localHead = (await execGit(['rev-parse', 'HEAD'], checkout)).stdout.trim();
    const calls = join(scratch, 'calls');
    const state = join(scratch, 'state');
    await writeFile(state, 'OPEN');
    // Use a shell function rather than a PATH binary so the fake cannot leak
    // into another concurrent test or invoke the installed gh accidentally.
    const fakeGh = `
      portos_check_merge_admission() { return 0; }
      gh() {
        if [ "$1" = repo ]; then
          case "$*" in *rebaseMergeAllowed*) printf true ;; *) printf false ;; esac
          return
        fi
        if [ "$2" = checks ]; then return 0; fi
        if [ "$2" = view ]; then
          case "$*" in
            *--json\\ url*) printf '%s' 'https://github.com/example/repo/pull/42' ;;
            *) printf '{"state":"%s","headRefOid":"%s","mergeStateStatus":"CLEAN","isDraft":false,"reviewDecision":"APPROVED"}' "$(cat "$MERGE_STATE")" "$CI_VERIFIED_HEAD" ;;
          esac
          return
        fi
        printf '%s\\n' "$*" >> "$MERGE_CALLS"
        case "$*" in *--match-head-commit\\ "$CI_VERIFIED_HEAD"*) ;; *) return 99 ;; esac
        git --git-dir="$FAKE_ORIGIN" update-ref refs/heads/main "$CI_VERIFIED_HEAD" || return
        case "$*" in
          *--delete-branch*)
            git worktree remove --force "$CLAIM_CHECKOUT" || return
            git update-ref -d refs/heads/claim/issue-42 || return ;;
        esac
        printf '%s' MERGED > "$MERGE_STATE"
      }
    `;
    const prompt = DEFAULT_TASK_PROMPTS['claim-issue'];
    const mergeBlock = [...prompt.matchAll(/```bash\n([\s\S]*?)```/g)].find(([, body]) => body.includes('# CI_VERIFIED_HEAD'))[1];
    const result = spawnSync('bash', ['-eu', '-c', `${fakeGh}\n${mergeBlock}`], {
      cwd: checkout,
      env: { ...process.env, CI_VERIFIED_HEAD: verifiedHead, MERGE_STATE: state, MERGE_CALLS: calls, FAKE_ORIGIN: origin, CLAIM_CHECKOUT: checkout },
    });
    expect(result.status).toBe(lateCommit ? 1 : 0);
    expect(await readFile(state, 'utf8')).toBe(lateCommit ? 'OPEN' : 'MERGED');
    if (!lateCommit) expect((await readFile(calls, 'utf8')).trim().split('\n')).toHaveLength(1);
    expect(await readFile(sentinel, 'utf8')).toBe('unique test evidence');
    expect((await execGit(['rev-parse', branch], repo)).stdout.trim()).toBe(localHead);
    await access(join(checkout, '.git'));
    if (lateCommit) expect(await readFile(join(checkout, 'late.txt'), 'utf8')).toBe('unpublished work');
  });
});


it('the shared cleanup contract requires API review and receipts rather than an executable deletion recipe', () => {
  expect(MANAGED_WORKTREE_CLEANUP_CONTRACT).toContain('review:{prUrl,digest:<fresh review.digest>,acceptSuperseded:<reviewed boolean>}');
  expect(MANAGED_WORKTREE_CLEANUP_CONTRACT).toContain('Private Git state, refs, reflogs and recoverable objects stay in the repository');
  expect(MANAGED_WORKTREE_CLEANUP_CONTRACT).toContain('MERGED at its exact head is disposable');
  expect(MANAGED_WORKTREE_CLEANUP_CONTRACT).toContain('an uncertain response needs receipt/inventory readback before retry');
  expect(MANAGED_WORKTREE_CLEANUP_CONTRACT).toContain('If a supported retirement endpoint is unavailable or a separate branch-only remnant remains, retain it with the precise blocker for branch reconciliation.');
  expect(MANAGED_WORKTREE_CLEANUP_CONTRACT).toContain('Do not enqueue another cleanup coordinator against your own active checkout.');
  expect(MANAGED_WORKTREE_CLEANUP_CONTRACT).not.toMatch(/`git |git worktree remove|git branch -[dD]/);
});

it('completion merges preserve the checkout for the PortOS cleanup owner', () => {
  const text = buildCiMergeGateSteps(1, { prRef: '42' }).lines.join('\n');
  expect(text).not.toContain('--delete-branch');
  expect(text).toContain('--match-head-commit <verified-head>');
  expect(text).toContain('Local teardown is API-only');
  expect(text).toContain('A refusal keeps an unresolved retirement obligation');
  expect(text).toContain('MERGED at its exact head is disposable');
  expect(text).toContain("service's exact-head lease");
});
