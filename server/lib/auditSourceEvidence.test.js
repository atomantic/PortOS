import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execGit } from './execGit.js';
import { captureAuditSourceEvidence } from './auditSourceEvidence.js';
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function repository() {
  const path = await mkdtemp(join(tmpdir(), 'audit-source-'));
  roots.push(path);
  await execGit(['init'], path);
  await execGit(['config', 'user.name', 'Fixture'], path);
  await execGit(['config', 'user.email', 'fixture@example.test'], path);
  await writeFile(join(path, 'private\nname.txt'), 'first');
  await execGit(['add', '.'], path);
  await execGit(['commit', '-m', 'fixture'], path);
  return path;
}
it('records immutable committed inventory, distinguishes dirty workspaces and does not invent evidence for missing repositories', async () => {
  const path = await repository();
  const first = await captureAuditSourceEvidence(path);
  expect(first).toMatchObject({ status: 'captured', trackedEntryCount: 1, workingTreeState: 'clean' });
  await writeFile(join(path, 'private\nname.txt'), 'edited');
  await writeFile(join(path, 'untracked.txt'), 'not in commit');
  const dirty = await captureAuditSourceEvidence(path);
  expect(dirty).toMatchObject({ revision: first.revision, inventorySha256: first.inventorySha256, trackedEntryCount: 1, workingTreeState: 'modified' });
  expect(JSON.stringify(dirty)).not.toContain('private');
  await execGit(['add', '.'], path);
  await execGit(['commit', '-m', 'second fixture'], path);
  const second = await captureAuditSourceEvidence(path);
  expect(second.revision).not.toBe(first.revision);
  expect(second.inventorySha256).not.toBe(first.inventorySha256);
  expect(second.trackedEntryCount).toBe(2);
  const unavailable = await captureAuditSourceEvidence(join(path, 'missing'));
  expect(unavailable).toMatchObject({ status: 'unavailable' });
  expect(unavailable).not.toHaveProperty('trackedEntryCount');
});
it('pins the inventory to the initial SHA when real HEAD moves mid-capture', async () => {
  const path = await repository();
  const original = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
  let reads = 0;
  const runGit = async (args, cwd, options) => {
    const result = await execGit(args, cwd, options);
    if (args[0] === 'rev-parse' && ++reads === 1) {
      await writeFile(join(path, 'new.txt'), 'later');
      await execGit(['add', '.'], path);
      await execGit(['commit', '-m', 'concurrent commit'], path);
    }
    return result;
  };
  expect(await captureAuditSourceEvidence(path, { runGit })).toMatchObject({ revision: original, trackedEntryCount: 1, workingTreeState: 'unknown' });
});
it('makes synthetic races and command failure explicit without leaking diagnostics', async () => {
  const original = 'a'.repeat(40);
  const runGit = vi.fn().mockResolvedValueOnce({ stdout: original }).mockResolvedValueOnce({ stdout: '100644 blob abc\tfile\n' }).mockRejectedValueOnce(new Error('private status path')).mockResolvedValueOnce({ stdout: 'b'.repeat(40) });
  const evidence = await captureAuditSourceEvidence('/synthetic', { runGit });
  expect(runGit.mock.calls[1][0]).toEqual(['-c', 'core.quotePath=true', 'ls-tree', '-r', '--full-tree', original]);
  expect(evidence).toMatchObject({ revision: original, workingTreeState: 'unknown' });
  expect(JSON.stringify(evidence)).not.toContain('private');
  expect(await captureAuditSourceEvidence('/synthetic', { runGit: vi.fn().mockRejectedValue(new Error('private')) })).toMatchObject({ status: 'unavailable' });
});
