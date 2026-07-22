import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import {
  DEFAULT_TASK_PROMPTS,
  PROMPT_VERSIONS,
  REFERENCE_WATCH_AUDITED_VERSION,
  PREVIOUS_DEFAULT_PROMPTS,
} from './taskPromptDefaults.js';
import { PORTOS_API_URL } from '../lib/ports.js';

// Hash snapshot of every exported prompt body and version. This pins the
// cross-install prompt-upgrade contract (see CLAUDE.md "Distribution model"):
// a refactor of the taskPromptDefaults/ split cannot silently alter a prompt
// byte, and an INTENTIONAL prompt change forces the author through this file —
// where the rule is: bump PROMPT_VERSIONS, append the outgoing default to
// PREVIOUS_DEFAULT_PROMPTS, then regenerate the snapshot:
//
//   cd server && node --input-type=module -e "
//   import('./services/taskPromptDefaults.js').then(async (m) => {
//     const { PORTOS_API_URL } = await import('./lib/ports.js');
//     const { createHash } = await import('crypto');
//     const norm = (s) => s.split(PORTOS_API_URL).join('{{PORTOS_API_URL}}');
//     const md5 = (s) => createHash('md5').update(norm(s), 'utf8').digest('hex');
//     const out = {
//       DEFAULT_TASK_PROMPTS: Object.fromEntries(Object.entries(m.DEFAULT_TASK_PROMPTS).map(([k, v]) => [k, md5(v)])),
//       PROMPT_VERSIONS: m.PROMPT_VERSIONS,
//       REFERENCE_WATCH_AUDITED_VERSION: m.REFERENCE_WATCH_AUDITED_VERSION,
//       PREVIOUS_DEFAULT_PROMPTS: Object.fromEntries(Object.entries(m.PREVIOUS_DEFAULT_PROMPTS).map(([k, a]) => [k, a.map(md5)])),
//     };
//     (await import('fs')).writeFileSync('services/taskPromptDefaults/integrity.snapshot.json', JSON.stringify(out, null, 2) + '\n');
//   })"
//
// PORTOS_API_URL is interpolated into one prompt at module load and varies by
// env (PORTOS_HOST/PORT), so it's normalized to a placeholder before hashing.
const SNAPSHOT = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'taskPromptDefaults', 'integrity.snapshot.json'),
  'utf8',
));

const normalize = (s) => s.split(PORTOS_API_URL).join('{{PORTOS_API_URL}}');
const md5 = (s) => createHash('md5').update(normalize(s), 'utf8').digest('hex');

describe('taskPromptDefaults integrity snapshot', () => {
  it('DEFAULT_TASK_PROMPTS bodies match the snapshot hashes exactly', () => {
    const actual = Object.fromEntries(
      Object.entries(DEFAULT_TASK_PROMPTS).map(([k, v]) => [k, md5(v)]),
    );
    expect(actual).toEqual(SNAPSHOT.DEFAULT_TASK_PROMPTS);
  });

  it('PROMPT_VERSIONS matches the snapshot', () => {
    expect(PROMPT_VERSIONS).toEqual(SNAPSHOT.PROMPT_VERSIONS);
  });

  it('REFERENCE_WATCH_AUDITED_VERSION matches the snapshot', () => {
    expect(REFERENCE_WATCH_AUDITED_VERSION).toBe(SNAPSHOT.REFERENCE_WATCH_AUDITED_VERSION);
  });

  it('PREVIOUS_DEFAULT_PROMPTS bodies match the snapshot hashes exactly', () => {
    const actual = Object.fromEntries(
      Object.entries(PREVIOUS_DEFAULT_PROMPTS).map(([k, arr]) => [k, arr.map(md5)]),
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
});
