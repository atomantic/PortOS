import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TASK_PROMPTS } from './taskPromptDefaults.js';
import { buildClaimFlowCompletionSection } from './promptSections/completion.js';

let scratch;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

// The emitted bash is the boundary: functions stand in for forge/loopback
// commands, while its JSON validation and real Git head check execute normally.
const fakeCommands = String.raw`
  curl() {
    printf 'admission\n' >> "$EVENTS"
    case " $* " in *' --fail '*) ;; *) return 99 ;; esac
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --data-binary ]; then shift; REQUEST="$1"; break; fi
      shift
    done
    printf '%s' "$REQUEST" | node -e 'const r=JSON.parse(require("node:fs").readFileSync(0,"utf8")); if(r.agentId!=="parent-example" || r.action!=="check" || r.token!==process.env.MERGE_ADMISSION_TOKEN) process.exit(1)' || return
    [ "$SCENARIO" != changed-after-admission ] || printf changed > "$HEAD_CHANGED"
    case "$SCENARIO" in
      stale-admission) printf '{"admitted":false,"reason":"lease-expired"}' ;;
      malformed-admission) printf 'unreadable' ;;
      transport-admission) return 7 ;;
      *) printf '{"admitted":true}' ;;
    esac
  }
  gh() {
    case "$1 $2" in
      'repo view')
        printf 'capability %s\n' "$*" >> "$EVENTS"
        case "$SCENARIO:$*" in
          unsupported:*mergeCommitAllowed*) printf false ;;
          unknown-capability:*) printf null ;;
          *) printf true ;;
        esac ;;
      'pr checks')
        printf 'checks\n' >> "$EVENTS"
        [ "$SCENARIO" != failed-checks ] ;;
      'pr view')
        case "$*" in *--json\ url*) printf 'https://github.com/example/base/pull/42'; return ;; esac
        COUNT=$(cat "$READ_COUNT"); COUNT=$((COUNT + 1)); printf '%s' "$COUNT" > "$READ_COUNT"
        printf 'read\n' >> "$EVENTS"
        [ "$SCENARIO" != unreadable-before ] || return 7
        if [ "$SCENARIO" = malformed-state ]; then printf unreadable; return; fi
        if [ "$SCENARIO" = unreadable-after ] && [ -s "$MUTATIONS" ]; then return 7; fi
        HEAD_SHA="$CI_VERIFIED_HEAD"
        if [ "$SCENARIO" = changed-head ] && [ "$COUNT" -gt 1 ]; then HEAD_SHA=ffffffffffffffffffffffffffffffffffffffff; fi
        if [ -f "$HEAD_CHANGED" ]; then HEAD_SHA=ffffffffffffffffffffffffffffffffffffffff; fi
        STATE=$(cat "$PR_STATE")
        case "$*" in
          *--json\ state\ -q*) printf '%s' "$STATE" ;;
          *) printf '{"state":"%s","headRefOid":"%s","mergeStateStatus":"CLEAN","isDraft":false,"reviewDecision":"APPROVED"}' "$STATE" "$HEAD_SHA" ;;
        esac ;;
      'pr merge')
        printf 'merge\n' >> "$EVENTS"
        printf '%s\n' "$*" >> "$MUTATIONS"
        case "$*" in *--match-head-commit\ "$CI_VERIFIED_HEAD"*) ;; *) return 99 ;; esac
        case "$SCENARIO" in
          unknown-ack|unreadable-after|provider-policy-denied) return 1 ;;
          queued) return 0 ;;
          lost-ack-merged) printf MERGED > "$PR_STATE"; return 1 ;;
          *) printf MERGED > "$PR_STATE" ;;
        esac ;;
      *) return 98 ;;
    esac
  }
`;

