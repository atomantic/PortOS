import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('os', async (importOriginal) => ({ ...await importOriginal(), homedir: () => '/nonexistent-test-home' }));
vi.mock('./cosTaskStore.js', () => ({ addTask: vi.fn() }));
vi.mock('./memoryRetriever.js', () => ({ getMemorySection: vi.fn().mockResolvedValue(null) }));
vi.mock('./digital-twin.js', () => ({ getDigitalTwinForPrompt: vi.fn().mockResolvedValue(null) }));
vi.mock('./tools.js', () => ({ getToolsSummaryForPrompt: vi.fn().mockResolvedValue('') }));
vi.mock('./codeReview.js', () => ({ getCodeReviewDefaults: vi.fn().mockResolvedValue({ reviewers: [] }) }));

import { addTask } from './cosTaskStore.js';
import { buildQueuedTask } from './cosTaskIntake.js';
import { queueSecurityFixTask } from './githubSecurityFixTask.js';
import { queueNotificationResolveTask } from './githubNotificationResolveTask.js';
import { buildAgentPrompt, buildLightContextPrompt } from './agentPromptBuilder.js';

const account = { id: 'example-account', host: 'github.com', login: 'example-owner' };
const repo = 'example-owner/example-tool';
const row = {
  thread_id: '4242', repo_full_name: repo, subject_type: 'PullRequest', reason: 'author', trust: 'yours',
  subject_api_url: `https://api.github.com/repos/${repo}/pulls/7`,
};

// Keep the real producer -> intake -> prompt boundary; only persistence and
// optional personal context are doubled. No GitHub or provider requests run.
async function queued(producer) {
  await producer();
  const [input, type] = vi.mocked(addTask).mock.lastCall;
  return buildQueuedTask(input, type);
}

const compose = {
  light: task => buildLightContextPrompt(task, '/example-portos', null, { providerId: 'codex', agentId: 'example-agent' }),
  full: task => buildAgentPrompt(task, {}, '/example-portos', null, { providerType: 'api', agentId: 'example-agent' }),
};

function assertExternalContract(prompt) {
  expect(prompt).toContain('## Completion (External Repository)');
  expect(prompt).toContain('You may edit code, commit, push and open a PR there only as the task directs');
  expect(prompt).toContain('Never edit, commit, push or open a PR from the PortOS checkout');
  expect(prompt).toContain('PortOS will not publish or merge this work for you');
  expect(prompt).not.toContain('## Completion (No Code Output)');
  expect(prompt).not.toContain('do NOT run `/do:push`');
  expect(prompt).not.toContain('commit directly to the current branch');
  expect(prompt).not.toContain('## Simplify Step');
}

beforeEach(() => vi.mocked(addTask).mockReset().mockResolvedValue({ id: 'task-example' }));

