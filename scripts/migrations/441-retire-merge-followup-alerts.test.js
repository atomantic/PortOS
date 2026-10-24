import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import migration from './441-retire-merge-followup-alerts.js';

const TITLE = 'PR left open: its merge follow-up was blocked';
const NEXT_ACTION = 'Check the linked PR. If it is still open, fix the blocker and re-run the task or merge it manually.';
const notification = {
  id: 'alert', type: 'agent_warning', title: TITLE, read: false,
  metadata: { taskId: 'task', prUrl: 'https://github.com/example/repo/pull/1' },
};
const thread = {
  title: TITLE, nextAction: NEXT_ACTION, source: 'cos', status: 'open',
  refs: [{ kind: 'cos.task', id: 'task', label: TITLE }], notes: 'PR and blocker',
  updatedAt: '2099-01-01T00:00:00.000Z', originInstanceId: 'instance',
};

let rootDir;
const notificationPath = () => join(rootDir, 'data', 'notifications.json');
const threadPath = id => join(rootDir, 'data', 'brain', 'threads', id, 'index.json');
const readDocument = async path => JSON.parse(await readFile(path, 'utf8'));
async function writeThread(id, record) {
  await mkdir(join(rootDir, 'data', 'brain', 'threads', id), { recursive: true });
  await writeFile(threadPath(id), JSON.stringify(record));
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'portos-retire-pr-alerts-'));
  await mkdir(join(rootDir, 'data'));
});
afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

describe('retired merge follow-up reminders', () => {
  it('archives generated commitments and hides alerts without losing their context, idempotently', async () => {
    await writeFile(notificationPath(), JSON.stringify({ version: 1, notifications: [notification] }));
    await writeThread('generated', thread);
    expect(await migration.up({ rootDir })).toEqual({ notifications: 1, threads: 1 });
    expect((await readDocument(notificationPath())).notifications).toEqual([
      { ...notification, read: true, historyHidden: true },
    ]);
    const archived = await readDocument(threadPath('generated'));
    expect(archived).toEqual({
      ...thread, status: 'archived', closedAt: '2099-01-01T00:00:00.001Z', updatedAt: '2099-01-01T00:00:00.001Z',
    });
    expect(await migration.up({ rootDir })).toEqual({ notifications: 0, threads: 0 });
    expect(await readDocument(threadPath('generated'))).toEqual(archived);
  });

  it('preserves unrelated alerts, edited commitments, completed history, and tombstones', async () => {
    const other = { ...notification, title: 'A different warning' };
    await writeFile(notificationPath(), JSON.stringify({ notifications: [other] }));
    const preserved = {
      manual: { ...thread, source: 'manual' },
      edited: { ...thread, nextAction: 'Follow up with the contributor' },
      linked: { ...thread, refs: [...thread.refs, { kind: 'github.issue', id: 'another' }] },
      done: { ...thread, status: 'done', closedAt: '2026-10-01T00:00:00.000Z' },
      deleted: { ...thread, _deleted: true },
    };
    for (const [id, record] of Object.entries(preserved)) await writeThread(id, record);
    expect(await migration.up({ rootDir })).toEqual({ notifications: 0, threads: 0 });
    expect((await readDocument(notificationPath())).notifications).toEqual([other]);
    for (const [id, record] of Object.entries(preserved)) expect(await readDocument(threadPath(id))).toEqual(record);
  });

  it('accepts a fresh install but refuses corrupt stores without overwriting them', async () => {
    expect(await migration.up({ rootDir })).toEqual({ notifications: 0, threads: 0 });
    await writeFile(notificationPath(), '{broken');
    await expect(migration.up({ rootDir })).rejects.toThrow();
    expect(await readFile(notificationPath(), 'utf8')).toBe('{broken');
    await rm(notificationPath());
    await writeThread('broken', thread);
    await writeFile(threadPath('broken'), '{broken');
    await expect(migration.up({ rootDir })).rejects.toThrow();
    expect(await readFile(threadPath('broken'), 'utf8')).toBe('{broken');
  });
});
