import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const disk = vi.hoisted(() => {
  const { mkdtempSync } = require('fs');
  const { tmpdir } = require('os');
  const { join } = require('path');
  return { root: mkdtempSync(join(tmpdir(), 'strict-read-store-safety-')), fault: null };
});
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFile: (...args) => {
      if (args[0] === disk.fault) return Promise.reject(Object.assign(new Error('injected read fault'), { code: 'EACCES' }));
      return actual.readFile(...args);
    }
  };
});
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  const proxy = makePathsProxy(actual, { dataRoot: disk.root, extraOverrides: {
    root: disk.root,
    agentPersonalities: join(disk.root, 'agents'),
    digitalTwin: join(disk.root, 'digital-twin'),
    messages: join(disk.root, 'messages')
  } });
  return new Proxy(proxy, {
    get: (target, prop) => (prop === 'dataPath' ? (...segments) => join(disk.root, ...segments) : target[prop])
  });
});
vi.mock('./pm2.js', () => ({ execPm2: vi.fn(), listProcessesStrict: vi.fn() }));
vi.mock('./digital-twin.js', () => ({ digitalTwinEvents: { emit: vi.fn(), on: vi.fn() } }));
vi.mock('./humanActivity.js', () => ({ deleteEvents: vi.fn(async () => ({ deleted: 0 })), listConversations: vi.fn(), sourceStats: vi.fn() }));
vi.mock('./imessageSync.js', () => ({ getStatus: vi.fn() }));
vi.mock('./promptService.js', () => ({ getStageTemplate: vi.fn() }));
vi.mock('./memoryBackend.js', () => ({ getMemories: vi.fn() }));
vi.mock('./browserService.js', () => ({
  findOrOpenPage: vi.fn(), listCdpPages: vi.fn(), isAuthPage: vi.fn(), evaluateOnPage: vi.fn()
}));

const cases = [
  {
    name: 'agent drafts', path: 'agents/drafts/agent-1.json',
    load: () => import('./agentDrafts.js'),
    mutate: svc => svc.createDraft('agent-1', { type: 'post', content: 'New draft' }),
    seed: [{ id: 'keep', type: 'post', content: 'Existing draft', createdAt: '2026-01-01T00:00:00.000Z' }],
    kept: data => data.some(draft => draft.id === 'keep')
  },
  {
    name: 'browser config', path: 'browser-config.json',
    load: () => import('./browserService.js').then(() => vi.importActual('./browserService.js')),
    mutate: svc => svc.updateConfig({ autoConnect: false }),
    seed: { cdpHost: 'keep.example.com' },
    kept: data => data.cdpHost === 'keep.example.com'
  },
  {
    name: 'digital twin feedback', path: 'digital-twin/feedback.json',
    load: () => import('./feedbackLoop.js'),
    mutate: svc => svc.submitFeedback({ contentType: 'test_response', validation: 'sounds_like_me', contentSnippet: 'New' }),
    seed: { version: '1.0.0', entries: [{ id: 'keep', validation: 'not_quite' }], stats: { totalFeedback: 1, soundsLikeMe: 0, doesntSoundLikeMe: 0 }, documentWeightAdjustments: {}, lastCalculatedAt: null },
    kept: data => data.entries.some(entry => entry.id === 'keep')
  },
  {
    name: 'iMessage blocklist', path: 'imessage-blocklist.json',
    load: () => import('./imessageManage.js'),
    mutate: svc => svc.addToBlocklist(['new@example.com']),
    seed: { handles: ['keep@example.com'], updatedAt: '2026-01-01T00:00:00.000Z' },
    kept: data => data.handles.includes('keep@example.com')
  },
  {
    name: 'memory classifier config', path: 'memory-classifier-config.json',
    load: () => import('./memoryClassifier.js'),
    mutate: svc => svc.updateConfig({ minConfidence: 0.5 }),
    seed: { keepMarker: 'user-value' },
    kept: data => data.keepMarker === 'user-value'
  },
  {
    name: 'message selectors', path: 'messages/selectors.json',
    load: () => import('./messagePlaywrightSync.js'),
    mutate: svc => svc.updateSelectors('teams', { messageRow: '.new' }),
    seed: { outlook: { messageRow: '.keep' } },
    kept: data => data.outlook.messageRow === '.keep'
  }
];

afterEach(() => { disk.fault = null; });
afterAll(() => rm(disk.root, { recursive: true, force: true }));

describe('tolerant-read stores refuse to write defaults over unreadable bytes', () => {
  for (const boundary of cases) {
    it(`${boundary.name} preserves unreadable bytes, accepts the repaired file, and initializes when absent`, async () => {
      const svc = await boundary.load();
      const path = join(disk.root, boundary.path);
      await mkdir(dirname(path), { recursive: true });
      for (const bytes of ['{truncated', '', JSON.stringify(boundary.seed)]) {
        await writeFile(path, bytes);
        disk.fault = bytes.startsWith('{truncated') || bytes === '' ? null : path;
        await expect(boundary.mutate(svc)).rejects.toThrow(/Unreadable JSON file/);
        disk.fault = null;
        expect(await readFile(path, 'utf8')).toBe(bytes);
      }
      await writeFile(path, JSON.stringify(boundary.seed));
      await boundary.mutate(svc);
      expect(boundary.kept(JSON.parse(await readFile(path, 'utf8')))).toBe(true);
      await rm(path);
      await expect(boundary.mutate(svc)).resolves.not.toThrow();
    });
  }
});