for (const [path, render] of Object.entries(compose)) {
  describe(`${path} external repository completion`, () => {
    it.each([
      ['repository security alerts', () => queueSecurityFixTask({ account, repo })],
      ['global advisory security alerts', () => queueSecurityFixTask({ account, advisories: ['GHSA-8r9p-f939-6h3c'] })],
      ['enterprise global advisories', () => queueSecurityFixTask({ account: { ...account, host: 'ghe.example.com' }, advisories: ['GHSA-8r9p-f939-6h3c'] })],
    ])('keeps %s deliverable in the external clone, including a verified no-op', async (_name, producer) => {
      const task = await queued(producer);
      expect(task.metadata).toMatchObject({ useWorktree: false, openPR: false, worktreeChangesExpected: false, externalRepositoryOutput: true });
      expect(task.metadata.noCodeOutput).toBeUndefined();
      const prompt = await render(task);
      assertExternalContract(prompt);
      expect(prompt).toContain('Otherwise update each vulnerable dependency');
      expect(prompt).toContain('verified no-action result (such as zero open alerts) needs no commit or PR');
      expect(prompt).toContain('absence of an existing bot PR does not block creating an authorized fix PR');
      expect(prompt).toContain('When they pass, squash-merge');
      if (task.metadata.githubSecurityFix.host !== 'github.com') expect(prompt).toContain('gh repo clone ghe.example.com/<repo>');
      if (path === 'light') expect(prompt).toContain('.agent-done-example-agent');
    });

    it.each([
      ['own PR', row],
      ['CI', { ...row, reason: 'ci_activity', subject_type: 'CheckSuite', subject_api_url: null }],
      ['issue', { ...row, subject_type: 'Issue', subject_api_url: `https://api.github.com/repos/${repo}/issues/7` }],
    ])('preserves the notification %s code workflow and its no-merge restriction', async (_name, notification) => {
      const task = await queued(() => queueNotificationResolveTask({ account, row: notification }));
      const prompt = await render(task);
      assertExternalContract(prompt);
      expect(prompt).toContain('never merge a pull request');
      expect(prompt).toContain('Push only to branches you create in this run');
    });

    it.each([
      ['read-only', { readOnly: 'true' }],
      ['discard', { discardWorktree: 'true' }],
      ['sandboxed actions', { executionProfile: 'public-review-actions' }],
      ['tool-free review', { executionProfile: 'public-review-gate' }],
    ])('does not let an external marker bypass %s restrictions', async (_name, restrictions) => {
      const task = await queued(() => queueSecurityFixTask({ account, repo }));
      Object.assign(task.metadata, restrictions);
      expect(await render(task)).not.toContain('## Completion (External Repository)');
    });

    it.each([
      ['review', { ...row, reason: 'review_requested', trust: 'trusted' }],
      ['release', { ...row, subject_type: 'Release', reason: 'subscribed' }],
      ['unknown subject', { ...row, subject_type: 'UnknownSubject', reason: 'subscribed' }],
    ])('retains no-code restrictions for a notification %s', async (_name, notification) => {
      const prompt = await render(await queued(() => queueNotificationResolveTask({ account, row: notification })));
      expect(prompt).toContain('## Completion (No Code Output)');
      expect(prompt).toContain('`git commit`, `git push`, or open a pull request');
      expect(prompt).not.toContain('## Completion (External Repository)');
    });

    it.each([
      ['security', () => queueSecurityFixTask({ account, repo })],
      ['notification', () => queueNotificationResolveTask({ account, row })],
    ])('recognizes queued legacy %s flags and JSON-string provenance without broadening API-only work', async (_name, producer) => {
      const task = await queued(producer);
      delete task.metadata.externalRepositoryOutput;
      task.metadata.noCodeOutput = true;
      task.metadata.simplify = true;
      task.metadata = Object.fromEntries(Object.entries(task.metadata).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
      assertExternalContract(await render(task));
      delete task.metadata.githubSecurityFix;
      delete task.metadata.githubNotificationResolve;
      task.description = 'File a tracker issue using the API';
      const apiPrompt = await render(task);
      expect(apiPrompt).toContain('## Completion (No Code Output)');
      expect(apiPrompt).not.toContain('## Simplify Step');
      expect(apiPrompt).not.toContain('## Completion (External Repository)');
    });

    it.each([
      ['non-own PR', { ...row, reason: 'mention', trust: 'trusted' }, false],
      ['CI', { ...row, reason: 'ci_activity', subject_type: 'CheckSuite', subject_api_url: null }, true],
      ['issue', { ...row, subject_type: 'Issue', subject_api_url: `https://api.github.com/repos/${repo}/issues/7` }, true],
    ])('keeps legacy %s delivery scoped when provenance lacks a resolved kind', async (_name, notification, external) => {
      const task = await queued(() => queueNotificationResolveTask({ account, row: notification }));
      delete task.metadata.externalRepositoryOutput;
      delete task.metadata.githubNotificationResolve.kind;
      task.metadata.githubNotificationResolve = JSON.stringify(task.metadata.githubNotificationResolve);
      const prompt = await render(task);
      if (external) {
        assertExternalContract(prompt);
        return;
      }
      expect(prompt).toContain('Change nothing on GitHub');
      expect(prompt).toContain('## Completion (No Code Output)');
      expect(prompt).not.toContain('## Completion (External Repository)');
    });
  });
}
