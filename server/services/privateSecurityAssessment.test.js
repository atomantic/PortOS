import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { collectSecuritySnapshot, preparePrivateSecurityAssessment, processTaskOutput } from './privateSecurityAssessment.js';

let repo;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'portos-assessment-test-'));
  await execGit(['init'], repo);
});
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });
const commit = () => execGit(['-c', 'user.name=Example', '-c', 'user.email=example@example.com', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Synthetic fixture'], repo);

describe('private assessment workflow', () => {
  it('reads immutable committed blobs, excludes secrets/symlinks, and reports omitted coverage', async () => {
    await mkdir(join(repo, 'data'));
    await writeFile(join(repo, 'auth.js'), 'export const authorized = false;\n');
    await writeFile(join(repo, '.env'), 'PRIVATE=value');
    await writeFile(join(repo, 'data', 'record.json'), '{"private":true}');
    await symlink(join(repo, '.env'), join(repo, 'escape.js'));
    await execGit(['add', '.'], repo);
    await commit();
    await writeFile(join(repo, 'auth.js'), 'uncommitted personal content');
    const snapshot = await collectSecuritySnapshot(repo);
    expect(snapshot.files).toEqual([{ file: 'auth.js', content: 'export const authorized = false;\n', lines: 2 }]);
    expect(snapshot.scope.omittedFiles).toBe(3);
    expect(snapshot.scope.limitations).toContain('submodules');
    const task = { metadata: { app: 'example' } };
    const prompt = await preparePrivateSecurityAssessment(task, { id: 'claude-ollama', ollamaBacked: true }, 'example-local', {
      apps: { getAppById: async () => ({ repoPath: repo }) },
      fetch: async () => ({ ok: true, json: async () => ({ model_info: { architecture: 'example' } }) }),
    });
    expect(prompt).toContain('export const authorized = false');
    expect(prompt).not.toContain('uncommitted personal content');
    expect(task.metadata).toEqual({ app: 'example' });
    expect(task.privateSecurityScope).toMatchObject({ commit: snapshot.commit, model: 'example-local' });
  });

  it('refuses a cloud-proxy model before gathering any source', async () => {
    const apps = { getAppById: vi.fn() };
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ remote_host: 'https://example.com', model_info: {} }) });
    await expect(preparePrivateSecurityAssessment({ metadata: { app: 'example' } },
      { id: 'claude-ollama', ollamaBacked: true }, 'example', { fetch, apps })).rejects.toThrow('not verifiably installed locally');
    expect(apps.getAppById).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0][1].redirect).toBe('error');
  });

  it('returns only a private report with validated evidence and escaped model prose', async () => {
    const review = { createItem: vi.fn().mockResolvedValue({ id: 'report' }) };
    const task = { metadata: { app: 'example' }, privateSecurityScope: {
      commit: 'a'.repeat(40), files: [{ file: 'auth.js', lines: 2 }], omittedFiles: 3, limitations: 'Static subset',
    } };
    const payload = { summary: '![tracking](https://example.com/image) <img src="https://example.com/image"> `code` *bold* _emphasis_', limitations: 'Needs review', findings: [{
      title: 'Missing authorization', severity: 'high', confidence: 'medium', file: 'auth.js', line: 1,
      evidence: 'An untrusted caller reaches this route.', remediation: 'Check authorization before access.', verification: 'Add a forbidden-user route test.',
    }] };
    expect(await processTaskOutput({ success: true, task, payload, agentId: 'agent-test' }, { review })).toMatchObject({ success: true, findings: 1 });
    expect(review.createItem.mock.calls[0][0]).toMatchObject({ metadata: { privateSecurity: true } });
    expect(review.createItem.mock.calls[0][0].description).toContain('\\[tracking\\]');
    expect(review.createItem.mock.calls[0][0].description).toContain('\\<img src="https://example.com/image"\\> \\`code\\` \\*bold\\* \\_emphasis\\_');
    review.createItem.mockClear();
    payload.findings[0].file = '../outside.js';
    expect(await processTaskOutput({ success: true, task, payload, agentId: 'agent-test' }, { review })).toMatchObject({ success: false });
    expect(review.createItem).not.toHaveBeenCalled();
  });
});