function runMerge(scenario, key = 'claim-issue', { registered = true, token = true } = {}) {
  scratch = mkdtempSync(join(tmpdir(), 'managed-merge-guard-'));
  const git = (...args) => execFileSync('git', args, { cwd: scratch, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('-c', 'user.name=Example', '-c', 'user.email=example@example.com', 'commit', '-q', '--allow-empty', '-m', 'reviewed');
  const head = git('rev-parse', 'HEAD');
  const completion = buildClaimFlowCompletionSection({ agentId: registered ? 'parent-example' : null });
  const admission = completion.match(/portos_check_merge_admission\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  const block = [...DEFAULT_TASK_PROMPTS[key].matchAll(/```bash\n([\s\S]*?)```/g)]
    .find(([, body]) => body.includes('# CI_VERIFIED_HEAD'))[1];
  const paths = Object.fromEntries(['EVENTS', 'MUTATIONS', 'READ_COUNT', 'PR_STATE', 'HEAD_CHANGED'].map(name => [name, join(scratch, name)]));
  writeFileSync(paths.READ_COUNT, '0');
  writeFileSync(paths.PR_STATE, scenario === 'already-merged' ? 'MERGED' : 'OPEN');
  const result = spawnSync('bash', ['-eu', '-c', `${fakeCommands}\n${admission}\n${block}`], {
    cwd: scratch, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, ...paths, SCENARIO: scenario, CI_VERIFIED_HEAD: head, MERGE_ADMISSION_TOKEN: token ? '00000000-0000-4000-8000-000000000001' : '' },
  });
  const lines = path => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { ...result, head, completion, events: lines(paths.EVENTS), mutations: lines(paths.MUTATIONS) };
}

// Windows is covered by renderer guards; this execution contract requires bash,
// matching managedMergePreservation.test.js's platform boundary.
describe.skipIf(process.platform === 'win32')('generated claim merge mutation guard (#12273)', () => {
  it.each(['plan-task', 'plan-task-claim', 'claim-issue'])('uses provider-enforced policy for a pinned %s merge', (key) => {
    const result = runMerge('success', key);
    expect(result.status, result.stderr).toBe(0);
    expect(result.mutations).toEqual([`pr merge https://github.com/example/base/pull/42 --merge --match-head-commit ${result.head}`]);
    expect(result.events.slice(-3)).toEqual(['read', 'merge', 'read']);
  });

  it.each(['unreadable-before', 'malformed-state', 'changed-head', 'unknown-capability'])('refuses %s before any mutation', (scenario) => {
    const result = runMerge(scenario);
    expect(result.status).not.toBe(0);
    expect(result.mutations).toEqual([]);
  });

  it.each(['unreadable-after', 'unknown-ack', 'queued', 'provider-policy-denied'])('never falls back after %s', (scenario) => {
    const result = runMerge(scenario);
    expect(result.status).not.toBe(0);
    expect(result.mutations).toHaveLength(1);
    expect(result.events.at(-1)).toBe('read');
  });

  it.each(['already-merged', 'lost-ack-merged'])('accepts only confirmed MERGED after %s', (scenario) => {
    const result = runMerge(scenario);
    expect(result.status, result.stderr).toBe(0);
    expect(result.mutations).toHaveLength(scenario === 'already-merged' ? 0 : 1);
  });

  it('selects the next verified allowed method without writing the disallowed method', () => {
    const result = runMerge('unsupported');
    expect(result.status, result.stderr).toBe(0);
    expect(result.mutations).toHaveLength(1);
    expect(result.mutations[0]).toContain('--squash --match-head-commit');
    expect(result.events.filter(event => event.startsWith('capability'))).toHaveLength(2);
    expect(result.events.slice(-3)).toEqual(['read', 'merge', 'read']);
  });

  it.each([{ registered: false }, { token: false }])('does not require a PortOS certificate for an authorized provider merge %j', (context) => {
    const result = runMerge('success', 'claim-issue', context);
    expect(result.status, result.stderr).toBe(0);
    expect(result.mutations).toHaveLength(1);
    expect(result.events).not.toContain('admission');
  });

  it('lets the provider decide whether an optional check blocks merging', () => {
    const result = runMerge('failed-checks');
    expect(result.status, result.stderr).toBe(0);
    expect(result.events).not.toContain('checks');
  });
});
