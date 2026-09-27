import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createAgentSentinelAccess } from './agentSentinelWatcher.js';

const AGENT_ID = 'agent-ded2dccb';

async function makeWorkspace() {
  return mkdtemp(join(tmpdir(), 'portos-sentinel-'));
}

describe('createAgentSentinelAccess', () => {
  it('accepts and promotes only a fresh one-character truncation', async () => {
    const workspace = await makeWorkspace();
    try {
      const access = createAgentSentinelAccess({
        workspacePath: workspace,
        agentId: AGENT_ID,
        startedAt: Date.now() - 1000,
        getActiveAgentIds: () => [AGENT_ID],
      });
      const recoveredPath = join(workspace, '.agent-done-agent-ded2dcc');
      const contents = '## Summary\nRecovered completion.';
      await writeFile(recoveredPath, contents);

      expect(access.exists()).toBe(true);
      expect(access.resolvedPath()).toBe(recoveredPath);
      expect(await access.read()).toBe(contents);

      await access.promote(contents);
      expect(await readFile(join(workspace, '.agent-done-agent-ded2dccb'), 'utf8')).toBe(contents);
      await access.cleanup();
      await expect(readFile(recoveredPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects a stale recovery file and a live sibling prefix collision', async () => {
    const workspace = await makeWorkspace();
    try {
      const recoveredPath = join(workspace, '.agent-done-agent-ded2dcc');
      await writeFile(recoveredPath, 'stale');
      const old = new Date(Date.now() - 60_000);
      await utimes(recoveredPath, old, old);

      const staleAccess = createAgentSentinelAccess({
        workspacePath: workspace,
        agentId: AGENT_ID,
        startedAt: Date.now() - 1000,
        getActiveAgentIds: () => [AGENT_ID],
      });
      expect(staleAccess.exists()).toBe(false);

      await writeFile(recoveredPath, 'sibling');
      const siblingAccess = createAgentSentinelAccess({
        workspacePath: workspace,
        agentId: AGENT_ID,
        startedAt: Date.now() - 1000,
        getActiveAgentIds: () => [AGENT_ID, 'agent-ded2dcc'],
      });
      expect(siblingAccess.exists()).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('revalidates a cached recovery path after it disappears', async () => {
    const workspace = await makeWorkspace();
    try {
      const recoveredPath = join(workspace, '.agent-done-agent-ded2dcc');
      const access = createAgentSentinelAccess({
        workspacePath: workspace,
        agentId: AGENT_ID,
        startedAt: Date.now() - 1000,
        getActiveAgentIds: () => [AGENT_ID],
      });
      await writeFile(recoveredPath, 'first');
      expect(access.resolvedPath()).toBe(recoveredPath);

      await rm(recoveredPath);
      expect(access.exists()).toBe(false);
      expect(access.resolvedPath()).toBeNull();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('watches for a recovery file written after the run starts', async () => {
    const workspace = await makeWorkspace();
    try {
      const access = createAgentSentinelAccess({
        workspacePath: workspace,
        agentId: AGENT_ID,
        startedAt: Date.now() - 1000,
        getActiveAgentIds: () => [AGENT_ID],
      });
      const detected = new Promise((resolve) => access.watch(resolve, { settleMs: 0, pollMs: 10 }));
      await writeFile(join(workspace, '.agent-done-agent-ded2dcc'), 'done');
      await expect(Promise.race([
        detected,
        new Promise((_, reject) => setTimeout(() => reject(new Error('sentinel was not detected')), 1000)),
      ])).resolves.toBe(join(workspace, '.agent-done-agent-ded2dcc'));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
