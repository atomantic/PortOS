import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import * as fileUtils from '../../lib/fileUtils.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { createAgentSentinelAccess } from './agentSentinelWatcher.js';

const mockedExistsSync = vi.hoisted(() => vi.fn());
const realExistsSync = vi.hoisted(() => ({ current: null }));
const mockedWriteFile = vi.hoisted(() => vi.fn());
const realWriteFile = vi.hoisted(() => ({ current: null }));
vi.mock('fs', async importOriginal => {
  const original = await importOriginal();
  realExistsSync.current = original.existsSync;
  mockedExistsSync.mockImplementation(original.existsSync);
  return { ...original, existsSync: mockedExistsSync };
});
vi.mock('fs/promises', async importOriginal => {
  const original = await importOriginal();
  realWriteFile.current = original.writeFile;
  mockedWriteFile.mockImplementation((...args) => realWriteFile.current(...args));
  return { ...original, writeFile: mockedWriteFile };
});

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

      expect(await access.promote(contents)).toBe(true);
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
      let activeIds = [AGENT_ID, 'agent-ded2dcc'];
      const siblingAccess = createAgentSentinelAccess({
        workspacePath: workspace,
        agentId: AGENT_ID,
        startedAt: Date.now() - 1000,
        getActiveAgentIds: () => activeIds,
      });
      expect(siblingAccess.exists()).toBe(false);
      activeIds = [AGENT_ID];
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

  it('rechecks a fallback after a transient active-agent registry failure', async () => {
    const workspace = await makeWorkspace();
    try {
      let registryAvailable = false;
      const recoveredPath = join(workspace, '.agent-done-agent-ded2dcc');
      await writeFile(recoveredPath, 'done');
      const access = createAgentSentinelAccess({
        workspacePath: workspace,
        agentId: AGENT_ID,
        startedAt: Date.now() - 1000,
        getActiveAgentIds: () => {
          if (!registryAvailable) throw new Error('registry temporarily unavailable');
          return [AGENT_ID];
        },
      });

      expect(access.exists()).toBe(false);
      registryAvailable = true;
      expect(access.exists()).toBe(true);
      expect(access.resolvedPath()).toBe(recoveredPath);
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
      await access.cleanup();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('removes recovery data in cleanup only after successful promotion', async () => {
    const workspace = await makeWorkspace();
    try {
      const recoveredPath = join(workspace, '.agent-done-agent-ded2dcc');
      await writeFile(recoveredPath, 'completion');
      const access = createAgentSentinelAccess({ workspacePath: workspace, agentId: AGENT_ID,
        startedAt: Date.now() - 1000, getActiveAgentIds: () => [AGENT_ID] });
      expect(await access.cleanup()).toBe(false);
      expect(existsSync(recoveredPath)).toBe(true);
      expect(await access.promote('completion')).toBe(true);
      expect(await access.cleanup()).toBe(true);
      expect(existsSync(recoveredPath)).toBe(false);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });

  it('removes both canonical and accepted recovery paths explicitly', async () => {
    const workspace = await makeWorkspace();
    try {
      const canonicalPath = join(workspace, '.agent-done-agent-ded2dccb');
      const recoveredPath = join(workspace, '.agent-done-agent-ded2dcc');
      await writeFile(canonicalPath, 'canonical'); await writeFile(recoveredPath, 'recovery');
      const access = createAgentSentinelAccess({ workspacePath: workspace, agentId: AGENT_ID,
        startedAt: Date.now() - 1000, getActiveAgentIds: () => [AGENT_ID] });
      expect(access.resolvedPath()).toBe(canonicalPath);
      // Accepted fallback is removed only when this access has detected it.
      await rm(canonicalPath);
      expect(access.resolvedPath()).toBe(recoveredPath);
      await access.remove();
      expect(existsSync(canonicalPath)).toBe(false);
      expect(existsSync(recoveredPath)).toBe(false);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });

  it.each([
    ['canonical appeared in the race', true],
    ['canonical is still absent', false],
  ])('treats EEXIST as success only when %s', async (_label, canonicalAppears) => {
    const workspace = await makeWorkspace();
    try {
      const recoveredPath = join(workspace, '.agent-done-agent-ded2dcc');
      const canonicalPath = join(workspace, '.agent-done-agent-ded2dccb');
      await writeFile(recoveredPath, 'recovery');
      const access = createAgentSentinelAccess({ workspacePath: workspace, agentId: AGENT_ID,
        startedAt: Date.now() - 1000, getActiveAgentIds: () => [AGENT_ID] });
      expect(access.resolvedPath()).toBe(recoveredPath);
      mockedExistsSync.mockImplementation(path => {
        if (path !== canonicalPath) return realExistsSync.current(path);
        return canonicalAppears && mockedExistsSync.mock.calls.filter(([candidate]) => candidate === canonicalPath).length >= 3;
      });
      mockedWriteFile.mockRejectedValueOnce(Object.assign(new Error('already exists'), { code: 'EEXIST' }));
      expect(await access.promote('recovery')).toBe(canonicalAppears);
      if (canonicalAppears) {
        expect(await access.cleanup()).toBe(true);
        expect(existsSync(recoveredPath)).toBe(false);
      } else {
        expect(await access.cleanup()).toBe(false);
        expect(existsSync(recoveredPath)).toBe(true);
      }
      mockedExistsSync.mockImplementation(path => realExistsSync.current(path));
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });

  it('rejects reads when there is no workspace path', async () => {
    const access = createAgentSentinelAccess({ agentId: AGENT_ID });
    await expect(access.read()).rejects.toThrow('No workspace available for completion sentinel');
  });

  it('ignores a fallback watcher event when canonical resolution selects another path', async () => {
    const workspace = await makeWorkspace();
    try {
      const fallbackPath = join(workspace, '.agent-done-agent-ded2dcc');
      const canonicalPath = join(workspace, '.agent-done-agent-ded2dccb');
      await writeFile(fallbackPath, 'fallback'); await writeFile(canonicalPath, 'canonical');
      const access = createAgentSentinelAccess({ workspacePath: workspace, agentId: AGENT_ID,
        startedAt: Date.now() - 1000, getActiveAgentIds: () => [AGENT_ID] });
      const callback = vi.fn();
      vi.spyOn(fileUtils, 'watchForFile').mockImplementation((path, onDetected) => {
        if (path === fallbackPath) queueMicrotask(() => onDetected(path));
        return vi.fn();
      });
      const close = access.watch(callback);
      await new Promise(resolve => queueMicrotask(resolve));
      close?.();
      expect(callback).not.toHaveBeenCalled();
      expect(access.resolvedPath()).toBe(canonicalPath);
    } finally { vi.restoreAllMocks(); await rm(workspace, { recursive: true, force: true }); }
  });
});
