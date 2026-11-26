import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TASK_PROMPTS, getDefaultPrompt } from '../taskPromptService.js';
import { composeClaimIssuePrompt, getDefaultTaskPrompt } from './prompts.js';

describe('scheduled task prompt catalog', () => {
  it('loads a single requested domain after importing the public prompt service and listing its keys', () => {
    // A fresh Node process observes real module loads, including eager ESM imports.
    const observed = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { registerHooks } from 'node:module';
      const loaded = [];
      registerHooks({ load(url, context, next) {
        if (url.includes('/taskPromptDefaults/catalog/')) loaded.push(url.split('/').pop());
        return next(url, context);
      } });
      const { DEFAULT_TASK_PROMPTS, getDefaultPrompt } = await import('./taskPromptService.js');
      Object.keys(DEFAULT_TASK_PROMPTS);
      const before = loaded.slice();
      const body = getDefaultPrompt('security');
      console.log(JSON.stringify({ before, loaded, matched: body === DEFAULT_TASK_PROMPTS.security }));
    `], { cwd: new URL('../', import.meta.url), encoding: 'utf8' });
    expect(JSON.parse(observed.trim().split('\n').at(-1))).toEqual({
      before: [], loaded: ['security.js'], matched: true,
    });
  });

  it('exposes every domain entry exactly once through synchronous lookup and enumeration', () => {
    const catalogs = Object.values(import.meta.glob('./catalog/*.js', { eager: true }));
    const entries = catalogs.flatMap(({ prompts }) => Object.entries(prompts ?? {}));
    expect(entries.map(([key]) => key).sort()).toEqual(Object.keys(DEFAULT_TASK_PROMPTS).sort());
    for (const [key, value] of entries) expect(getDefaultPrompt(key), key).toBe(value);
    expect(getDefaultPrompt('missing-task')).toBeNull();
  });

  it('keeps Jira ticket handoff when a forge completion mode requests a merge', () => {
    const jira = composeClaimIssuePrompt({ forge: 'jira', prCompletion: 'merge-on-green' });
    expect(jira).toBe(getDefaultTaskPrompt('claim-issue-jira'));
    expect(jira).toContain('move the ticket to **In Review**');
    expect(jira).toContain('Leave the MR/PR open for a human to land');
    // A published but review-blocked change still needs its Jira status and link.
    const publish = jira.indexOf('gh pr create');
    const hold = jira.indexOf('REVIEW_STATUS=review-blocked', publish);
    const transition = jira.indexOf('POST JIRA/tickets/<KEY>/transition', hold);
    const link = jira.indexOf('POST JIRA/tickets/<KEY>/comments', transition);
    const handoff = jira.indexOf('Leave the MR/PR open for a human to land', link);
    expect(publish).toBeGreaterThan(jira.indexOf('Run each LOCAL reviewer'));
    expect(hold).toBeGreaterThan(publish);
    expect(transition).toBeGreaterThan(hold);
    expect(link).toBeGreaterThan(transition);
    expect(handoff).toBeGreaterThan(link);
  });

  it('requires successful exact-head validation before publishing claims', () => {
    for (const forge of ['github', 'gitlab']) {
      const prompt = composeClaimIssuePrompt({ forge });
      const validation = prompt.indexOf('Before pushing, validate final HEAD per repo docs');
      const push = prompt.indexOf('Push `claim/issue-${NUM}`');

      expect(validation, forge).toBeGreaterThan(-1);
      expect(push, forge).toBeGreaterThan(validation);
      expect(prompt).toContain('npm run pregate && git push origin claim/issue-${NUM}');
      expect(prompt).toContain('On failure or changed HEAD, rerun');
      expect(prompt).toContain('Other repos follow own docs');
    }
  });
});
