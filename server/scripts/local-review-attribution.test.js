import { it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile, spawn } from '../lib/childProcess.js';
import { buildPrAttributionSection } from '../services/promptSections/prAttribution.js';
import { buildLocalReviewLoopSection } from '../services/promptSections/reviewLifecycle.js';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('./local-review-attribution.mjs', import.meta.url));

it('publishes only completed CLI models, dedupes provider variants, and leaves requested forge users unattributed', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'review-attribution-'));
  const run = async (...args) => JSON.parse((await exec(process.execPath, [script, ...args], { cwd })).stdout || 'null');
  const record = result => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, 'record-cli'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error('attribution recorder failed')));
    child.stdin.end(JSON.stringify(result));
  });
  try {
    await exec('git', ['init', '--quiet'], { cwd });
    // No local review, including a configured/pinned or requested reviewer.
    expect((await run('labels')).labels).toEqual([]);
    await run('reset');
    await record({ ok: false, model: 'configured-but-failed', error: 'failed to start' });
    await record({ ok: true, model: 'no-verdict' });
    await record({ ok: true, verdict: 'clean', findings: 'NO FINDINGS', backend: 'provider:example-unresolved' });
    for (const model of ['C:\\private-models\\model.gguf', '/example-private/models/model.gguf', 'https://example.com/private/model', 'provider:example-account']) {
      await record({ ok: true, verdict: 'clean', findings: 'NO FINDINGS', model });
    }
    expect((await run('labels')).labels).toEqual([]);
    await record({ ok: true, verdict: 'clean', findings: 'NO FINDINGS', model: 'anthropic/claude-opus-5-20251001' });
    await record({ ok: true, verdict: 'findings', findings: 'Private findings never persisted', model: 'claude-opus-5' });
    await record({ ok: true, verdict: 'clean', findings: 'NO FINDINGS', model: 'gpt-5.6-sol', backend: 'provider:private-account' });
    expect(await readFile(join(cwd, '.git/portos-local-review-models'), 'utf8')).toBe('opus-5\nopus-5\ngpt-5-6-sol\n');
    for (const cli of ['gh', 'glab']) {
      const result = await run('labels', cli);
      expect(result.labels).toEqual(['reviewer:opus-5', 'reviewer:gpt-5-6-sol']);
      expect(result.createCommands).toHaveLength(2);
      expect(result.createCommands.every(command => command.startsWith(`${cli} label create`))).toBe(true);
      const prompt = buildPrAttributionSection({ model: 'claude-opus-5', forgeCli: cli });
      expect(prompt).toContain('apply/verify additive');
      expect(prompt).toContain('Preserve existing labels');
      expect(prompt).toContain('requested forge users');
    }
    await run('reset');
    expect((await run('labels')).labels).toEqual([]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('wires receipts into required and optional pre-PR review execution, excluding forge-only rosters', async () => {
  const policy = { reviewers: ['provider:example', 'codex'], forgeReviewerUsernames: ['external-user'], optionalReviewers: ['provider:example'], reviewerModels: { codex: 'configured-model' }, reviewerEfforts: {}, reviewerMaxRounds: {}, reviewStopMode: 'all' };
  const section = buildLocalReviewLoopSection({ taskId: 'example-task', branchName: 'example', baseBranch: 'main', reviewPolicy: policy });
  expect(section).toContain('"recordAttribution":true');
  const guide = await readFile(fileURLToPath(new URL('../../docs/PR_REVIEW_ATTRIBUTION.md', import.meta.url)), 'utf8');
  expect(guide).toContain('Record required and optional completed reviews alike');
  expect(buildPrAttributionSection()).toContain('PR_REVIEW_ATTRIBUTION.md');
  expect(guide).toContain('failed-start, unavailable, malformed and no-verdict attempts add nothing');
  const pinnedLocal = buildLocalReviewLoopSection({ branchName: 'example', baseBranch: 'main', reviewPolicy: { ...policy, reviewers: ['ollama'], reviewerModels: { ollama: 'example-model' } } });
  // Both the runnable request and the pin-override example retain the receipt flag.
  expect(pinnedLocal.match(/recordAttribution: true/g)).toHaveLength(2);
  expect(buildLocalReviewLoopSection({ reviewPolicy: { ...policy, reviewers: [] } })).toBe('');
});
